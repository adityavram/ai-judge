/**
 * Flow sheet generation for British Parliamentary debate rounds.
 *
 * Two-pass approach:
 * 1. Pass 1 (parallel): Extract arguments from each speech independently via LLM,
 *    producing tagged flow entries with components. BP-specific:
 *    - Opening speeches (PM/LO/DPM/DLO): case setup, rebuttal, engagement
 *    - Extension speeches (MG/MO): flag new material as extensions
 *    - Whip speeches (GW/OW): flag any new arguments (disallowed in BP)
 *    - All args can have `respondsTo` referencing a team or speech
 * 2. Pass 2: Assemble BPFlowEntry for each speech. For MG/MO, analyze whether
 *    they constitute a genuine extension. For CG/CO, check for "knifing"
 *    (contradicting their opening team).
 *
 * BP flow is speech-by-speech, NOT clash-based like APDA.
 */

import type { SpeakerSegment, BPFlowArg, BPFlowEntry, BPFlowSheet } from './types.js'
import { BP_SPEECHES } from './types.js'
import { llmJSON, LlmError } from './llm.js'

interface ExtractedBPArg {
  tag: string
  text: string
  components: { label: string; text: string }[]
  isExtension?: boolean
  isNewInWhip?: boolean
  respondsTo?: string
}

function bpSpeechMeta(speaker: string) {
  const label = speaker.split(' ')[0]
  const entry = BP_SPEECHES.find((s) => s.label === label)
  return {
    label,
    team: entry?.team ?? 'OG',
    side: entry?.side ?? 'Government',
    isOpening: label === 'PM' || label === 'LO' || label === 'DPM' || label === 'DLO',
    isExtension: label === 'MG' || label === 'MO',
    isWhip: label === 'GW' || label === 'OW',
  }
}

async function extractArgsFromBPSpeech(segment: SpeakerSegment): Promise<ExtractedBPArg[]> {
  const meta = bpSpeechMeta(segment.speaker)

  let roleInstruction = ''
  if (meta.isOpening) {
    roleInstruction = `This is an OPENING speech (${meta.label}, ${meta.team}). Focus on:
- Case setup and definitions (especially for PM)
- Constructive arguments and their link/mechanism chains
- Rebuttal of the other side's case
- Engagement with the opposing opening team
Extract ALL arguments — aim for 4-8 args.`
  } else if (meta.isExtension) {
    roleInstruction = `This is an EXTENSION speech (${meta.label}, ${meta.team}). This is the closing team's chance to bring NEW material that differentiates them from their opening team. Focus on:
- New arguments that the opening team did NOT make (flag these with isExtension: true)
- Rebuttal of the opposing bench
- How the extension builds on or diverges from the opening team's case
- Weighing comparisons
Extract ALL arguments — aim for 4-8 args. Mark extension args with isExtension: true.`
  } else if (meta.isWhip) {
    roleInstruction = `This is a WHIP speech (${meta.label}, ${meta.team}). Whip speeches should NOT make new arguments — they crystallize, weigh, and summarize. Focus on:
- Collapsing to the team's best arguments
- Weighing comparisons (scope, severity, probability, timeframe, prerequisite)
- Crystallization of key clashes
- Defense of their opening or extension partner's args
Extract 3-6 args. If you see ANY genuinely new argument (not just reframing), flag it with isNewInWhip: true. In BP, new arguments in whip are disallowed.`
  }

  const system = `You are an expert British Parliamentary debate flow recorder. You read a speech transcript and produce flow entries in terse shorthand — the style debaters actually use on paper.

A good flow is DENSE and SHORT — not prose. Use bullet-point style.

CRITICAL PRIORITIES:
1. LINKS and MECHANISMS are the most important part. Break causal chains into steps.
   Example GOOD link: "LINK: ban → platforms exit market → less access → less harm"
   Example BAD link: "LINK: ban reduces social media use"
   Use INTERNAL LINKS: "IL1: ...", "IL2: ...", "IL3: ..."
2. WEIGHING must be flowed explicitly. Capture the TYPE and COMPARISON:
   - SCOPE, SEVERITY, PROBABILITY, TIMEFRAME, REVERSIBILITY, PREREQUISITE
3. Tags: 3-5 word labels, e.g. "T: plain text", "DA: Econ collapse", "Solvency deficit"
4. Components: UNIQUENESS, LINK, INTERNAL LINK (IL1/IL2/...), MECHANISM, IMPACT, EVIDENCE, ANALYSIS, RESPONSE, TURN, WEIGH, etc.
5. Each component = 1 line of shorthand, NOT full sentences. Abbreviate aggressively.
6. If the speaker responds to a prior argument, label it RESPONSE and note what it answers.
7. If a speaker CONCEDES or DROPs an argument, note it: "DROP: conceded LOC link"

${roleInstruction}

Respond with ONLY valid JSON:
{
  "args": [
    {
      "tag": "short tag (3-5 words)",
      "text": "1-line summary of the whole arg",
      "components": [
        { "label": "LINK", "text": "shorthand step-by-step mech" },
        { "label": "IL1", "text": "internal link step" },
        { "label": "IMPACT", "text": "shorthand text" },
        { "label": "WEIGH", "text": "scope: 10x more ppl affected" }
      ],
      "isExtension": false,
      "isNewInWhip": false,
      "respondsTo": "OO or null"
    }
  ]
}`

  const user = `Speech: ${meta.label} (${meta.team}, ${meta.side})

Transcript:
${segment.text}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: `flow-bp:extract:${meta.label}`,
  }) as { args: ExtractedBPArg[] }

  return parsed.args.map((a) => ({
    ...a,
    isExtension: meta.isExtension ? (a.isExtension ?? false) : undefined,
    isNewInWhip: meta.isWhip ? (a.isNewInWhip ?? false) : undefined,
    respondsTo: a.respondsTo || undefined,
  }))
}

interface ExtractedBPSpeech {
  speech: string
  team: string
  side: string
  args: ExtractedBPArg[]
}

async function analyzeExtensionsAndKnifing(
  entries: ExtractedBPSpeech[],
): Promise<{ extensionSummary?: string; knifeDetected?: boolean; knifeExplanation?: string }[]> {
  const openingOg = entries.filter((e) => e.team === 'OG')
  const openingOo = entries.filter((e) => e.team === 'OO')
  const closingCg = entries.filter((e) => e.team === 'CG')
  const closingCo = entries.filter((e) => e.team === 'CO')

  const results: { extensionSummary?: string; knifeDetected?: boolean; knifeExplanation?: string }[] = []

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.team === 'CG') {
      const extArgs = entry.args.filter((a) => a.isExtension)
      if (extArgs.length > 0) {
        const ogArgs = openingOg.flatMap((e) => e.args)
        const summary = await analyzeExtension(entry, ogArgs)
        results[i] = summary
      } else {
        results[i] = { extensionSummary: 'No clear extension material identified' }
      }
    } else if (entry.team === 'CO') {
      const extArgs = entry.args.filter((a) => a.isExtension)
      if (extArgs.length > 0) {
        const ooArgs = openingOo.flatMap((e) => e.args)
        const summary = await analyzeExtension(entry, ooArgs)
        results[i] = summary
      } else {
        results[i] = { extensionSummary: 'No clear extension material identified' }
      }
    } else {
      results[i] = {}
    }
  }

  const cgEntry = closingCg[0]
  if (cgEntry) {
    const ogArgs = openingOg.flatMap((e) => e.args)
    const knifeResult = await checkKnifing(cgEntry, 'OG', ogArgs)
    const idx = entries.indexOf(cgEntry)
    if (results[idx]) {
      results[idx]!.knifeDetected = knifeResult.knifeDetected
      results[idx]!.knifeExplanation = knifeResult.knifeExplanation
    }
  }

  const coEntry = closingCo[0]
  if (coEntry) {
    const ooArgs = openingOo.flatMap((e) => e.args)
    const knifeResult = await checkKnifing(coEntry, 'OO', ooArgs)
    const idx = entries.indexOf(coEntry)
    if (results[idx]) {
      results[idx]!.knifeDetected = knifeResult.knifeDetected
      results[idx]!.knifeExplanation = knifeResult.knifeExplanation
    }
  }

  return results
}

async function analyzeExtension(
  entry: ExtractedBPSpeech,
  openingArgs: ExtractedBPArg[],
): Promise<{ extensionSummary: string; knifeDetected?: boolean; knifeExplanation?: string }> {
  const extArgs = entry.args.filter((a) => a.isExtension)

  const system = `You are a BP debate extension analyst. Given a closing team's extension arguments and their opening team's arguments, determine:

1. Whether the extension is genuinely new and differentiates from the opening team
2. A brief summary (1-2 sentences) of what the extension adds

Respond with ONLY valid JSON:
{
  "extensionSummary": "1-2 sentence summary of what the extension adds and whether it differentiates"
}`

  const user = `### ${entry.speech} (${entry.team}) — Extension Arguments
${extArgs.map((a, i) => `${i + 1}. [${a.tag}] ${a.text}\n${a.components.map((c) => `   - ${c.label}: ${c.text}`).join('\n')}`).join('\n')}

### Opening Team Arguments
${openingArgs.map((a, i) => `${i + 1}. [${a.tag}] ${a.text}\n${a.components.map((c) => `   - ${c.label}: ${c.text}`).join('\n')}`).join('\n')}`

  const result = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: `flow-bp:extension:${entry.team}`,
  }) as { extensionSummary: string }

  return { extensionSummary: result.extensionSummary }
}

async function checkKnifing(
  closingEntry: ExtractedBPSpeech,
  openingTeam: string,
  openingArgs: ExtractedBPArg[],
): Promise<{ knifeDetected: boolean; knifeExplanation?: string }> {
  const system = `You are a BP debate knifing detector. In BP, "knifing" occurs when a closing team directly contradicts their opening team's case.

CRITICAL DISTINCTION — Reframing is NOT knifing:
In BP, closing teams are EXPECTED to reframe the debate, take a different angle, or argue that the opening team's framing misses something. This is a legitimate extension technique, NOT knifing. Examples of legitimate reframing that should NOT be flagged:
- Arguing that the opening team's positive claim actually has negative consequences (e.g., OG says "more parties improves representation" and CG says "more parties causes alienation" — this is reframing, not knifing)
- Taking the opening's premise in a new direction (e.g., OG argues for representation benefits, CG extends with democratic backsliding risks — this is extending, not contradicting)
- Offering a more nuanced or conditional version of the opening's argument
- Adding new arguments that interact differently with the opposition's case

Only flag as knifing if the closing team DIRECTLY CONTRADICTS the opening team's core thesis in a way that makes the opening's case impossible to sustain. For example:
- OG argues "policy X is good" and CG argues "policy X is bad" — this is knifing
- OG argues "more parties improve democracy" and CG argues "more parties cause alienation" — this is NOT knifing, it's reframing from a different angle

Given a closing team's arguments and their opening team's arguments, determine if the closing team is knifing (directly contradicting) the opening team.

Respond with ONLY valid JSON:
{
  "knifeDetected": true/false,
  "knifeExplanation": "If knifing detected, explain the direct contradiction. If not, explain why the closing team's arguments are consistent with or reframing the opening's case."
}`

  const user = `### Closing Team (${closingEntry.team}, ${closingEntry.speech}) Arguments
${closingEntry.args.map((a, i) => `${i + 1}. [${a.tag}] ${a.text}\n${a.components.map((c) => `   - ${c.label}: ${c.text}`).join('\n')}`).join('\n')}

### Opening Team (${openingTeam}) Arguments
${openingArgs.map((a, i) => `${i + 1}. [${a.tag}] ${a.text}\n${a.components.map((c) => `   - ${c.label}: ${c.text}`).join('\n')}`).join('\n')}`

  const result = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: `flow-bp:knife:${closingEntry.team}`,
  }) as { knifeDetected: boolean; knifeExplanation?: string }

  return {
    knifeDetected: result.knifeDetected,
    knifeExplanation: result.knifeExplanation,
  }
}

function toBPFlowArg(arg: ExtractedBPArg): BPFlowArg {
  const result: BPFlowArg = {
    tag: arg.tag,
    text: arg.text,
    components: arg.components.map((c) => ({ label: c.label, text: c.text })),
  }
  if (arg.isExtension) result.isExtension = true
  if (arg.isNewInWhip) result.isNewInWhip = true
  if (arg.respondsTo) result.respondsTo = arg.respondsTo
  return result
}

export async function generateFlowSheetBP(segments: SpeakerSegment[]): Promise<BPFlowSheet> {
  const startMs = Date.now()
  const errors: string[] = []
  const extractedSpeeches: ExtractedBPSpeech[] = []

  // Pass 1: Extract arguments from each speech in parallel
  const results = await Promise.allSettled(
    segments.map(async (seg) => {
      const args = await extractArgsFromBPSpeech(seg)
      const meta = bpSpeechMeta(seg.speaker)
      console.log(`[flow-bp] Extracted ${args.length} args from ${meta.label} (${meta.team})`)
      return {
        speech: meta.label,
        team: meta.team,
        side: meta.side,
        args,
      } satisfies ExtractedBPSpeech
    }),
  )

  for (const result of results) {
    if (result.status === 'fulfilled') {
      extractedSpeeches.push(result.value)
    } else {
      const err = result.reason
      if (err instanceof LlmError && (err.kind === 'token_exhausted' || err.kind === 'config')) throw err
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[flow-bp] Failed to extract args: ${msg}`)
      errors.push(msg)
    }
  }

  if (extractedSpeeches.length === 0) {
    const detail = errors.length > 0 ? errors.join('; ') : 'unknown'
    throw new Error(`All speeches failed to extract arguments. Errors: ${detail}`)
  }

  if (errors.length > 0) {
    console.warn(`[flow-bp] ${errors.length} speech(es) failed, continuing with ${extractedSpeeches.length} successful`)
  }

  // Sort speeches into BP order
  const orderMap = new Map<string, number>(BP_SPEECHES.map((s, i) => [s.label, i]))
  extractedSpeeches.sort((a, b) => (orderMap.get(a.speech) ?? 99) - (orderMap.get(b.speech) ?? 99))

  // Pass 2: Analyze extensions and knifing
  console.log(`[flow-bp] Analyzing extensions and knifing for ${extractedSpeeches.length} speeches`)
  let analyses: { extensionSummary?: string; knifeDetected?: boolean; knifeExplanation?: string }[]
  try {
    analyses = await analyzeExtensionsAndKnifing(extractedSpeeches)
  } catch (err) {
    if (err instanceof LlmError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Extension/knifing analysis failed: ${msg}. ${extractedSpeeches.length} speeches were successfully extracted.`)
  }

  const entries: BPFlowEntry[] = extractedSpeeches.map((speech, i) => {
    const analysis = analyses[i] ?? {}
    const entry: BPFlowEntry = {
      speech: speech.speech,
      team: speech.team,
      side: speech.side,
      args: speech.args.map(toBPFlowArg),
    }
    if (speech.team === 'CG' || speech.team === 'CO') {
      entry.isExtension = true
    }
    if (analysis.extensionSummary) {
      entry.extensionSummary = analysis.extensionSummary
    }
    if (analysis.knifeDetected) {
      entry.knifeDetected = true
      entry.knifeExplanation = analysis.knifeExplanation
    }
    return entry
  })

  console.log(`[flow-bp] Generated ${entries.length} flow entries in ${Date.now() - startMs}ms total`)

  return { format: 'bp', entries }
}