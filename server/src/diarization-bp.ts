/**
 * Speech diarization for British Parliamentary (BP) debate transcripts.
 *
 * Takes raw YouTube caption segments and splits them into 8 speaker-labeled
 * speech blocks (PM, LO, DPM, DLO, MG, MO, GW, OW) following BP debate format.
 *
 * Algorithm:
 * 1. Find natural pause gaps in captions to identify speech boundaries
 * 2. Score and optimize split points to match expected BP speech durations (~7 min each)
 * 3. Enforce per-position max durations (~9 min cap per speech)
 * 4. Use LLM to validate/assign BP speech labels (PM, LO, etc.)
 * 5. Trim pleasantries, POI interjections, chair remarks from boundaries via LLM
 * 6. Merge blocks that are too short, skip non-debate content
 *
 * Falls back to deterministic position-based assignment if LLM fails.
 */

import type { CaptionSegment, SpeakerSegment } from './types.js'
import { BP_EXPECTED_SPEECHES, BP_SPEECHES } from './types.js'
import { llmJSON, LlmError } from './llm.js'

const BP_DURATIONS = [420, 420, 420, 420, 420, 420, 420, 420]

const MAX_SPEECH_S = [540, 540, 540, 540, 540, 540, 540, 540]

const MIN_GAP_S = 1.5
const MAX_GAP_S = 120.0
const MIN_SPEECH_WORDS = 80
const MIN_SPEECH_S = 60

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

  if (gaps.length > 0) {
    return gaps.reduce((best, g) => g.durationS > best.durationS ? g : best).index
  }

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

function scoreSplit(captions: CaptionSegment[], splits: number[]): number {
  const blocks = buildBlocks(captions, splits)
  if (blocks.length !== BP_EXPECTED_SPEECHES) return Infinity

  let score = 0
  for (let i = 0; i < blocks.length; i++) {
    const dur = blockDuration(blocks[i])
    const expected = BP_DURATIONS[i]
    const dev = Math.abs(dur - expected) / expected
    score += dev * dev
  }
  return score
}

function findBestSplits(captions: CaptionSegment[]): number[] | null {
  const gaps = computeGaps(captions)
  const splitCount = BP_EXPECTED_SPEECHES - 1

  if (gaps.length < splitCount) return null

  const minSpacingS = 90
  const relaxedSpacingS = 45

  const sortedGaps = [...gaps].sort((a, b) => b.durationS - a.durationS)
  const timeOf = (idx: number) => captions[idx].start

  const selected: number[] = []
  for (const gap of sortedGaps) {
    if (selected.length >= splitCount) break
    const tooClose = selected.some((idx) => Math.abs(timeOf(idx) - timeOf(gap.index)) < minSpacingS)
    if (!tooClose) {
      selected.push(gap.index)
    }
  }

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

  if (selected.length < splitCount) {
    selected.length = 0
    for (const gap of sortedGaps.slice(0, splitCount)) {
      selected.push(gap.index)
    }
  }

  if (selected.length < splitCount) return null

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

  console.log(`[diarization-bp] Split score: ${bestScore.toFixed(3)}, splits: ${bestSplits.join(', ')}`)
  return bestSplits
}

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

function removeSmallBlocks(captions: CaptionSegment[], splits: number[]): number[] {
  const blocks = buildBlocks(captions, splits)
  const toRemove: number[] = []

  let offset = 0
  for (let i = 0; i < blocks.length; i++) {
    const words = blockWordCount(blocks[i])
    const dur = blockDuration(blocks[i])
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

function getTeamForLabel(label: string): string {
  const speech = BP_SPEECHES.find((s) => s.label === label)
  return speech?.team ?? 'Unknown'
}


function mergeShortBlocks(blocks: CaptionSegment[][], labels: string[]): { blocks: CaptionSegment[][]; labels: string[] } {
  const result: CaptionSegment[][] = []
  const resultLabels: string[] = []

  for (let i = 0; i < blocks.length; i++) {
    const dur = blockDuration(blocks[i])
    const label = labels[i] ?? `Speech ${i + 1}`

    if (dur < MIN_SPEECH_S) {
      const team = getTeamForLabel(label)
      const prevSame = result.length > 0 && getTeamForLabel(resultLabels[resultLabels.length - 1]) === team
      const nextSame = i + 1 < blocks.length && getTeamForLabel(labels[i + 1]) === team

      if (prevSame) {
        console.log(`[diarization-bp] Merging short block ${label} (${(dur / 60).toFixed(1)}min) into previous ${resultLabels[resultLabels.length - 1]}`)
        result[result.length - 1] = [...result[result.length - 1], ...blocks[i]]
      } else if (nextSame) {
        console.log(`[diarization-bp] Merging short block ${label} (${(dur / 60).toFixed(1)}min) into next ${labels[i + 1]}`)
        blocks[i + 1] = [...blocks[i], ...blocks[i + 1]]
      } else if (result.length > 0) {
        console.log(`[diarization-bp] Merging short block ${label} (${(dur / 60).toFixed(1)}min) into previous (different team)`)
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

async function trimBlockBoundaries(block: CaptionSegment[], speechLabel: string): Promise<CaptionSegment[]> {
  if (block.length < 5) return block

  const preview = blockToText(block, 300)
  const tailPreview = block.slice(-Math.min(20, block.length)).map((c) => c.text).join(' ').replace(/\s+/g, ' ').trim().split(/\s+/).slice(-80).join(' ')

  const system = `You are cleaning up a British Parliamentary debate speech transcript. BP rounds often contain:
- Chair or moderator introductions ("order order", "the next speaker", "we'll now hear from...", "time", "the motion before the house is...")
- Point of Information (POI) interjections from opponents ("point of information", "on that point", "yes please", "no thank you")
- Audience reactions (laughter, applause, cheering)
- Introductory pleasantries ("Madam Speaker", "Mr. Speaker", "thank you", "it's a pleasure")
- Time signals ("thirty seconds", "one minute", "time!")
- Closing pleasantries or yield statements

Your job is to identify how many words from the START and END should be trimmed to remove non-speech content. Be CONSERVATIVE — only trim clear non-argument content, not substantive debate material.

Be MORE AGGRESSIVE than you would for other formats about removing:
- Chair/moderator speech
- POI interjections that interrupt the speaker's flow
- Audience reactions (laughter, applause)
- "Order order" calls

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
      label: `diarization-bp:trim:${speechLabel}`,
    }) as { trimStart: number; trimEnd: number }

    let { trimStart, trimEnd } = parsed

    const totalWords = blockWordCount(block)
    const maxTrim = Math.floor(totalWords * 0.2)
    trimStart = Math.min(Math.max(0, trimStart), maxTrim)
    trimEnd = Math.min(Math.max(0, trimEnd), maxTrim)

    if (trimStart === 0 && trimEnd === 0) return block

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

    console.log(`[diarization-bp] Trimmed ${speechLabel}: removed ~${trimStart} words from start, ~${trimEnd} from end`)
    return block.slice(startIdx, endIdx)
  } catch (err) {
    console.warn(`[diarization-bp] Trim failed for ${speechLabel}: ${err instanceof Error ? err.message : err}`)
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
  const topicLine = topic ? `\n\nThe debate motion is: "${topic}"` : '\n\nThe debate motion is unknown — infer it from the first block.'

  const system = `You are an expert British Parliamentary (BP) debate judge. You are given ${blocks.length} speech blocks from a BP debate round, in chronological order.

BP speech order (8 speeches, 4 teams, 2 sides):
1. PM (Opening Government / OG) — defines the motion, presents the case, sets up the debate
2. LO (Opening Opposition / OO) — first opposition response, direct refutation or counter-case
3. DPM (Opening Government / OG) — extends and defends the government case, responds to LO
4. DLO (Opening Opposition / OO) — extends opposition, responds to DPM, collapses to best arguments
5. MG (Closing Government / CG) — MUST bring an extension that differentiates CG from OG; cannot simply repeat OG's case
6. MO (Closing Opposition / CO) — extension speech for opposition; must differentiate CO from OO
7. GW (Closing Government / CG) — whip speech: crystallization and weighing, NO new arguments
8. OW (Closing Opposition / CO) — whip speech: crystallization and weighing, NO new arguments

Key signals for identifying speeches:
- STANCE: Government speakers advocate FOR the motion; Opposition speakers advocate AGAINST it
- TEAM: OG speakers (PM, DPM) set up the case; CG speakers (MG, GW) must bring a NEW extension
- EXTENSION: MG and MO must explicitly differentiate from their opening half — look for "our extension", "we add to our opening", "the closing team brings"
- WHIP: GW and OW crystallize and weigh — they don't introduce new evidence, they compare and prioritize arguments
- The sides alternate: Gov, Opp, Gov, Opp, Gov, Opp, Gov, Opp

IMPORTANT DURATION GUIDANCE:
- All BP speeches are ~7 minutes nominal (6-8 minutes typical)
- If a block is 12+ minutes, it likely contains MULTIPLE speeches and was split incorrectly
- If a block is under 1 minute, it may be a chair intro, moderator, or noise — not a real speech

CRITICAL — NON-DEBATE BLOCKS:
- There should be exactly 8 speeches in a BP round. If there are more than 8 blocks, the extras are likely:
  - Chair or moderator speech ("order order", "the next speaker", "time", introductions)
  - Point of Information (POI) interjections that got their own caption block
  - Audience reactions (laughter, applause, cheering)
  - Post-round discussion, voting, or adjudicator feedback
- Label any block that is NOT a debate speech as "SKIP"
- Signs a block should be SKIP: it doesn't argue for or against the motion, it's the chair/moderator talking, it's audience noise, or it happens outside the debate speeches
- Also label as "SKIP" any block that is clearly a POI (short opponent interjection like "point of information", "on that point") that was captured as a separate block

Pay close attention to:
- Does the speaker say "we" referring to government or opposition?
- Is the speaker presenting new arguments (constructive/extension) or crystallizing (whip)?
- Does the closing government/opposition speaker explicitly differentiate from their opening half?
- Is the block a legitimate speech or just noise/chair/POI?

If there are 8 blocks, the sides MUST alternate as Gov, Opp, Gov, Opp, Gov, Opp, Gov, Opp and the teams follow OG, OO, OG, OO, CG, CO, CG, CO. Use stance and extension/whip signals to disambiguate.

Respond with ONLY valid JSON:
{
  "labels": ["PM", "LO", "DPM", "DLO", "MG", "MO", "GW", "OW"]
}`

  const user = `Here are the speech blocks in chronological order from a British Parliamentary debate. Assign each block its BP speech label. Pay close attention to stance (for/against the motion), team identity (opening vs closing), and speech type (extension vs whip).${topicLine}

${previews.join('\n\n')}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.1,
    label: 'diarization-bp:validate-roles',
  }) as { labels: string[] }
  return parsed.labels
}

export async function assignSpeakersBP(captions: CaptionSegment[], topic?: string): Promise<DiarizationResult> {
  if (captions.length === 0) return { segments: [], confidence: 'low', detectedSpeechCount: 0 }

  const splits = findBestSplits(captions)

  if (!splits) {
    const first = BP_SPEECHES[0]
    return {
      segments: [blockToSegment(captions, `${first.label} (${first.team})`)],
      confidence: 'low',
      detectedSpeechCount: 1,
    }
  }

  let finalSplits = enforceMaxDurations(captions, splits)
  finalSplits = removeSmallBlocks(captions, finalSplits)
  finalSplits.sort((a, b) => a - b)

  let blocks = buildBlocks(captions, finalSplits)

  console.log(`[diarization-bp] Block durations: ${blocks.map((b) => `${(blockDuration(b) / 60).toFixed(1)}min/${blockWordCount(b)}w`).join(', ')}`)

  try {
    console.log(`[diarization-bp] Validating ${blocks.length} speech roles via LLM...`)
    let labels = await validateSpeechRoles(blocks, topic)

    if (labels.length !== blocks.length) {
      console.warn(`[diarization-bp] LLM returned ${labels.length} labels for ${blocks.length} blocks — using deterministic labels`)
      labels = blocks.map((_, i) => BP_SPEECHES[i]?.label ?? `Speech ${i + 1}`)
    }

    const skipIndices = new Set<number>()
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === 'SKIP') {
        console.log(`[diarization-bp] Skipping non-debate block ${i + 1} (${(blockDuration(blocks[i]) / 60).toFixed(1)}min)`)
        skipIndices.add(i)
      }
    }
    if (skipIndices.size > 0) {
      const filteredBlocks = blocks.filter((_, i) => !skipIndices.has(i))
      const filteredLabels = labels.filter((_, i) => !skipIndices.has(i))
      blocks = filteredBlocks
      labels = filteredLabels
    }

    const trimmedBlocks: CaptionSegment[][] = []
    const trimmedLabels: string[] = []
    for (let i = 0; i < blocks.length; i++) {
      const label = labels[i] ?? `Speech ${i + 1}`
      try {
        const trimmed = await trimBlockBoundaries(blocks[i], label)
        if (blockWordCount(trimmed) < MIN_SPEECH_WORDS && blockDuration(trimmed) < 30) {
          console.log(`[diarization-bp] Skipping tiny block ${label} after trimming`)
          continue
        }
        trimmedBlocks.push(trimmed)
        trimmedLabels.push(label)
      } catch {
        trimmedBlocks.push(blocks[i])
        trimmedLabels.push(label)
      }
    }

    const merged = mergeShortBlocks(trimmedBlocks, trimmedLabels)

    const segments: SpeakerSegment[] = merged.blocks.map((block, i) => {
      const label = merged.labels[i] ?? `Speech ${i + 1}`
      const team = getTeamForLabel(label)
      return blockToSegment(block, `${label} (${team})`)
    })

    const confidence: 'high' | 'low' = merged.labels.length === BP_EXPECTED_SPEECHES ? 'high' : 'low'
    console.log(`[diarization-bp] Final: ${merged.labels.join(', ')} (confidence: ${confidence})`)
    return { segments, confidence, detectedSpeechCount: merged.labels.length }
  } catch (err) {
    if (err instanceof LlmError && (err.kind === 'token_exhausted' || err.kind === 'config')) throw err
    console.warn('[diarization-bp] LLM validation failed, falling back to deterministic:', err instanceof Error ? err.message : err)
  }

  const segments: SpeakerSegment[] = blocks.map((block, i) => {
    const speech = BP_SPEECHES[i] ?? { label: `Speech ${i + 1}`, team: i % 2 === 0 ? 'OG' : 'OO', side: i % 2 === 0 ? 'Government' : 'Opposition' }
    return blockToSegment(block, `${speech.label} (${speech.team})`)
  })

  const confidence: 'high' | 'low' = blocks.length === BP_EXPECTED_SPEECHES ? 'high' : 'low'
  return { segments, confidence, detectedSpeechCount: blocks.length }
}