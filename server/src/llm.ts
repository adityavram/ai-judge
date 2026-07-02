const LLM_BASE = process.env.LLM_BASE ?? 'https://ollama.com'
const LLM_API_KEY = process.env.LLM_API_KEY ?? ''
const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-oss:120b'

const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 5000
const REQUEST_TIMEOUT_MS = 180000

export class LlmError extends Error {
  kind: 'rate_limit' | 'token_exhausted' | 'timeout' | 'config' | 'network' | 'unknown'
  statusCode: number

  constructor(
    message: string,
    kind: 'rate_limit' | 'token_exhausted' | 'timeout' | 'config' | 'network' | 'unknown',
    statusCode: number = 500,
  ) {
    super(message)
    this.kind = kind
    this.statusCode = statusCode
  }
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmChatOptions {
  model?: string
  messages: LlmMessage[]
  format?: 'json'
  temperature?: number
  maxTokens?: number
  label?: string
}

export interface LlmChatResponse {
  model: string
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractRetryDelay(text: string): number {
  const match = text.match(/try again in ([\d.]+)s/i)
  if (match) return Math.ceil(parseFloat(match[1]) * 1000)
  return 0
}

function classifyError(status: number, text: string): LlmError {
  if (status === 401 || status === 403) {
    return new LlmError('LLM API key is invalid or not authorized', 'config', 503)
  }
  if (status === 429) {
    // Distinguish between per-minute rate limit (retryable) and daily/token limit (not retryable)
    const isDaily = /per day|TPD|daily/i.test(text)
    const isToken = /tokens per day|TPD/i.test(text)
    if (isDaily || isToken) {
      return new LlmError(
        'AI provider daily token limit reached. The service will be available again tomorrow.',
        'token_exhausted',
        503,
      )
    }
    return new LlmError(`Rate limited by AI provider: ${text.slice(0, 200)}`, 'rate_limit', 503)
  }
  if (status >= 500) {
    return new LlmError(`AI provider is unavailable (HTTP ${status})`, 'network', 503)
  }
  return new LlmError(`LLM API error ${status}: ${text.slice(0, 500)}`, 'unknown', 500)
}

async function fetchWithTimeout(url: string, body: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body,
      signal: controller.signal,
    })
    return res
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new LlmError('LLM request timed out', 'timeout', 504)
    }
    throw new LlmError(`Network error reaching AI provider: ${err instanceof Error ? err.message : 'unknown'}`, 'network', 503)
  } finally {
    clearTimeout(timeout)
  }
}

export async function llmChat(opts: LlmChatOptions): Promise<LlmChatResponse> {
  if (!LLM_API_KEY) {
    throw new LlmError('No LLM API key configured. Set LLM_API_KEY environment variable.', 'config', 503)
  }

  const body: Record<string, unknown> = {
    model: opts.model ?? LLM_MODEL,
    messages: opts.messages,
    stream: false,
  }

  if (opts.format === 'json') {
    body.format = 'json'
  }
  if (opts.temperature !== undefined) {
    body.options = { temperature: opts.temperature }
  }
  if (opts.maxTokens) {
    body.options = { ...(body.options as Record<string, unknown>), num_predict: opts.maxTokens }
  }

  const label = opts.label ?? 'unlabeled'
  let lastError: LlmError | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startMs = Date.now()
    try {
      const res = await fetchWithTimeout(`${LLM_BASE}/api/chat`, JSON.stringify(body), REQUEST_TIMEOUT_MS)
      const fetchMs = Date.now() - startMs

      if (res.ok) {
        const data = await res.json() as {
          model: string
          message: { content: string }
          prompt_eval_count?: number
          eval_count?: number
        }
        const totalMs = Date.now() - startMs
        const tokens = data.prompt_eval_count !== undefined
          ? `${data.prompt_eval_count}+${data.eval_count ?? 0} tokens`
          : 'unknown tokens'
        console.log(`[llm] ${label}: ${totalMs}ms (fetch ${fetchMs}ms, ${tokens}, model=${data.model})`)
        return {
          model: data.model,
          content: data.message.content,
          usage: data.prompt_eval_count !== undefined
            ? {
                promptTokens: data.prompt_eval_count,
                completionTokens: data.eval_count ?? 0,
                totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
              }
            : undefined,
        }
      }

      const text = await res.text().catch(() => 'unknown')
      const error = classifyError(res.status, text)

      // Don't retry on token exhaustion or config errors
      if (error.kind === 'token_exhausted' || error.kind === 'config') {
        throw error
      }

      // Retry on rate limit (per-minute) with backoff
      if (error.kind === 'rate_limit' && attempt < MAX_RETRIES) {
        const apiDelay = extractRetryDelay(text)
        const backoff = apiDelay || INITIAL_BACKOFF_MS * Math.pow(2, attempt)
        console.warn(`[llm] 429 rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), waiting ${backoff}ms`)
        lastError = error
        await sleep(backoff)
        continue
      }

      // Retry on network/timeout errors
      if ((error.kind === 'network' || error.kind === 'timeout') && attempt < MAX_RETRIES) {
        console.warn(`[llm] ${error.kind} (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying...`)
        lastError = error
        await sleep(INITIAL_BACKOFF_MS * attempt)
        continue
      }

      throw error
    } catch (err) {
      if (err instanceof LlmError) {
        if (err.kind === 'token_exhausted' || err.kind === 'config') throw err
        lastError = err
        if (attempt < MAX_RETRIES && (err.kind === 'rate_limit' || err.kind === 'network' || err.kind === 'timeout')) {
          continue
        }
        throw err
      }
      lastError = new LlmError(`Unexpected error: ${err instanceof Error ? err.message : 'unknown'}`, 'unknown', 500)
      if (attempt < MAX_RETRIES) continue
      throw lastError
    }
  }

  throw lastError ?? new LlmError('LLM API failed after all retries', 'unknown', 502)
}

export function llmErrorToResponse(err: LlmError): { error: string; detail: string } {
  const userMessages: Record<LlmError['kind'], string> = {
    rate_limit: 'The AI provider is busy. Please try again in a moment.',
    token_exhausted: 'The daily AI usage limit has been reached. Please try again tomorrow.',
    timeout: 'The AI provider took too long to respond. Please try again.',
    config: 'The server is not properly configured. Please contact the administrator.',
    network: 'Could not reach the AI provider. Please try again.',
    unknown: 'An unexpected error occurred while processing the round.',
  }
  return {
    error: userMessages[err.kind],
    detail: err.message,
  }
}

export function extractJSON(text: string): string {
  // Strip markdown code fences
  let cleaned = text.trim()
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/)
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim()
  }

  // If it already parses, return as-is
  try {
    JSON.parse(cleaned)
    return cleaned
  } catch {}

  // Try to find the outermost JSON object
  const firstBrace = cleaned.indexOf('{')
  const firstBracket = cleaned.indexOf('[')
  let start: number

  if (firstBrace === -1 && firstBracket === -1) {
    return cleaned
  }

  if (firstBrace === -1) {
    start = firstBracket
  } else if (firstBracket === -1) {
    start = firstBrace
  } else {
    start = Math.min(firstBrace, firstBracket)
  }

  // Find matching close
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\') {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) {
        return cleaned.slice(start, i + 1)
      }
    }
  }

  // Fallback: return from first brace/bracket to end
  return cleaned.slice(start)
}

export async function llmJSON(opts: LlmChatOptions): Promise<unknown> {
  const response = await llmChat({ ...opts, format: 'json' })
  const extracted = extractJSON(response.content)
  try {
    return JSON.parse(extracted)
  } catch (err) {
    const preview = extracted.slice(0, 200)
    throw new Error(`LLM returned invalid JSON: ${err instanceof Error ? err.message : err}. Preview: ${preview}`)
  }
}

export { LLM_BASE, LLM_API_KEY, LLM_MODEL }