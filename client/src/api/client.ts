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

export type PipelineStatus = 'transcript' | 'flow' | 'judge' | 'done' | 'error'

export interface PipelineState {
  id: string
  status: PipelineStatus
  transcript: Transcript | null
  flow: FlowSheet | null
  judging: JudgingResult | null
  errorStep: string | null
  error: string | null
}

const MAX_POLL_RETRIES = 3

export async function startPipeline(url: string, topic?: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/pipeline`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ url, topic }),
  })
  if (res.status === 429) throw new Error('Daily round limit reached. Please try again tomorrow.')
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `Validation error: HTTP ${res.status}`)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Failed to start pipeline: HTTP ${res.status} ${text}`)
  }
  const data = await res.json() as { id: string; status: string }
  return data.id
}

export async function pollPipeline(jobId: string): Promise<PipelineState> {
  for (let attempt = 0; attempt < MAX_POLL_RETRIES; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/api/pipeline/${jobId}`, {
        headers: authHeaders(),
      })
      if (res.status === 404) {
        // Server restarted — job lost
        return {
          id: jobId,
          status: 'error',
          transcript: null,
          flow: null,
          judging: null,
          errorStep: null,
          error: 'The server was restarted and your round was lost. Please try again.',
        }
      }
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        // Server temporarily unavailable — retry after delay
        if (attempt < MAX_POLL_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 3000))
          continue
        }
        return {
          id: jobId,
          status: 'error',
          transcript: null,
          flow: null,
          judging: null,
          errorStep: null,
          error: 'The server is temporarily unavailable. Please try again in a moment.',
        }
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Failed to poll pipeline: HTTP ${res.status} ${text}`)
      }
      return res.json() as Promise<PipelineState>
    } catch (err) {
      if (err instanceof TypeError && err.message.includes('fetch')) {
        // Network error — retry
        if (attempt < MAX_POLL_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 3000))
          continue
        }
        throw new Error('Could not reach the server. Please check your connection and try again.')
      }
      throw err
    }
  }
  throw new Error('Failed to reach server after multiple attempts.')
}

export async function submitFeedback(message: string, rating?: number, videoUrl?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/feedback`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ message, rating, videoUrl }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(typeof body === 'object' && body.error ? body.error : `HTTP ${res.status}`)
  }
}