/**
 * Shared type definitions for the AI Judge pipeline.
 *
 * Data flows through the pipeline as:
 *   CaptionSegment[] → SpeakerSegment[] (diarization)
 *   SpeakerSegment[] → FlowSheet (flow generation)
 *   FlowSheet → JudgingResult (judging)
 */

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

// Judging types

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