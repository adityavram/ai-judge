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
}