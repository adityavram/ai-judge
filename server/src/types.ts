/**
 * Shared type definitions for the AI Judge pipeline.
 *
 * Supports two debate formats:
 *   APDA: 2-team (Gov vs Opp), 6 speeches, clash-based flow, binary winner
 *   BP:   4-team (OG/OO/CG/CO), 8 speeches, speech-by-speech flow, ranked 1st-4th
 *
 * Data flows through the pipeline as:
 *   CaptionSegment[] → SpeakerSegment[] (diarization)
 *   SpeakerSegment[] → FlowSheet | BPFlowSheet (flow generation)
 *   FlowSheet → JudgingResult (APDA judging)
 *   BPFlowSheet → BPJudgingResult (BP judging)
 */

export type DebateFormat = 'apda' | 'bp'

// ── Shared types ──

export interface CaptionSegment {
  text: string
  start: number
  duration: number
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
  rawSegments: CaptionSegment[]
  segmentationConfidence: 'high' | 'low'
  detectedSpeechCount: number
  topic: string
  topicInferred: boolean
}

export interface FlowComponent {
  label: string
  text: string
}

export interface TeamFeedback {
  side: string
  strengths: string[]
  weaknesses: string[]
  improvements: string[]
}

// ── APDA types ──

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
  side: 'Government' | 'Opposition'
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

export interface RFDSection {
  weighing: string
  weighingComparison: string
  whyWinnerWon: string
  linkByLink: string
}

export interface JudgingResult {
  format: 'apda'
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

// ── British Parliamentary types ──

export const BP_EXPECTED_SPEECHES = 8

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

export const BP_TEAMS = ['OG', 'OO', 'CG', 'CO'] as const
export type BPTeam = typeof BP_TEAMS[number]

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
  team: BPTeam
  hasExtension: boolean
  extensionSummary: string
  differentiatedFromOpening: boolean
  knifeDetected: boolean
  knifeExplanation?: string
}

export interface BPTeamRanking {
  team: BPTeam
  rank: 1 | 2 | 3 | 4
  reasoning: string
}

export interface BPDevilsAdvocatePosition {
  label: string
  team: BPTeam
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
  teams: Record<BPTeam, TeamFeedback>
}

// ── Union result type ──

export type AnyJudgingResult = JudgingResult | BPJudgingResult
export type AnyFlowSheet = FlowSheet | BPFlowSheet