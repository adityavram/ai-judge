/**
 * YouTube transcript fetcher using InnerTube API with HTML fallback.
 *
 * Strategy:
 * 1. Try InnerTube API with multiple client contexts (no captcha risk)
 * 2. If all InnerTube contexts fail, try HTML page scraping as last resort
 * 3. If HTML scraping returns a captcha page, throw a clear rate-limit error
 * 4. Retry with exponential backoff on transient failures
 *
 * The InnerTube API returns caption track URLs that we fetch and parse as XML.
 * Each client context (ANDROID, TV, WEB_EMBEDDED, IOS, MWEB) may have different
 * access levels — some bypass age restrictions, some have captions where others don't.
 */

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false'
const INNERTUBE_API_KEY = process.env.YT_INNERTUBE_KEY ?? 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)'

interface ClientContext {
  name: string
  context: Record<string, unknown>
  userAgent: string
  useApiKey: boolean
}

const CLIENT_CONTEXTS: ClientContext[] = [
  {
    name: 'ANDROID',
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '20.10.38',
      },
    },
    userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
    useApiKey: false,
  },
  {
    name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
    context: {
      client: {
        clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
        clientVersion: '2.0',
        hl: 'en',
        gl: 'US',
      },
      thirdParty: {
        embedUrl: 'https://www.google.com',
      },
    },
    userAgent: BROWSER_USER_AGENT,
    useApiKey: true,
  },
  {
    name: 'WEB_EMBEDDED',
    context: {
      client: {
        clientName: 'WEB_EMBEDDED_PLAYER',
        clientVersion: '1.20240726.00.00',
        hl: 'en',
        gl: 'US',
      },
      thirdParty: {
        embedUrl: 'https://www.google.com',
      },
    },
    userAgent: BROWSER_USER_AGENT,
    useApiKey: true,
  },
  {
    name: 'IOS',
    context: {
      client: {
        clientName: 'IOS',
        clientVersion: '20.10.38',
        hl: 'en',
        gl: 'US',
      },
    },
    userAgent: 'com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 18_0 like Mac OS X)',
    useApiKey: false,
  },
  {
    name: 'MWEB',
    context: {
      client: {
        clientName: 'MWEB',
        clientVersion: '2.20240726.05.00',
        hl: 'en',
        gl: 'US',
      },
    },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    useApiKey: true,
  },
]

interface CaptionTrack {
  baseUrl: string
  languageCode: string
  name?: { simpleText?: string }
}

interface TranscriptLine {
  text: string
  offset: number
  duration: number
  lang: string
}

const RE_YOUTUBE = /(?:youtube\.com\/(?:[^/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?/\s]{11})/i
const RE_XML_TRANSCRIPT = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
}

function parseTranscriptXml(xml: string, lang: string): TranscriptLine[] {
  const results: TranscriptLine[] = []

  // Try srv3 format first: <p t="ms" d="ms"><s>word</s>...</p>
  const pRegex = /<p\s+t="(\d+)"\s+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g
  let match: RegExpExecArray | null
  while ((match = pRegex.exec(xml)) !== null) {
    const startMs = parseInt(match[1], 10)
    const durMs = parseInt(match[2], 10)
    const inner = match[3]
    let text = ''
    const sRegex = /<s[^>]*>([^<]*)<\/s>/g
    let sMatch: RegExpExecArray | null
    while ((sMatch = sRegex.exec(inner)) !== null) {
      text += sMatch[1]
    }
    if (!text) {
      text = inner.replace(/<[^>]+>/g, '')
    }
    text = decodeEntities(text).trim()
    if (text) {
      results.push({ text, offset: startMs, duration: durMs, lang })
    }
  }
  if (results.length > 0) return results

  // Fall back to classic format
  RE_XML_TRANSCRIPT.lastIndex = 0
  while ((match = RE_XML_TRANSCRIPT.exec(xml)) !== null) {
    results.push({
      text: decodeEntities(match[3]),
      offset: parseFloat(match[1]),
      duration: parseFloat(match[2]),
      lang,
    })
  }
  return results
}

async function fetchCaptionXml(url: string, userAgent: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })
  if (!resp.ok) {
    throw new Error(`Failed to fetch caption XML: HTTP ${resp.status}`)
  }
  return resp.text()
}

function extractCaptionTracks(data: unknown): CaptionTrack[] | null {
  const d = data as Record<string, unknown>
  const captions = d?.captions as Record<string, unknown> | undefined
  const renderer = captions?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined
  const tracks = renderer?.captionTracks
  if (Array.isArray(tracks) && tracks.length > 0) {
    return tracks as CaptionTrack[]
  }
  return null
}

async function tryInnerTubeClient(
  videoId: string,
  client: ClientContext,
  preferredLang?: string,
): Promise<TranscriptLine[]> {
  const url = client.useApiKey
    ? `${INNERTUBE_API_URL}&key=${INNERTUBE_API_KEY}`
    : INNERTUBE_API_URL

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': client.userAgent,
    },
    body: JSON.stringify({
      context: client.context,
      videoId,
    }),
  })

  if (!resp.ok) {
    throw new Error(`InnerTube ${client.name} returned HTTP ${resp.status}`)
  }

  const data = await resp.json()

  const playability = (data as Record<string, unknown>)?.playabilityStatus as Record<string, unknown> | undefined
  if (playability?.status === 'UNPLAYABLE') {
    const reason = (playability?.reason as string) ?? 'unknown'
    throw new Error(`Video unplayable: ${reason}`)
  }

  const captionTracks = extractCaptionTracks(data)
  if (!captionTracks) {
    throw new Error('No captions available for this video')
  }

  // Select track: prefer specified lang, then English, then non-auto-generated, then first
  let track = captionTracks.find((t) => t.languageCode === (preferredLang ?? 'en'))
    ?? captionTracks.find((t) => t.languageCode?.startsWith('en'))
    ?? captionTracks.find((t) => !(t.name?.simpleText ?? '').includes('auto-generated'))
    ?? captionTracks[0]

  const captionUrl = new URL(track.baseUrl)
  if (!captionUrl.hostname.endsWith('.youtube.com')) {
    throw new Error('Invalid caption URL')
  }

  const xml = await fetchCaptionXml(track.baseUrl, client.userAgent)
  const lines = parseTranscriptXml(xml, preferredLang ?? track.languageCode ?? 'en')

  if (lines.length === 0) {
    throw new Error('Transcript XML was empty')
  }

  return lines
}

/**
 * Fallback: fetch transcript by scraping the YouTube watch page.
 * This can trigger captchas on datacenter IPs, so we detect them carefully.
 */
async function tryWebPageScrape(videoId: string, preferredLang?: string): Promise<TranscriptLine[]> {
  const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      'User-Agent': BROWSER_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
  })

  if (!resp.ok) {
    throw new Error(`YouTube watch page returned HTTP ${resp.status}`)
  }

  const html = await resp.text()

  // Detect captcha
  if (html.includes('class="g-recaptcha"') || html.includes('captcha')) {
    throw new YouTubeRateLimitError()
  }

  // Parse ytInitialPlayerResponse from inline script
  const startToken = 'var ytInitialPlayerResponse = '
  const startIndex = html.indexOf(startToken)
  if (startIndex === -1) {
    throw new Error('Could not find player data in YouTube page')
  }

  const jsonStart = startIndex + startToken.length
  let depth = 0
  let jsonEnd = jsonStart
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++
    else if (html[i] === '}') {
      depth--
      if (depth === 0) {
        jsonEnd = i + 1
        break
      }
    }
  }

  let playerData: Record<string, unknown>
  try {
    playerData = JSON.parse(html.slice(jsonStart, jsonEnd))
  } catch {
    throw new Error('Could not parse player data from YouTube page')
  }

  const captionTracks = extractCaptionTracks(playerData)
  if (!captionTracks) {
    throw new Error('No captions available for this video')
  }

  let track = captionTracks.find((t) => t.languageCode === (preferredLang ?? 'en'))
    ?? captionTracks.find((t) => t.languageCode?.startsWith('en'))
    ?? captionTracks.find((t) => !(t.name?.simpleText ?? '').includes('auto-generated'))
    ?? captionTracks[0]

  const xml = await fetchCaptionXml(track.baseUrl, BROWSER_USER_AGENT)
  const lines = parseTranscriptXml(xml, preferredLang ?? track.languageCode ?? 'en')

  if (lines.length === 0) {
    throw new Error('Transcript XML was empty')
  }

  return lines
}

export class YouTubeTranscriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'YouTubeTranscriptError'
  }
}

export class YouTubeRateLimitError extends YouTubeTranscriptError {
  constructor() {
    super('YouTube is temporarily rate-limiting our server. Please try again in a few minutes.')
  }
}

export class YouTubeNoTranscriptError extends YouTubeTranscriptError {
  constructor(videoId: string) {
    super(`No transcript available for this video (${videoId})`)
  }
}

export function extractVideoId(urlOrId: string): string | null {
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlOrId)) return urlOrId
  const match = urlOrId.match(RE_YOUTUBE)
  return match?.[1] ?? null
}

/**
 * Fetch YouTube transcript.
 * 1. Try InnerTube API with multiple client contexts (no captcha risk)
 * 2. If all fail, try HTML page scraping as last resort (may trigger captcha)
 * 3. Retry with exponential backoff on transient failures
 * 4. Cache prevents most repeat fetches
 */
export async function fetchYouTubeTranscript(
  videoId: string,
  preferredLang?: string,
): Promise<{ text: string; offset: number; duration: number }[]> {
  const MAX_RETRIES = 2
  const RETRY_DELAY_MS = 3000
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await tryFetchTranscript(videoId, preferredLang)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt)
        console.warn(`[youtube] All methods failed, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`)
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  throw lastError ?? new YouTubeTranscriptError('Failed to fetch transcript after multiple retries.')
}

async function tryFetchTranscript(
  videoId: string,
  preferredLang?: string,
): Promise<{ text: string; offset: number; duration: number }[]> {
  const errors: string[] = []

  // Try each InnerTube client context
  for (const client of CLIENT_CONTEXTS) {
    try {
      const lines = await tryInnerTubeClient(videoId, client, preferredLang)
      console.log(`[youtube] Fetched transcript via InnerTube ${client.name} (${lines.length} lines)`)
      return lines.map((l) => ({
        text: l.text,
        offset: l.offset,
        duration: l.duration,
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[youtube] InnerTube ${client.name} failed: ${msg}`)
      errors.push(`InnerTube ${client.name}: ${msg}`)
    }
  }

  // If any InnerTube client successfully fetched the video but found no captions,
  // the video genuinely has no captions — don't fall through to HTML scraping
  // (which can trigger captchas/rate-limits on datacenter IPs).
  // Some clients may fail with access errors (UNPLAYABLE, ERROR status, HTTP 403)
  // even when the video exists, so we only need ONE "no captions" signal.
  if (errors.some((e) => /No capt/i.test(e))) {
    throw new YouTubeNoTranscriptError(videoId)
  }

  // If ALL errors are access/playability issues (no "no captions" signal), try HTML
  // Last resort: try HTML page scraping (can trigger captcha on datacenter IPs)
  console.warn('[youtube] All InnerTube contexts failed, trying HTML page scrape...')
  try {
    const lines = await tryWebPageScrape(videoId, preferredLang)
    console.log(`[youtube] Fetched transcript via HTML scrape (${lines.length} lines)`)
    return lines.map((l) => ({
      text: l.text,
      offset: l.offset,
      duration: l.duration,
    }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[youtube] HTML scrape failed: ${msg}`)
    errors.push(`HTML scrape: ${msg}`)
  }

  // All methods failed — throw appropriate error
  if (errors.some((e) => /rate.limit|captcha|temporarily|429/i.test(e))) {
    throw new YouTubeRateLimitError()
  }

  throw new YouTubeTranscriptError(
    `Failed to fetch transcript. Errors: ${errors.join('; ')}`,
  )
}