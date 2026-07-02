import type { CaptionSegment, SpeakerSegment } from './types.js'
import { llmChat, LlmError } from './llm.js'

const APDA_EXPECTED_SPEECHES = 6

const APDA_SPEECHES = [
  { label: 'PMC', side: 'Government' },
  { label: 'LOC', side: 'Opposition' },
  { label: 'MG', side: 'Government' },
  { label: 'MO', side: 'Opposition' },
  { label: 'LOR', side: 'Opposition' },
  { label: 'PMR', side: 'Government' },
]

// Expected speech durations in seconds (APDA)
const APDA_DURATIONS = [420, 480, 480, 480, 240, 240] // 7, 8, 8, 8, 4, 4 min

const MIN_GAP_S = 2.0 // Ignore gaps smaller than 2 seconds
const MAX_GAP_S = 120.0 // Ignore absurdly large gaps (likely bad timestamps)

export interface DiarizationResult {
  segments: SpeakerSegment[]
  confidence: 'high' | 'low'
  detectedSpeechCount: number
}

interface Gap {
  index: number
  durationS: number
}

function computeGaps(captions: CaptionSegment[]): Gap[] {
  const gaps: Gap[] = []
  for (let i = 1; i < captions.length; i++) {
    const prev = captions[i - 1]
    const curr = captions[i]
    const gapS = curr.start - (prev.start + prev.duration)
    if (gapS >= MIN_GAP_S && gapS <= MAX_GAP_S) {
      gaps.push({ index: i, durationS: gapS })
    }
  }
  return gaps
}

function buildBlocks(captions: CaptionSegment[], splitIndices: number[]): CaptionSegment[][] {
  const sorted = [...splitIndices].sort((a, b) => a - b)
  const blocks: CaptionSegment[][] = []
  let start = 0
  for (const idx of sorted) {
    blocks.push(captions.slice(start, idx))
    start = idx
  }
  blocks.push(captions.slice(start))
  return blocks.filter((b) => b.length > 0)
}

function blockToText(block: CaptionSegment[], maxWords = 250): string {
  const text = block.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim()
  const words = text.split(' ')
  return words.slice(0, maxWords).join(' ')
}

function blockToSegment(block: CaptionSegment[], speaker: string): SpeakerSegment {
  return {
    speaker,
    text: block.map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim(),
    startTime: block[0].start,
    endTime: block[block.length - 1].start + block[block.length - 1].duration,
  }
}

function blockDuration(block: CaptionSegment[]): number {
  return block[block.length - 1].start + block[block.length - 1].duration - block[0].start
}

// Score a set of split points by how well block durations match APDA expectations
// Lower score = better fit
function scoreSplit(captions: CaptionSegment[], splits: number[]): number {
  const blocks = buildBlocks(captions, splits)
  if (blocks.length !== APDA_EXPECTED_SPEECHES) return Infinity

  let score = 0
  for (let i = 0; i < blocks.length; i++) {
    const dur = blockDuration(blocks[i])
    const expected = APDA_DURATIONS[i]
    // Penalize deviation from expected duration (as fraction of expected)
    const dev = Math.abs(dur - expected) / expected
    score += dev * dev // square to penalize large deviations more
  }
  return score
}

// Find best split points: combine gap quality with duration fit
// Enforces minimum spacing between splits so they don't cluster
function findBestSplits(captions: CaptionSegment[]): number[] | null {
  const gaps = computeGaps(captions)
  const splitCount = APDA_EXPECTED_SPEECHES - 1

  if (gaps.length < splitCount) return null

  const minSpacingS = 120 // 2 minutes minimum between split points (in seconds)
  const relaxedSpacingS = 60 // 1 minute for relaxed mode

  const sortedGaps = [...gaps].sort((a, b) => b.durationS - a.durationS)

  // Helper: get timestamp of a segment index
  const timeOf = (idx: number) => captions[idx].start

  // Greedy selection: pick biggest gaps but enforce minimum time spacing
  const selected: number[] = []
  for (const gap of sortedGaps) {
    if (selected.length >= splitCount) break
    const tooClose = selected.some((idx) => Math.abs(timeOf(idx) - timeOf(gap.index)) < minSpacingS)
    if (!tooClose) {
      selected.push(gap.index)
    }
  }

  // If greedy didn't find enough spaced splits, relax the constraint
  if (selected.length < splitCount) {
    selected.length = 0
    for (const gap of sortedGaps) {
      if (selected.length >= splitCount) break
      const tooClose = selected.some((idx) => Math.abs(timeOf(idx) - timeOf(gap.index)) < relaxedSpacingS)
      if (!tooClose) {
        selected.push(gap.index)
      }
    }
  }

  // If still not enough, just take the biggest gaps without spacing constraint
  if (selected.length < splitCount) {
    selected.length = 0
    for (const gap of sortedGaps.slice(0, splitCount)) {
      selected.push(gap.index)
    }
  }

  if (selected.length < splitCount) return null

  // Now optimize: try swapping each selected split with nearby gaps to improve duration fit
  let bestSplits = [...selected].sort((a, b) => a - b)
  let bestScore = scoreSplit(captions, bestSplits)

  for (let i = 0; i < splitCount; i++) {
    const currentIdx = bestSplits[i]
    const nearbyGaps = sortedGaps.filter(
      (g) => Math.abs(timeOf(g.index) - timeOf(currentIdx)) < 60 && g.index !== currentIdx,
    )
    for (const gap of nearbyGaps) {
      const candidate = [...bestSplits]
      candidate[i] = gap.index
      candidate.sort((a, b) => a - b)
      // Check spacing constraint
      const valid = candidate.every((idx, j) => j === 0 || timeOf(idx) - timeOf(candidate[j - 1]) >= relaxedSpacingS)
      if (!valid) continue
      const s = scoreSplit(captions, candidate)
      if (s < bestScore) {
        bestScore = s
        bestSplits = candidate
      }
    }
  }

  console.log(`[diarization] Split score: ${bestScore.toFixed(3)}, splits: ${bestSplits.join(', ')}`)
  return bestSplits
}

async function validateSpeechRoles(blocks: CaptionSegment[][], topic?: string): Promise<string[]> {
  const previews = blocks.map((b, i) => {
    const dur = blockDuration(b)
    return `BLOCK ${i + 1} (${dur.toFixed(0)}s):\n${blockToText(b, 250)}`
  })
  const topicLine = topic ? `\n\nThe debate topic/motion is: "${topic}"` : '\n\nThe debate topic is unknown — infer it from the first block.'

  const system = `You are an expert APDA debate judge. You are given ${blocks.length} speech blocks from a debate round, in chronological order.

APDA speech order:
1. PMC (Government) — sets up the case, defines terms, presents plan
2. LOC (Opposition) — first opposition response, counter-plan or direct refutation
3. MG (Government) — extends government case, responds to LOC
4. MO (Opposition) — extends opposition, collapses to best arguments
5. LOR (Opposition) — reply speech, summarizes and crystallizes for opposition
6. PMR (Government) — reply speech, summarizes and crystallizes for government

Your job is to assign the correct speech label to each block. The MOST IMPORTANT signal is STANCE:
- Government speakers ADVOCATE FOR the motion (defend the case, defend the plan, argue the motion is good)
- Opposition speakers ADVOCATE AGAINST the motion (attack the case, run counter-plans, argue the motion is bad)
- Reply speeches (LOR/PMR) are shorter, summarize/weigh, and don't make new args

Pay close attention to:
- Does the speaker say "we" referring to government or opposition?
- Is the speaker defending or attacking the motion?
- Is the speaker responding to the previous block (new side) or extending it (same side)?
- Reply vs constructive: reply speeches are shorter, crystallize, and weigh — they don't introduce new evidence
- The duration of each block is shown — reply speeches should be ~4 min, constructives ~7-8 min

If there are 6 blocks, the sides MUST alternate as Gov, Opp, Gov, Opp, Opp, Gov (note: LOC→MG→MO→LOR can be tricky since LOR is Opp following MO which is also Opp). Use stance to disambiguate.

Respond with ONLY valid JSON:
{
  "labels": ["PMC", "LOC", "MG", "MO", "LOR", "PMR"]
}`

  const user = `Here are the speech blocks in chronological order. Assign each block its APDA speech label. Pay close attention to whether each speaker is arguing FOR or AGAINST the motion.${topicLine}

${previews.join('\n\n')}`

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.1,
    label: 'diarization:validate-roles',
  })

  const parsed = JSON.parse(response.content) as { labels: string[] }
  return parsed.labels
}

function getSideForLabel(label: string): string {
  const speech = APDA_SPEECHES.find((s) => s.label === label)
  return speech?.side ?? 'Unknown'
}

export async function assignSpeakers(captions: CaptionSegment[], topic?: string): Promise<DiarizationResult> {
  if (captions.length === 0) return { segments: [], confidence: 'low', detectedSpeechCount: 0 }

  const splits = findBestSplits(captions)

  if (!splits) {
    return {
      segments: [blockToSegment(captions, `${APDA_SPEECHES[0].label} (${APDA_SPEECHES[0].side})`)],
      confidence: 'low',
      detectedSpeechCount: 1,
    }
  }

  const blocks = buildBlocks(captions, splits)

  console.log(`[diarization] Block durations: ${blocks.map((b) => `${blockDuration(b).toFixed(0)}s`).join(', ')}`)

  // Try LLM validation to assign correct speech labels
  try {
    console.log(`[diarization] Validating ${blocks.length} speech roles via LLM...`)
    const labels = await validateSpeechRoles(blocks, topic)

    if (labels.length === blocks.length) {
      const segments: SpeakerSegment[] = blocks.map((block, i) => {
        const label = labels[i] ?? `Speech ${i + 1}`
        const side = getSideForLabel(label)
        return blockToSegment(block, `${label} (${side})`)
      })

      const confidence: 'high' | 'low' = blocks.length === APDA_EXPECTED_SPEECHES ? 'high' : 'low'
      console.log(`[diarization] LLM assigned: ${labels.join(', ')}`)
      return { segments, confidence, detectedSpeechCount: blocks.length }
    }
  } catch (err) {
    // Propagate token exhaustion / config errors — don't silently fall back
    if (err instanceof LlmError && (err.kind === 'token_exhausted' || err.kind === 'config')) throw err
    console.warn('[diarization] LLM validation failed, falling back to deterministic:', err instanceof Error ? err.message : err)
  }

  // Fallback: deterministic order-based assignment
  const segments: SpeakerSegment[] = blocks.map((block, i) => {
    const speech = APDA_SPEECHES[i] ?? { label: `Speech ${i + 1}`, side: i % 2 === 0 ? 'Government' : 'Opposition' }
    return blockToSegment(block, `${speech.label} (${speech.side})`)
  })

  const confidence: 'high' | 'low' = blocks.length === APDA_EXPECTED_SPEECHES ? 'high' : 'low'
  return { segments, confidence, detectedSpeechCount: blocks.length }
}

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

export { extractVideoId, APDA_SPEECHES, APDA_EXPECTED_SPEECHES }