/**
 * YouTube transcript fetcher using InnerTube API.
 *
 * The `youtube-transcript` npm package works via InnerTube but falls back to
 * HTML scraping when InnerTube fails — and that HTML scraping is what triggers
 * captchas on datacenter IPs. This implementation uses InnerTube only, with
 * multiple client contexts as fallbacks, and NEVER scrapes YouTube pages.
 *
 * InnerTube client contexts are tried in order of reliability:
 * 1. ANDROID — simplest, most reliable, no JS rendering needed
 * 2. WEB_EMBEDDED — works for embedded videos, requires API key
 * 3. IOS — mobile client, good backup
 */

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player'
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8' // Public YouTube web player key

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
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
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

  // Fall back to classic format: <text start="s" dur="s">content</text>
  const classicRegex = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g
  while ((match = classicRegex.exec(xml)) !== null) {
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

async function tryInnerTubeClient(
  videoId: string,
  client: ClientContext,
  preferredLang?: string,
): Promise<TranscriptLine[]> {
  const url = client.useApiKey
    ? `${INNERTUBE_API_URL}?key=${INNERTUBE_API_KEY}`
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

  const data = await resp.json() as {
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: CaptionTrack[]
      }
    }
    playabilityStatus?: {
      status?: string
      reason?: string
      messages?: string[]
    }
  }

  if (data.playabilityStatus?.status === 'UNPLAYABLE') {
    const reason = data.playabilityStatus.reason ?? data.playabilityStatus.messages?.join(', ') ?? 'unknown'
    throw new Error(`Video unplayable: ${reason}`)
  }

  const captionTracks = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    throw new Error('No captions available for this video')
  }

  // Select preferred language track, prefer English, then auto-generated
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
 * Fetch YouTube transcript using InnerTube API with rotating client contexts.
 * Never falls back to HTML scraping (which triggers captchas on datacenter IPs).
 */
export async function fetchYouTubeTranscript(
  videoId: string,
  preferredLang?: string,
): Promise<{ text: string; offset: number; duration: number }[]> {
  const errors: string[] = []

  for (const client of CLIENT_CONTEXTS) {
    try {
      const lines = await tryInnerTubeClient(videoId, client, preferredLang)
      console.log(`[youtube] Fetched transcript via ${client.name} (${lines.length} lines)`)
      return lines.map((l) => ({
        text: l.text,
        offset: l.offset,
        duration: l.duration,
      }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[youtube] ${client.name} failed: ${msg}`)
      errors.push(`${client.name}: ${msg}`)
    }
  }

  if (errors.some((e) => /HTTP 429|rate.limit|captcha/i.test(e))) {
    throw new YouTubeRateLimitError()
  }

  if (errors.every((e) => /No capt/i.test(e))) {
    throw new YouTubeNoTranscriptError(videoId)
  }

  throw new YouTubeTranscriptError(
    `Failed to fetch transcript after trying all clients. Errors: ${errors.join('; ')}`,
  )
}