import type { CaptionSegment, SpeakerSegment } from './types.js'

const SPEAKER_GAP_THRESHOLD_MS = 2500
const MAX_SEGMENT_LENGTH_MS = 60000

const DEFAULT_SPEAKERS = ['Affirmative', 'Negative']
const CROSS_X_SPEAKERS = ['CX-Aff', 'CX-Neg']

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return null
}

function assignSpeakers(
  captions: CaptionSegment[],
): SpeakerSegment[] {
  const segments: SpeakerSegment[] = []
  let currentSpeakerIndex = 0
  let currentChunk: CaptionSegment[] = []

  const flushChunk = () => {
    if (currentChunk.length === 0) return
    const text = currentChunk
      .map((c) => c.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) {
      currentChunk = []
      return
    }
    segments.push({
      speaker: DEFAULT_SPEAKERS[currentSpeakerIndex % DEFAULT_SPEAKERS.length],
      text,
      startTime: currentChunk[0].start,
      endTime: currentChunk[currentChunk.length - 1].start + currentChunk[currentChunk.length - 1].duration,
    })
    currentChunk = []
  }

  for (let i = 0; i < captions.length; i++) {
    const seg = captions[i]
    const prev = captions[i - 1]
    const gap = prev ? seg.start - (prev.start + prev.duration) : 0

    const chunkDuration = currentChunk.length > 0
      ? seg.start + seg.duration - currentChunk[0].start
      : seg.duration

    if (
      (gap > SPEAKER_GAP_THRESHOLD_MS / 1000 && currentChunk.length > 0) ||
      chunkDuration > MAX_SEGMENT_LENGTH_MS / 1000
    ) {
      flushChunk()
      currentSpeakerIndex++
    }

    currentChunk.push(seg)
  }
  flushChunk()

  return segments
}

export { extractVideoId, assignSpeakers, DEFAULT_SPEAKERS, CROSS_X_SPEAKERS }