const API_BASE = import.meta.env.VITE_API_BASE ?? ''

const CLIENT_ID_KEY = 'ai-judge-client-id'

function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(CLIENT_ID_KEY, id)
  }
  return id
}

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Client-Id': getClientId(),
  }
}

export interface SpeakerSegment {
  speaker: string
  text: string
  startTime: number
  endTime: number
}

export interface Transcript {
  videoId: string
  segments: SpeakerSegment[]
  rawSegments: { text: string; start: number; duration: number }[]
  segmentationConfidence: 'high' | 'low'
  detectedSpeechCount: number
  topic: string
  topicInferred: boolean
}

export interface FlowComponent {
  label: string
  text: string
}

export interface FlowArgument {
  speech: string
  side: string
  tag: string
  text: string
  components: FlowComponent[]
}

export interface FlowClash {
  name: string
  args: FlowArgument[]
}

export interface FlowSheet {
  clashes: FlowClash[]
}

export interface WeighingAnalysis {
  keyIssues: {
    name: string
    importance: string
    whyItMatters: string
  }[]
  overallFramework: string
}

export interface ClashVerdict {
  clashName: string
  winner: 'Government' | 'Opposition' | 'Tie'
  reasoning: string
  keyArgs: string[]
}

export interface DevilsAdvocatePosition {
  label: string
  side: string
  argument: string
  whyItCouldWin: string
}

export interface SpeakerScore {
  speech: string
  speaker: string
  side: string
  score: number
  rank: number
  warrant: string
  impact: string
  weighing: string
  engagement: string
  argumentQuality: string
  justification: string
}

export interface TeamFeedback {
  side: string
  strengths: string[]
  weaknesses: string[]
  improvements: string[]
}

export interface JudgingResult {
  winner: 'Government' | 'Opposition'
  topic: string
  weighing: WeighingAnalysis
  clashVerdicts: ClashVerdict[]
  devilsAdvocatePositions: DevilsAdvocatePosition[]
  rfd: string
  speakerScores: SpeakerScore[]
  governmentTeam: TeamFeedback
  oppositionTeam: TeamFeedback
}

export interface RateLimitInfo {
  remaining: number
  limit: number
  resetAt: string
}

async function handleResponse(res: Response): Promise<{ ok: boolean; status: number; body: unknown }> {
  const text = await res.text().catch(() => '')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = { error: text || `HTTP ${res.status}` } }
  return { ok: res.ok, status: res.status, body: parsed }
}

function errorFromBody(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'error' in body) {
    const b = body as { error: string; detail?: string }
    return b.detail ? `${b.error} — ${b.detail}` : b.error
  }
  return `HTTP ${status}`
}

export async function fetchTranscript(url: string, topic?: string): Promise<Transcript> {
  try {
    const res = await fetch(`${API_BASE}/api/transcript`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ url, topic }),
    })
    const { ok, status, body } = await handleResponse(res)
    if (!ok) {
      console.error('[fetchTranscript] HTTP', status, body)
      if (status === 429) throw new Error('Daily round limit reached. Please try again tomorrow.')
      throw new Error(errorFromBody(body, status))
    }
    return body as Transcript
  } catch (err) {
    if (err instanceof Error && err.message.includes('HTTP')) throw err
    if (err instanceof Error && err.message.includes('Daily round')) throw err
    console.error('[fetchTranscript] Network error:', err)
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

export async function fetchFlow(segments: SpeakerSegment[]): Promise<FlowSheet> {
  try {
    const res = await fetch(`${API_BASE}/api/flow`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ segments }),
    })
    const { ok, status, body } = await handleResponse(res)
    if (!ok) {
      console.error('[fetchFlow] HTTP', status, body)
      if (status === 429) throw new Error('Daily round limit reached. Please try again tomorrow.')
      throw new Error(errorFromBody(body, status))
    }
    return body as FlowSheet
  } catch (err) {
    if (err instanceof Error && (err.message.includes('HTTP') || err.message.includes('Daily round'))) throw err
    console.error('[fetchFlow] Network error:', err)
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

export async function judgeRound(flow: FlowSheet, topic: string): Promise<JudgingResult> {
  try {
    console.log('[judgeRound] Sending request:', { clashes: flow.clashes.length, topic })
    const res = await fetch(`${API_BASE}/api/judge`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ flow, topic }),
    })
    const { ok, status, body } = await handleResponse(res)
    if (!ok) {
      console.error('[judgeRound] HTTP', status, body)
      if (status === 429) throw new Error('Daily round limit reached. Please try again tomorrow.')
      throw new Error(errorFromBody(body, status))
    }
    console.log('[judgeRound] Success:', { winner: (body as JudgingResult).winner })
    return body as JudgingResult
  } catch (err) {
    if (err instanceof Error && (err.message.includes('HTTP') || err.message.includes('Daily round'))) throw err
    console.error('[judgeRound] Network error:', err)
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}

export async function submitFeedback(message: string, rating?: number, videoUrl?: string): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/feedback`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ message, rating, videoUrl }),
    })
    const { ok, status, body } = await handleResponse(res)
    if (!ok) {
      throw new Error(errorFromBody(body, status))
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('HTTP')) throw err
    throw new Error(`Network error: ${err instanceof Error ? err.message : 'unknown'}`)
  }
}