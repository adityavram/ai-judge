import type { CaptionSegment, SpeakerSegment } from './types.js'
import { llmJSON, LlmError } from './llm.js'

const APDA_EXPECTED_SPEECHES = 6

const APDA_SPEECHES = [
  { label: 'PMC', side: 'Government' },
  { label: 'LOC', side: 'Opposition' },
  { label: 'MG', side: 'Government' },
  { label: 'MO', side: 'Opposition' },
  { label: 'LOR', side: 'Opposition' },
  { label: 'PMR', side: 'Government' },
]

// Max durations in seconds — blocks exceeding these MUST be split
// APDA constructives nominally 7-8 min but regularly go 10-12 min; replies 4-5 min
// Since we don't know speech order during splitting, use generous per-position caps
// Later speeches (MG, MO) often run longest due to accumulated arguments
const MAX_SPEECH_S = [
  720,  // PMC: 12 min max (7-8 nominal)
  780,  // LOC: 13 min max (8 nominal, lots of ground to cover)
  840,  // MG:  14 min max (8 nominal, often runs long responding to LOC)
  900,  // MO:  15 min max (8 nominal, responds to everything, often longest)
  420,  // LOR:  7 min max (4 nominal, but can stretch)
  420,  // PMR:  7 min max (4 nominal, but can stretch)
]

// Expected speech durations in seconds (APDA)
const APDA_DURATIONS = [420, 480, 480, 480, 240, 240] // 7, 8, 8, 8, 4, 4 min

const MIN_GAP_S = 2.0 // Ignore gaps smaller than 2 seconds
const MAX_GAP_S = 120.0 // Ignore absurdly large gaps (likely bad timestamps)
const MIN_SPEECH_WORDS = 50 // Skip blocks with fewer than 50 words (likely noise)
const MIN_SPEECH_S = 45 // Skip blocks shorter than 45 seconds (likely noise or moderator intro)
const MIN_REPLY_S = 30 // Reply speeches can be as short as 30 seconds

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

function blockWordCount(block: CaptionSegment[]): number {
  return block.reduce((n, c) => n + c.text.split(/\s+/).length, 0)
}

// Find the best gap to split an oversized block
function findBestSplitInBlock(
  block: CaptionSegment[],
  globalOffset: number,
): number | null {
  const gaps: Gap[] = []
  for (let i = 1; i < block.length; i++) {
    const prev = block[i - 1]
    const curr = block[i]
    const gapS = curr.start - (prev.start + prev.duration)
    if (gapS >= MIN_GAP_S && gapS <= MAX_GAP_S) {
      gaps.push({ index: globalOffset + i, durationS: gapS })
    }
  }

  // Prefer gaps in the middle 60% of the block (avoid splitting too early or late)
  const dur = blockDuration(block)
  const start = block[0].start
  const midStart = start + dur * 0.2
  const midEnd = start + dur * 0.8

  const preferred = gaps.filter((g) => {
    const time = block[g.index - globalOffset]?.start ?? 0
    return time >= midStart && time <= midEnd
  })

  if (preferred.length > 0) {
    return preferred.reduce((best, g) => g.durationS > best.durationS ? g : best).index
  }

  // Fallback: just take the biggest gap
  if (gaps.length > 0) {
    return gaps.reduce((best, g) => g.durationS > best.durationS ? g : best).index
  }

  // Last resort: split at the midpoint
  const midTime = start + dur / 2
  let closestIdx = globalOffset + 1
  let closestDist = Infinity
  for (let i = 0; i < block.length; i++) {
    const dist = Math.abs(block[i].start - midTime)
    if (dist < closestDist) {
      closestDist = dist
      closestIdx = globalOffset + i
    }
  }
  return closestIdx
}

// Score a set of split points by how well block durations match APDA expectations
function scoreSplit(captions: CaptionSegment[], splits: number[]): number {
  const blocks = buildBlocks(captions, splits)
  if (blocks.length !== APDA_EXPECTED_SPEECHES) return Infinity

  let score = 0
  for (let i = 0; i < blocks.length; i++) {
    const dur = blockDuration(blocks[i])
    const expected = APDA_DURATIONS[i]
    const dev = Math.abs(dur - expected) / expected
    score += dev * dev
  }
  return score
}

// Find best split points: combine gap quality with duration fit
function findBestSplits(captions: CaptionSegment[]): number[] | null {
  const gaps = computeGaps(captions)
  const splitCount = APDA_EXPECTED_SPEECHES - 1

  if (gaps.length < splitCount) return null

  const minSpacingS = 120 // 2 minutes minimum between split points
  const relaxedSpacingS = 60 // 1 minute for relaxed mode

  const sortedGaps = [...gaps].sort((a, b) => b.durationS - a.durationS)
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

  // Optimize: try swapping each selected split with nearby gaps to improve duration fit
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

// Enforce max-duration constraint: split any block that exceeds its position's cap
function enforceMaxDurations(captions: CaptionSegment[], splits: number[]): number[] {
  let currentSplits = [...splits]

  let changed = true
  let iterations = 0
  while (changed && iterations < 10) {
    changed = false
    iterations++
    const blocks = buildBlocks(captions, currentSplits)

    let offset = 0
    for (let i = 0; i < blocks.length; i++) {
      const dur = blockDuration(blocks[i])
      const maxDur = i < MAX_SPEECH_S.length ? MAX_SPEECH_S[i] : MAX_SPEECH_S[MAX_SPEECH_S.length - 1]

      if (dur > maxDur) {
        const splitPoint = findBestSplitInBlock(blocks[i], offset)
        if (splitPoint !== null && !currentSplits.includes(splitPoint)) {
          currentSplits.push(splitPoint)
          currentSplits.sort((a, b) => a - b)
          changed = true
        }
      }
      offset += blocks[i].length
    }
  }

  return currentSplits
}

// Remove tiny/noisy blocks that are probably not real speeches
function removeSmallBlocks(captions: CaptionSegment[], splits: number[]): number[] {
  let blocks = buildBlocks(captions, splits)
  const toRemove: number[] = []

  let offset = 0
  for (let i = 0; i < blocks.length; i++) {
    const words = blockWordCount(blocks[i])
    const dur = blockDuration(blocks[i])
    // Remove blocks that are too short in both words and time
    if (words < MIN_SPEECH_WORDS && dur < 30) {
      if (i > 0 && i - 1 < splits.length) {
        toRemove.push(splits[i - 1])
      }
    }
    offset += blocks[i].length
  }

  if (toRemove.length === 0) return splits
  return splits.filter((s) => !toRemove.includes(s))
}

// Merge blocks that are too short for their speech type into a neighbor
function mergeShortBlocks(blocks: CaptionSegment[][], labels: string[]): { blocks: CaptionSegment[][]; labels: string[] } {
  const result: CaptionSegment[][] = []
  const resultLabels: string[] = []

  for (let i = 0; i < blocks.length; i++) {
    const dur = blockDuration(blocks[i])
    const label = labels[i] ?? `Speech ${i + 1}`
    const isReply = label === 'LOR' || label === 'PMR'
    const minDur = isReply ? MIN_REPLY_S : MIN_SPEECH_S

    if (dur < minDur) {
      const side = getSideForLabel(label)
      const prevSame = result.length > 0 && getSideForLabel(resultLabels[resultLabels.length - 1]) === side
      const nextSame = i + 1 < blocks.length && getSideForLabel(labels[i + 1]) === side

      if (prevSame) {
        console.log(`[diarization] Merging short block ${label} (${(dur / 60).toFixed(1)}min) into previous ${resultLabels[resultLabels.length - 1]}`)
        result[result.length - 1] = [...result[result.length - 1], ...blocks[i]]
      } else if (nextSame) {
        console.log(`[diarization] Merging short block ${label} (${(dur / 60).toFixed(1)}min) into next ${labels[i + 1]}`)
        blocks[i + 1] = [...blocks[i], ...blocks[i + 1]]
      } else if (result.length > 0) {
        console.log(`[diarization] Merging short block ${label} (${(dur / 60).toFixed(1)}min) into previous (different side)`)
        result[result.length - 1] = [...result[result.length - 1], ...blocks[i]]
      } else {
        result.push(blocks[i])
        resultLabels.push(label)
      }
    } else {
      result.push(blocks[i])
      resultLabels.push(label)
    }
  }

  return { blocks: result, labels: resultLabels }
}

// Trim pleasantries, intros, and outro padding from block boundaries
async function trimBlockBoundaries(block: CaptionSegment[], speechLabel: string): Promise<CaptionSegment[]> {
  if (block.length < 5) return block

  const preview = blockToText(block, 300)
  const tailPreview = block.slice(-Math.min(20, block.length)).map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim().split(/\s+/).slice(-80).join(' ')

  const system = `You are cleaning up a debate speech transcript. The transcript may include:
- Introductory pleasantries ("thanks judge", "good afternoon", "let's get started", "on to...")
- Host/moderator introductions before the speaker starts
- Time signals ("thirty seconds!", "one minute!")
- Closing pleasantries ("thank you", "I'll yield", "that's all the time I have")
- Other speakers interrupting (POIs, etc.)

Your job is to identify how many words from the START and END should be trimmed to remove non-speech content. Be CONSERVATIVE — only trim clear pleasantries/padding, not actual argument content.

Reply with ONLY valid JSON:
{
  "trimStart": <number of words to trim from start, 0 if no preamble>,
  "trimEnd": <number of words to trim from end, 0 if no outro>
}

If the speech starts and ends with substantive argument content, return 0 for both.`

  const user = `Speech: ${speechLabel}
Start of transcript (first ~300 words):
${preview}

End of transcript (last ~80 words):
${tailPreview}

How many words should be trimmed from start and end?`

  try {
    const parsed = await llmJSON({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      format: 'json',
      temperature: 0.1,
      label: `diarization:trim:${speechLabel}`,
    }) as { trimStart: number; trimEnd: number }

    let { trimStart, trimEnd } = parsed

    // Safety: don't trim more than 20% of the block
    const totalWords = blockWordCount(block)
    const maxTrim = Math.floor(totalWords * 0.2)
    trimStart = Math.min(Math.max(0, trimStart), maxTrim)
    trimEnd = Math.min(Math.max(0, trimEnd), maxTrim)

    if (trimStart === 0 && trimEnd === 0) return block

    // Convert word counts to caption indices
    let wordsSoFar = 0
    let startIdx = 0
    for (let i = 0; i < block.length; i++) {
      wordsSoFar += block[i].text.split(/\s+/).length
      if (wordsSoFar >= trimStart && startIdx === 0) {
        startIdx = i + 1
      }
    }

    let wordsFromEnd = 0
    let endIdx = block.length
    for (let i = block.length - 1; i >= 0; i--) {
      wordsFromEnd += block[i].text.split(/\s+/).length
      if (wordsFromEnd >= trimEnd && endIdx === block.length) {
        endIdx = i
      }
    }

    if (startIdx >= endIdx) return block

    console.log(`[diarization] Trimmed ${speechLabel}: removed ~${trimStart} words from start, ~${trimEnd} from end`)
    return block.slice(startIdx, endIdx)
  } catch (err) {
    console.warn(`[diarization] Trim failed for ${speechLabel}: ${err instanceof Error ? err.message : err}`)
    return block
  }
}

async function validateSpeechRoles(blocks: CaptionSegment[][], topic?: string): Promise<string[]> {
  const previews = blocks.map((b, i) => {
    const dur = blockDuration(b)
    const words = blockWordCount(b)
    const durMin = (dur / 60).toFixed(1)
    return `BLOCK ${i + 1} (${durMin} min, ${words} words):\n${blockToText(b, 250)}`
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

IMPORTANT DURATION GUIDANCE:
- Constructive speeches (PMC, LOC, MG, MO) are typically 6-10 minutes long
- Reply speeches (LOR, PMR) are typically 3-5 minutes long
- If a block is 15+ minutes, it likely contains MULTIPLE speeches and was split incorrectly — flag this in your response
- If a block is under 1 minute, it may be a moderator intro or pleasantries — not a real speech

CRITICAL — NON-DEBATE BLOCKS:
- There should be exactly 6 speeches in an APDA round. If there are more than 6 blocks, the extras are likely:
  - Moderator introductions, announcements, or judge feedback
  - Audience reactions or applause
  - Post-round discussion or voting
- Label any block that is NOT a debate speech as "SKIP"
- Signs a block should be SKIP: it doesn't argue for or against the motion, it's audience/moderator talk, or it happens after the debate speeches end

Pay close attention to:
- Does the speaker say "we" referring to government or opposition?
- Is the speaker defending or attacking the motion?
- Is the speaker responding to the previous block (new side) or extending it (same side)?
- Reply vs constructive: reply speeches are shorter, crystallize, and weigh — they don't introduce new evidence

If there are 6 blocks, the sides MUST alternate as Gov, Opp, Gov, Opp, Opp, Gov (note: LOR follows MO, both Opposition). Use stance to disambiguate.

Respond with ONLY valid JSON:
{
  "labels": ["PMC", "LOC", "MG", "MO", "LOR", "PMR"]
}`

  const user = `Here are the speech blocks in chronological order. Assign each block its APDA speech label. Pay close attention to stance (for/against the motion), duration, and speech order.${topicLine}

${previews.join('\n\n')}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.1,
    label: 'diarization:validate-roles',
  }) as { labels: string[] }
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

  // Enforce max-duration constraints and remove tiny blocks
  let finalSplits = enforceMaxDurations(captions, splits)
  finalSplits = removeSmallBlocks(captions, finalSplits)
  finalSplits.sort((a, b) => a - b)

  let blocks = buildBlocks(captions, finalSplits)

  console.log(`[diarization] Block durations: ${blocks.map((b) => `${(blockDuration(b) / 60).toFixed(1)}min/${blockWordCount(b)}w`).join(', ')}`)

  // Try LLM validation to assign correct speech labels
  try {
    console.log(`[diarization] Validating ${blocks.length} speech roles via LLM...`)
    let labels = await validateSpeechRoles(blocks, topic)

    // If we have more than 6 blocks, the LLM may not have given enough labels
    // Try to merge or let it proceed with what we have
    if (labels.length !== blocks.length) {
      console.warn(`[diarization] LLM returned ${labels.length} labels for ${blocks.length} blocks — using deterministic labels`)
      labels = blocks.map((_, i) => APDA_SPEECHES[i]?.label ?? `Speech ${i + 1}`)
    }

    // Filter out SKIP-labeled blocks (non-debate content)
    const skipIndices = new Set<number>()
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 'SKIP') {
        console.log(`[diarization] Skipping non-debate block ${i + 1} (${(blockDuration(blocks[i]) / 60).toFixed(1)}min)`)
        skipIndices.add(i)
      }
    }
    if (skipIndices.size > 0) {
      const filteredBlocks = blocks.filter((_, i) => !skipIndices.has(i))
      const filteredLabels = labels.filter((_, i) => !skipIndices.has(i))
      blocks = filteredBlocks
      labels = filteredLabels
    }

    // Trim pleasantries from each block
    const trimmedBlocks: CaptionSegment[][] = []
    const trimmedLabels: string[] = []
    for (let i = 0; i < blocks.length; i++) {
      const label = labels[i] ?? `Speech ${i + 1}`
      try {
        const trimmed = await trimBlockBoundaries(blocks[i], label)
        // Skip blocks that became too small after trimming (likely noise)
        if (blockWordCount(trimmed) < MIN_SPEECH_WORDS && blockDuration(trimmed) < 30) {
          console.log(`[diarization] Skipping tiny block ${label} after trimming`)
          continue
        }
        trimmedBlocks.push(trimmed)
        trimmedLabels.push(label)
      } catch {
        trimmedBlocks.push(blocks[i])
        trimmedLabels.push(label)
      }
    }

    // Merge blocks that are too short for their speech type
    const merged = mergeShortBlocks(trimmedBlocks, trimmedLabels)

    const segments: SpeakerSegment[] = merged.blocks.map((block, i) => {
      const label = merged.labels[i] ?? `Speech ${i + 1}`
      const side = getSideForLabel(label)
      return blockToSegment(block, `${label} (${side})`)
    })

    const confidence: 'high' | 'low' = merged.labels.length === APDA_EXPECTED_SPEECHES ? 'high' : 'low'
    console.log(`[diarization] Final: ${merged.labels.join(', ')} (confidence: ${confidence})`)
    return { segments, confidence, detectedSpeechCount: merged.labels.length }
  } catch (err) {
    // Propagate token exhaustion / config errors
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