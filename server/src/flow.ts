import type { SpeakerSegment, FlowSheet } from './types.js'
import { llmChat, LlmError } from './llm.js'

interface ExtractedArg {
  tag: string
  text: string
  components: { label: string; text: string }[]
}

async function extractArgsFromSpeech(segment: SpeakerSegment): Promise<ExtractedArg[]> {
  const speechLabel = segment.speaker.split(' ')[0]
  const side = segment.speaker.includes('Government') ? 'Government' : 'Opposition'

  const isReply = speechLabel === 'LOR' || speechLabel === 'PMR'

  const system = `You are an expert APDA debate flow recorder. You read a speech transcript and produce flow entries in the terse shorthand debaters actually use.

A good flow is DENSE and SHORT — not prose. Use bullet-point style. Capture the L3/L4 structure of each argument.

CRITICAL PRIORITIES:
1. LINKS and MECHANISMS are the most important part of a flow. The link is HOW the argument connects to the impact. The mechanism is the step-by-step causal chain. Flow these in detail — break them into sub-steps if needed. A weak or contested link is the whole ballgame. ${''}
   Example GOOD link flow: "LINK: ban → platforms exit market → less access → less harm"
   Example BAD link flow: "LINK: ban reduces social media use"
   If a speaker makes a mechanistic argument, break it into INTERNAL LINK steps: "IL1: ...", "IL2: ...", "IL3: ..."
2. WEIGHING must be flowed explicitly. When a speaker explains WHY their argument matters MORE than the other side's, capture it as a WEIGH component. Types of weighing:
   - SCOPE: "WEIGH: our impact affects 10x more people"
   - SEVERITY: "WEIGH: our impact is irreversible, theirs is fixable"
   - PROBABILITY: "WEIGH: our link is conceded, theirs is speculative"
   - TIMEFRAME: "WEIGH: our impact is happening now, theirs is 10 yrs out"
   - REVERSIBILITY: "WEIGH: our harm is permanent, theirs is temporary"
   - PREREQUISITE: "WEIGH: must win our case before theirs matters"
   Flow the TYPE and the COMPARISON in shorthand.
3. Tags (3-5 word labels), e.g. "T: plain text", "DA: Econ collapse", "Solvency deficit"
4. Components: UNIQUENESS, LINK, INTERNAL LINK (IL1/IL2/...), MECHANISM, IMPACT, EVIDENCE, ANALYSIS, RESPONSE, TURN, WEIGH, etc.
5. Each component = 1 line of shorthand, NOT full sentences. Abbreviate aggressively.
6. If the speaker responds to a prior argument, label it RESPONSE and note what it answers.
7. If a speaker CONCEDES or DROPs an argument, note it: "DROP: conceded LOC link"

${isReply
  ? `This is a REPLY speech (${speechLabel}). Reply speeches crystallize and weigh — they don't make new arguments. Focus on:
- Which clashes the speaker says they're winning and WHY
- Weighing comparisons (most important!)
- Crystallization: collapsing to their best 1-2 args
- Voters / why they win the round
Extract 2-5 args.`
  : `This is a constructive/rebuttal speech. Extract ALL arguments — aim for 4-10 args. Prioritize link/mech detail and weighing.`}

Respond with ONLY valid JSON:
{
  "args": [
    {
      "tag": "short tag (3-5 words)",
      "text": "1-line summary of the whole arg",
      "components": [
        { "label": "UNIQ", "text": "shorthand text" },
        { "label": "LINK", "text": "shorthand step-by-step mech" },
        { "label": "IL1", "text": "internal link step" },
        { "label": "IMPACT", "text": "shorthand text" },
        { "label": "WEIGH", "text": "scope: 10x more ppl affected" }
      ]
    }
  ]
}`

  const user = `Speech: ${speechLabel} (${side})

Transcript:
${segment.text}`

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
  })

  const parsed = JSON.parse(response.content) as { args: ExtractedArg[] }
  return parsed.args.map((a) => ({
    ...a,
    speech: speechLabel,
    side,
  })) as (ExtractedArg & { speech: string; side: string })[]
}

interface SpeechArgs {
  speech: string
  side: string
  args: ExtractedArg[]
}

async function clusterIntoClashes(speechArgs: SpeechArgs[]): Promise<FlowSheet> {
  const system = `You are an expert APDA debate flow sheet creator.

You are given flow entries (in shorthand) from each speech in a debate round. Group them into "clash points" — the key points of disagreement between Government and Opposition.

Clash names should be SHORT and descriptive (2-4 words), e.g. "Topicality", "Solvency", "DA: Economy", "Framework", "Counterplan competing".

For each clash, include all relevant flow entries from all speeches IN ORDER of speech (PMC, LOC, MG, MO, LOR, PMR). Each entry should preserve the original shorthand. If an arg is a response to a prior arg, note that in the text.

PRESERVE the link/mechanism detail and internal link steps. PRESERVE all WEIGH components — these are critical. Do NOT collapse or summarize them away.

Additionally, create a FINAL clash called "Weighing & Voters" that collects all weighing arguments from reply speeches (LOR, PMR) and any explicit weighing from other speeches. This is where the round is won or lost.

Keep the shorthand TERSE — do NOT expand it into prose. Preserve the component breakdown.

Respond with ONLY valid JSON:
{
  "clashes": [
    {
      "name": "Clash name (2-4 words)",
      "args": [
        {
          "speech": "PMC",
          "side": "Government",
          "tag": "short tag",
          "text": "1-line summary",
          "components": [
            { "label": "LINK", "text": "shorthand mech" },
            { "label": "IL1", "text": "internal link" },
            { "label": "IMPACT", "text": "shorthand" },
            { "label": "WEIGH", "text": "scope: 10x more" }
          ]
        }
      ]
    }
  ]
}`

  const user = `Here are the flow entries from each speech. Group them into clash points. Preserve ALL link/mech detail and weighing. Do NOT rewrite into prose.

${speechArgs
  .map((sa) => `### ${sa.speech} (${sa.side})\n${sa.args.map((a, i) => `${i + 1}. [${a.tag}] ${a.text}\n${a.components.map((c) => `   - ${c.label}: ${c.text}`).join('\n')}`).join('\n')}`)
  .join('\n\n')}`

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
  })

  return JSON.parse(response.content) as FlowSheet
}

export async function generateFlowSheet(segments: SpeakerSegment[]): Promise<FlowSheet> {
  const errors: string[] = []
  const speechArgs: SpeechArgs[] = []

  // Pass 1: Extract arguments from each speech in parallel
  const results = await Promise.allSettled(
    segments.map(async (seg) => {
      const args = await extractArgsFromSpeech(seg)
      const speechLabel = seg.speaker.split(' ')[0]
      const side = seg.speaker.includes('Government') ? 'Government' : 'Opposition'
      console.log(`[flow] Extracted ${args.length} args from ${speechLabel}`)
      return { speech: speechLabel, side, args } satisfies SpeechArgs
    }),
  )

  for (const result of results) {
    if (result.status === 'fulfilled') {
      speechArgs.push(result.value)
    } else {
      const err = result.reason
      // Propagate LlmError (token exhaustion, config) immediately
      if (err instanceof LlmError && (err.kind === 'token_exhausted' || err.kind === 'config')) throw err
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[flow] Failed to extract args: ${msg}`)
      errors.push(msg)
    }
  }

  if (speechArgs.length === 0) {
    const detail = errors.length > 0 ? errors.join('; ') : 'unknown'
    throw new Error(`All speeches failed to extract arguments. Errors: ${detail}`)
  }

  if (errors.length > 0) {
    console.warn(`[flow] ${errors.length} speech(es) failed, continuing with ${speechArgs.length} successful`)
  }

  console.log(`[flow] Clustering ${speechArgs.reduce((n, s) => n + s.args.length, 0)} args into clashes`)
  try {
    const flowSheet = await clusterIntoClashes(speechArgs)
    console.log(`[flow] Generated ${flowSheet.clashes.length} clashes`)
    return flowSheet
  } catch (err) {
    if (err instanceof LlmError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Clustering failed: ${msg}. ${speechArgs.length} speeches were successfully extracted.`)
  }
}