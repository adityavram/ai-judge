/**
 * API client for the AI Judge pipeline.
 *
 * Main flow:
 * 1. startPipeline(url, topic?, resumeFrom?) → POST /api/pipeline → job ID
 * 2. pollPipeline(jobId) → GET /api/pipeline/:id → loop until done/error
 * 3. Progressive results: transcript/flow/judging appear as each step completes
 *
 * Also provides:
 * - submitFeedback() — POST /api/feedback
 * - listCachedRounds() / getCachedRound() — GET /api/cache/rounds for history
 */

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
  format: DebateFormat
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
  format: 'apda'
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
  newArgs: string[]
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

export interface RFDSection {
  weighing: string
  weighingComparison: string
  whyWinnerWon: string
  linkByLink: string
}

export interface JudgingResult {
  winner: 'Government' | 'Opposition'
  topic: string
  weighing: WeighingAnalysis
  clashVerdicts: ClashVerdict[]
  devilsAdvocatePositions: DevilsAdvocatePosition[]
  rfd: RFDSection
  speakerScores: SpeakerScore[]
  governmentTeam: TeamFeedback
  oppositionTeam: TeamFeedback
}

// ── BP Types ──

export type DebateFormat = 'apda' | 'bp'

export const BP_SPEECHES = [
  { label: 'PM', team: 'OG', side: 'Government' },
  { label: 'LO', team: 'OO', side: 'Opposition' },
  { label: 'DPM', team: 'OG', side: 'Government' },
  { label: 'DLO', team: 'OO', side: 'Opposition' },
  { label: 'MG', team: 'CG', side: 'Government' },
  { label: 'MO', team: 'CO', side: 'Opposition' },
  { label: 'GW', team: 'CG', side: 'Government' },
  { label: 'OW', team: 'CO', side: 'Opposition' },
] as const

export interface BPFlowArg {
  tag: string
  text: string
  components: FlowComponent[]
  isExtension?: boolean
  isNewInWhip?: boolean
  respondsTo?: string
}

export interface BPFlowEntry {
  speech: string
  team: string
  side: string
  args: BPFlowArg[]
  isExtension?: boolean
  extensionSummary?: string
  knifeDetected?: boolean
  knifeExplanation?: string
}

export interface BPFlowSheet {
  format: 'bp'
  entries: BPFlowEntry[]
}

export interface BPExtensionAnalysis {
  team: string
  hasExtension: boolean
  extensionSummary: string
  differentiatedFromOpening: boolean
  knifeDetected: boolean
  knifeExplanation?: string
}

export interface BPTeamRanking {
  team: string
  rank: 1 | 2 | 3 | 4
  reasoning: string
}

export interface BPDevilsAdvocatePosition {
  label: string
  team: string
  argument: string
  whyItCouldWin: string
}

export interface BPSpeakerScore {
  speech: string
  speaker: string
  team: string
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

export interface BPRFDSection {
  topHalfSummary: string
  topHalfWinner: string
  topHalfReasoning: string
  closingGovernment: string
  closingOpposition: string
  finalRankingJustification: string
}

export interface BPJudgingResult {
  format: 'bp'
  topic: string
  rankings: BPTeamRanking[]
  extensionAnalysis: BPExtensionAnalysis[]
  rfd: BPRFDSection
  devilsAdvocatePositions: BPDevilsAdvocatePosition[]
  speakerScores: BPSpeakerScore[]
  teams: Record<string, TeamFeedback>
}

export type PipelineStatus = 'transcript' | 'diarize' | 'flow' | 'judge' | 'done' | 'error'

export interface Paradigm {
  id: string
  name: string
  description: string
  prompt: string
  isBuiltin: boolean
  format: 'apda' | 'bp'
}

export interface ParadigmList {
  builtin: Paradigm[]
  custom: Paradigm[]
}

export type AnyFlowSheet = FlowSheet | BPFlowSheet
export type AnyJudgingResult = JudgingResult | BPJudgingResult

export interface PipelineState {
  id: string
  status: PipelineStatus
  format: DebateFormat
  transcript: Transcript | null
  flow: AnyFlowSheet | null
  judging: AnyJudgingResult | null
  errorStep: string | null
  error: string | null
}

const MAX_POLL_RETRIES = 3

export async function startPipeline(url: string, topic?: string, resumeFrom?: 'transcript' | 'diarize' | 'flow' | 'judge', paradigm?: string, format?: DebateFormat): Promise<string> {
  const res = await fetch(`${API_BASE}/api/pipeline`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ url, topic, resumeFrom, paradigm, format: format ?? 'apda' }),
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
  const data = await res.json() as { id: string; status: string; format: DebateFormat }
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

export interface CachedRoundSummary {
  videoId: string
  topic: string
  format: DebateFormat
  hasTranscript: boolean
  hasFlow: boolean
  hasJudge: boolean
  createdAt: string
}

export async function listCachedRounds(): Promise<CachedRoundSummary[]> {
  const res = await fetch(`${API_BASE}/api/cache/rounds`, {
    headers: authHeaders(),
  })
  if (!res.ok) return []
  return res.json() as Promise<CachedRoundSummary[]>
}

export async function listParadigms(): Promise<ParadigmList> {
  const res = await fetch(`${API_BASE}/api/paradigms`, {
    headers: authHeaders(),
  })
  if (!res.ok) return { builtin: [], custom: [] }
  return res.json() as Promise<ParadigmList>
}

export async function createParadigm(name: string, description: string, prompt: string): Promise<Paradigm> {
  const res = await fetch(`${API_BASE}/api/paradigms`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ name, description, prompt }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(typeof body === 'object' && body.error ? body.error : `HTTP ${res.status}`)
  }
  return res.json() as Promise<Paradigm>
}

export async function deleteParadigm(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/paradigms/${id}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete paradigm: HTTP ${res.status}`)
  }
}

export interface CachedRoundDetail {
  videoId: string
  topic: string
  format: DebateFormat
  topicInferred: boolean
  hasTranscript: boolean
  hasRawTranscript: boolean
  hasFlow: boolean
  hasJudge: boolean
  createdAt: string
  transcript: Transcript | null
  flow: AnyFlowSheet | null
  judging: AnyJudgingResult | null
}

export async function getCachedRound(videoId: string, paradigmId?: string, format?: DebateFormat): Promise<CachedRoundDetail | null> {
  const params = new URLSearchParams()
  if (paradigmId) params.set('paradigm', paradigmId)
  if (format) params.set('format', format)
  const qs = params.toString()
  const res = await fetch(`${API_BASE}/api/cache/rounds/${videoId}${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(),
  })
  if (res.status === 404) return null
  if (!res.ok) return null
  return res.json() as Promise<CachedRoundDetail>
}