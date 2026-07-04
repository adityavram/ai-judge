/**
 * APDA debate round judging pipeline.
 *
 * 6-step parallel judging process:
 * 1. Weighing analysis — identify 2-4 key issues and overall framework
 * 2. Per-clash evaluation — parallel LLM calls, one per clash point
 * 3. Provisional winner — deterministic: side with more clash wins
 * 4. RFD + Devil's advocate — parallel LLM calls for structured decision and alternate paths
 * 5. Speaker scores — parallel LLM calls per debater (4 debaters, ranks reconciled)
 * 6. Per-team feedback — strengths, weaknesses, improvements
 *
 * APDA-specific rules enforced:
 * - Tech over truth: unanswered arguments stand as true
 * - MO/MG independent offense: new arguments are valid in constructive speeches
 * - PMR/LOR new arguments flagged and penalized, not credited
 * - No low-point wins: losing team total must be ≤ winning team
 * - Speaker scale calibrated: 25 average, 22-24 below avg, 29-32 excellent
 */

import type { FlowSheet, JudgingResult, WeighingAnalysis, ClashVerdict, DevilsAdvocatePosition, SpeakerScore, TeamFeedback, RFDSection, FlowClash } from './types.js'
import { llmJSON } from './llm.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const speaksGuide = readFileSync(join(__dirname, '..', 'speaks-guide.md'), 'utf-8')

const APDA_TECH_OVER_TRUTH = `APDA follows TECH OVER TRUTH: an argument made in a constructive speech (PMC, LOC, MG, MO) is treated as TRUE in later speeches unless it is directly answered by the opposing team. This means:
- If PMC makes a claim with ANY warrant, it is true in PMR unless LOC/MO answers it — even if the warrant is thin.
- If LOC makes a claim with any warrant, it is true in LOR unless PMC/MG answers it — even if the warrant is thin.
- "Under-substantiated" is NOT a valid reason to discount an argument that was never answered. If the other team didn't respond, the argument stands.
- The ONLY way to defeat an argument is to directly engage it. Ignoring it concedes it.
- Reply speeches (PMR, LOR) may crystallize and weigh existing arguments but may NOT introduce new ones.
- Evaluate arguments based on whether they were ANSWERED, not on how "well-substantiated" they are in isolation.

CRITICAL — INDEPENDENT OFFENSE:
- The MO and MG are constructive speeches. They may introduce NEW, INDEPENDENT arguments that are NOT responses to the other side's case. These are called "independent offense" or "independent arguments."
- An independent argument from the MO (e.g., a new disadvantage, a counter-plan, a new framing) is just as valid as a PMC case point. It does NOT need to be a response to Government arguments.
- When evaluating clashes, do NOT dismiss MO arguments just because they seem "new" — MO is a constructive speech and CAN introduce new arguments. Only PMR and LOR are restricted from new arguments.
- Similarly, MG can introduce new arguments that extend or add to the Government case.
- Independent offense from MO or MG must be weighed against the other side's case on its own merits, just like any other argument.`

// Default paradigm prompt — used when no paradigm is specified.
// This is the same as the "tech-over-truth" builtin paradigm.
export const DEFAULT_PARADIGM_PROMPT = APDA_TECH_OVER_TRUTH

function flowToText(flow: FlowSheet): string {
  return flow.clashes
    .map((clash) => {
      const args = clash.args
        .map((a) => `  [${a.speech} (${a.side})] ${a.tag}: ${a.text}\n${a.components.map((c) => `    - ${c.label}: ${c.text}`).join('\n')}`)
        .join('\n')
      return `### ${clash.name}\n${args}`
    })
    .join('\n\n')
}

function clashToText(clash: FlowClash): string {
  const args = clash.args
    .map((a) => `  [${a.speech} (${a.side})] ${a.tag}: ${a.text}\n${a.components.map((c) => `    - ${c.label}: ${c.text}`).join('\n')}`)
    .join('\n')
  return `### ${clash.name}\n${args}`
}

// Step 1: Weighing analysis
async function analyzeWeighing(flow: FlowSheet, topic: string, paradigmPrompt: string): Promise<WeighingAnalysis> {
  const system = `You are an expert APDA debate judge. You are given a flow sheet from a debate round. Your task is to analyze the weighing — what issues matter most in this round and why.

${paradigmPrompt}

Identify the 2-4 key issues that will decide this round. For each, explain:
- What the issue is
- How important it is relative to other issues
- Why it matters (what turns on this issue)

Also provide an overall framework for how the round should be evaluated.

Respond with ONLY valid JSON:
{
  "keyIssues": [
    {
      "name": "Issue name (2-4 words)",
      "importance": "high/medium/low",
      "whyItMatters": "1-2 sentences explaining what turns on this"
    }
  ],
  "overallFramework": "2-3 sentences on how to evaluate this round"
}`

  const user = `Topic: ${topic}

Flow sheet:
${flowToText(flow)}`

  const weighing = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: 'judge:weighing',
  }) as WeighingAnalysis

  console.log('[judge] Step 1: Weighing analysis complete')
  return weighing
}

// Step 2: Per-clash evaluation (parallel)
async function evaluateSingleClash(
  clash: FlowClash,
  topic: string,
  weighing: WeighingAnalysis,
  allClashNames: string[],
  paradigmPrompt: string,
): Promise<ClashVerdict> {
  const system = `You are an expert APDA debate judge. You are evaluating a SINGLE clash point from a debate round. You must determine who won this specific clash.

${paradigmPrompt}

Evaluate this clash independently. Other clashes in this round (${allClashNames.filter((n) => n !== clash.name).join(', ')}) are being evaluated separately — do NOT assume they all go the same way. It is COMMON for different clashes to be won by different sides.

For this clash:
- Determine the winner (Government, Opposition, or Tie)
- Explain the reasoning (which args were stronger, what was dropped, which links were conceded)
- Note the key arguments that decided the clash
- IMPORTANT: Identify any arguments from PMR or LOR that appear to be NEW (not referenced or foreshadowed in earlier speeches). In APDA, reply speeches may only crystallize and weigh — they may NOT introduce new arguments. Flag suspected new arguments as "newArgs" and discount them heavily in your evaluation.

Use the weighing analysis to understand which arguments matter most.

Respond with ONLY valid JSON:
{
  "clashName": "${clash.name}",
  "winner": "Government|Opposition|Tie",
  "reasoning": "2-4 sentences explaining who won this clash and why",
  "keyArgs": ["Short descriptions of the decisive arguments"],
  "newArgs": ["Any arguments from PMR/LOR that appear to be new (not foreshadowed in earlier speeches). Empty array if none suspected."]
}`

  const user = `Topic: ${topic}

Weighing analysis:
${JSON.stringify(weighing, null, 2)}

Clash to evaluate:
${clashToText(clash)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: `judge:clash:${clash.name}`,
  }) as ClashVerdict

  // Ensure the clash name matches
  parsed.clashName = clash.name
  return parsed
}

async function evaluateClashes(flow: FlowSheet, topic: string, weighing: WeighingAnalysis, paradigmPrompt: string): Promise<ClashVerdict[]> {
  const allClashNames = flow.clashes.map((c) => c.name)

  const verdicts = await Promise.all(
    flow.clashes.map((clash) => evaluateSingleClash(clash, topic, weighing, allClashNames, paradigmPrompt)),
  )

  console.log(`[judge] Step 2: Evaluated ${verdicts.length} clashes: ${verdicts.map((v) => `${v.clashName}→${v.winner}`).join(', ')}`)
  return verdicts
}

// Step 3: Determine provisional winner (deterministic)
function determineProvisionalWinner(clashVerdicts: ClashVerdict[]): 'Government' | 'Opposition' {
  const govWins = clashVerdicts.filter((c) => c.winner === 'Government').length
  const oppWins = clashVerdicts.filter((c) => c.winner === 'Opposition').length
  return govWins >= oppWins ? 'Government' : 'Opposition'
}

async function generateDevilsAdvocate(
  flow: FlowSheet,
  topic: string,
  weighing: WeighingAnalysis,
  clashVerdicts: ClashVerdict[],
  provisionalWinner: 'Government' | 'Opposition',
  paradigmPrompt: string,
): Promise<DevilsAdvocatePosition[]> {
  const losingSide = provisionalWinner === 'Government' ? 'Opposition' : 'Government'

  const system = `You are an expert APDA debate judge playing devil's advocate. The provisional winner is ${provisionalWinner}. Your job is to construct the STRONGEST possible case for ${losingSide} — 2-3 distinct paths to victory they could have won through.

${paradigmPrompt}

Each path should be a genuine, plausible argument for why ${losingSide} should actually win. Consider:
- Clashes they could have won with different framing
- Weighing they could have used to prioritize their arguments
- Drops by the winning side that could be exploited
- Alternative frameworks that favor ${losingSide}

Respond with ONLY valid JSON:
{
  "positions": [
    {
      "label": "Short name for this path to victory (3-5 words)",
      "side": "${losingSide}",
      "argument": "2-3 sentences on the core argument",
      "whyItCouldWin": "2-3 sentences on why this path could overcome the provisional verdict"
    }
  ]
}`

  const user = `Topic: ${topic}

Provisional winner: ${provisionalWinner}
Losing side: ${losingSide}

Weighing analysis:
${JSON.stringify(weighing, null, 2)}

Clash verdicts:
${JSON.stringify(clashVerdicts, null, 2)}

Flow sheet:
${flowToText(flow)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge:devils-advocate',
  }) as { positions: DevilsAdvocatePosition[] }
  console.log(`[judge] Step 3: Generated ${parsed.positions.length} devil's advocate positions for ${losingSide}`)
  return parsed.positions
}

// Step 4: Write structured RFD
async function writeRFD(
  flow: FlowSheet,
  topic: string,
  weighing: WeighingAnalysis,
  clashVerdicts: ClashVerdict[],
  provisionalWinner: 'Government' | 'Opposition',
  paradigmPrompt: string,
): Promise<RFDSection> {
  const losingSide = provisionalWinner === 'Government' ? 'Opposition' : 'Government'

  const system = `You are an expert APDA debate judge writing the Reason for Decision (RFD).

${paradigmPrompt}

The winner is ${provisionalWinner}. Write a structured RFD with exactly these 4 sections. Do NOT repeat devil's advocate arguments — those are shown separately. Focus on YOUR decision and why you reached it.

Sections:
1. "weighing": What is the winning team's weighing in this round? What metric/scope did they win on? (2-3 sentences)
2. "weighingComparison": You MUST explicitly identify the losing team's (${losingSide}'s) weighing — what metric/scope did they argue should decide the round? — and then explain why ${provisionalWinner}'s weighing comes first. Address the competing weighing directly: why does ${provisionalWinner}'s framing outweigh ${losingSide}'s framing? (2-4 sentences)
3. "whyWinnerWon": Why did ${provisionalWinner} win this round? The core thesis of the decision. (2-3 sentences, be specific about key arguments)
4. "linkByLink": For each clash that ${provisionalWinner} won, briefly explain which links held and which ${losingSide} links fell. If ${losingSide} won any clashes, explain why those weren't enough to win the round. (1-2 sentences per clash)

IMPORTANT RULES FOR REPLY SPEECHES (PMR and LOR):
- In APDA, reply speeches may ONLY crystallize, weigh, and summarize. They may NOT introduce new arguments.
- If clash verdicts flagged NEW arguments from PMR or LOR, call them out in the relevant section.
- New arguments from reply speeches should be discounted — they are not legitimate grounds for winning.
- Credit prior speeches for arguments they actually made, but be skeptical of reply speeches claiming credit for arguments that weren't clearly articulated earlier.

Be direct and specific — reference actual arguments from the flow, not vague generalities.

Respond with ONLY valid JSON:
{
  "weighing": "...",
  "weighingComparison": "...",
  "whyWinnerWon": "...",
  "linkByLink": "..."
}`

  const user = `Topic: ${topic}
Winner: ${provisionalWinner}
Losing side: ${losingSide}

Weighing analysis:
${JSON.stringify(weighing, null, 2)}

Clash verdicts:
${JSON.stringify(clashVerdicts, null, 2)}

Flow sheet:
${flowToText(flow)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge:rfd',
  }) as RFDSection

  console.log('[judge] Step 4: RFD written')
  return parsed
}

// Step 5: Per-debater speaker scores (parallel)
const DEBATER_SPEECHES: Record<string, string[]> = {
  'Prime Minister': ['PMC', 'PMR'],
  'Leader of Opposition': ['LOC', 'LOR'],
  'Member of Government': ['MG'],
  'Member of Opposition': ['MO'],
}

async function scoreDebater(
  debaterName: string,
  speeches: string[],
  flow: FlowSheet,
  topic: string,
  clashVerdicts: ClashVerdict[],
  winner: 'Government' | 'Opposition',
  rfd: RFDSection,
  paradigmPrompt: string,
): Promise<SpeakerScore[]> {
  const side = speeches[0] === 'PMC' || speeches[0] === 'MG' || speeches[0] === 'PMR'
    ? 'Government'
    : speeches[0] === 'LOC' || speeches[0] === 'MO' || speeches[0] === 'LOR'
      ? 'Opposition'
      : 'Unknown'

  const isReplyDebater = speeches.includes('PMR') || speeches.includes('LOR')

  // Extract this debater's arguments from the flow
  const debaterArgs = flow.clashes
    .map((clash) => clash.args.filter((a) => speeches.includes(a.speech)))
    .flat()

  const argsText = debaterArgs.length > 0
    ? debaterArgs.map((a) => `[${a.speech}] ${a.tag}: ${a.text}`).join('\n')
    : 'No arguments found for this debater in the flow.'

  const system = `You are an expert APDA debate judge assigning speaker scores and ranks for a SINGLE debater.

${paradigmPrompt}

APDA Speaker Scale Reference:
${speaksGuide}

PRACTICAL CALIBRATION — The written scale is aspirational. In real APDA practice:
- 25 is a solid, truly average speech. A competent debater who does everything right but nothing exceptional gets a 25.
- 22-24 is below average — the debater made noticeable errors or was noticeably weaker.
- 20-21 is poor — significant errors, major drops, weak argumentation. Below 20 is reserved for genuinely insulting or destructive speeches.
- 26-28 is above average — strong engagement, good weighing, clear argumentation.
- 29-32 is excellent — near-decisive warranting, crisp weighing, strong all-around performance.
- 33+ is exceptional — debate-changing performance, near-perfect execution.

DO NOT give scores below 18 unless the speech was actively harmful or offensive. Most scores should fall between 22 and 30.

You are scoring: ${debaterName} (${side}), who gave these speeches: ${speeches.join(', ')}.
${isReplyDebater ? 'This debater gave a reply speech (PMR or LOR). Reply speeches should be evaluated on crystallization, weighing, and voter identification — NOT on new argumentation. If they introduced new arguments, that is a NEGATIVE.' : ''}

Rules:
- Score each speech individually on the APDA scale
- This debater gets a SINGLE rank (shared across their speeches). You will assign it here — other debaters are being scored separately, and ranks will be reconciled afterward.
- For now, assign a tentative rank from 1-4 based on this debater's performance relative to an average debater (1=best, 4=worst). The final ranks will be adjusted to ensure no ties.
- Evaluate each speech on: warrant quality, impact quality, weighing quality, engagement, and argument quality
- No "low-point wins" — but since you're only scoring one debater, just score fairly

Respond with ONLY valid JSON:
{
  "scores": [
    ${speeches.map((s) => `{
      "speech": "${s}",
      "speaker": "${debaterName}",
      "side": "${side}",
      "score": 25,
      "rank": 1,
      "warrant": "Brief assessment of warrant quality",
      "impact": "Brief assessment of impact quality",
      "weighing": "Brief assessment of weighing quality",
      "engagement": "Brief assessment of engagement",
      "argumentQuality": "Brief assessment of argument quality",
      "justification": "1-2 sentences on why this score and rank"
    }`).join(',\n    ')}
  ]
}`

  const user = `Topic: ${topic}
Winner: ${winner}
Debater: ${debaterName} (${side}), speeches: ${speeches.join(', ')}

RFD:
Weighing: ${rfd.weighing}
Why this weighing outweighs: ${rfd.weighingComparison}
Why ${winner} won: ${rfd.whyWinnerWon}
Link-by-link: ${rfd.linkByLink}

Relevant clash verdicts:
${JSON.stringify(clashVerdicts, null, 2)}

This debater's arguments from the flow:
${argsText}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: `judge:speaks:${debaterName}`,
  }) as { scores: SpeakerScore[] }

  console.log(`[judge] Step 5: Scored ${debaterName}: ${parsed.scores.map((s) => `${s.speech}=${s.score}`).join(', ')}`)
  return parsed.scores
}

async function assignSpeaks(
  flow: FlowSheet,
  topic: string,
  clashVerdicts: ClashVerdict[],
  winner: 'Government' | 'Opposition',
  rfd: RFDSection,
  paradigmPrompt: string,
): Promise<SpeakerScore[]> {
  const debaterEntries = Object.entries(DEBATER_SPEECHES)

  const results = await Promise.all(
    debaterEntries.map(([name, speeches]) =>
      scoreDebater(name, speeches, flow, topic, clashVerdicts, winner, rfd, paradigmPrompt),
    ),
  )

  const allScores = results.flat()
  return fixupRanks(allScores)
}

function fixupRanks(scores: SpeakerScore[]): SpeakerScore[] {
  if (scores.length !== 6) return scores

  // Map speeches to debaters: PMC+PMR = PM, LOC+LOR = LO, MG = MG, MO = MO
  const debaterMap: Record<string, string> = {
    PMC: 'Prime Minister', PMR: 'Prime Minister',
    LOC: 'Leader of Opposition', LOR: 'Leader of Opposition',
    MG: 'Member of Government',
    MO: 'Member of Opposition',
  }

  // Get the 4 debaters and their best score (use max of their two speeches)
  const debaterBestScore = new Map<string, number>()
  for (const s of scores) {
    const debater = debaterMap[s.speech] ?? s.speaker
    const current = debaterBestScore.get(debater) ?? -1
    debaterBestScore.set(debater, Math.max(current, s.score))
  }

  // Check if ranks are already valid (4 distinct ranks 1-4 across debaters)
  const debaterRanks = new Map<string, number>()
  for (const s of scores) {
    const debater = debaterMap[s.speech] ?? s.speaker
    debaterRanks.set(debater, s.rank)
  }
  const sortedRanks = [...new Set(debaterRanks.values())].sort((a, b) => a - b)
  const isValid = sortedRanks.length === 4 && sortedRanks.every((r, i) => r === i + 1)

  if (isValid) return scores

  // Fix: sort debaters by best score descending, assign ranks 1-4
  console.warn(`[judge] Fixing invalid ranks: ${sortedRanks.join(',')} → reassigning by score`)
  const sortedDebaters = [...debaterBestScore.entries()].sort((a, b) => b[1] - a[1])
  const newRanks = new Map<string, number>()
  sortedDebaters.forEach(([, ], i) => {
    const debater = sortedDebaters[i][0]
    newRanks.set(debater, i + 1)
  })

  // Apply ranks to all speeches
  for (const s of scores) {
    const debater = debaterMap[s.speech] ?? s.speaker
    s.rank = newRanks.get(debater) ?? s.rank
  }

  return scores
}

// Step 6: Generate per-team feedback
async function generateFeedback(
  flow: FlowSheet,
  clashVerdicts: ClashVerdict[],
  speakerScores: SpeakerScore[],
  winner: 'Government' | 'Opposition',
  rfd: RFDSection,
  paradigmPrompt: string,
): Promise<{ governmentTeam: TeamFeedback; oppositionTeam: TeamFeedback }> {
  const govScores = speakerScores.filter((s) => s.side === 'Government')
  const oppScores = speakerScores.filter((s) => s.side === 'Opposition')

  const system = `You are an expert APDA debate judge giving feedback to debaters. Provide constructive, specific feedback for each team.

${paradigmPrompt}

For each team:
- Strengths: 2-4 specific things they did well (reference actual arguments)
- Weaknesses: 2-4 specific things they could improve (reference dropped args, weak links, etc.)
- Improvements: 2-4 actionable suggestions for future rounds

Respond with ONLY valid JSON:
{
  "governmentTeam": {
    "side": "Government",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "improvements": ["..."]
  },
  "oppositionTeam": {
    "side": "Opposition",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "improvements": ["..."]
  }
}`

  const user = `Winner: ${winner}

RFD:
Weighing: ${rfd.weighing}
Why this weighing outweighs: ${rfd.weighingComparison}
Why ${winner} won: ${rfd.whyWinnerWon}
Link-by-link: ${rfd.linkByLink}

Clash verdicts:
${JSON.stringify(clashVerdicts, null, 2)}

Government speaker scores:
${govScores.map((s) => `${s.speech}: ${s.score} (rank ${s.rank})`).join(', ')}

Opposition speaker scores:
${oppScores.map((s) => `${s.speech}: ${s.score} (rank ${s.rank})`).join(', ')}

Flow sheet:
${flowToText(flow)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge:feedback',
  }) as { governmentTeam: TeamFeedback; oppositionTeam: TeamFeedback }

  console.log('[judge] Step 6: Feedback generated')
  return parsed
}

export async function judgeRound(flow: FlowSheet, topic: string, paradigmPrompt: string): Promise<JudgingResult> {
  const startMs = Date.now()
  console.log('[judge] Starting judging pipeline...')

  // Step 1: Weighing analysis
  const weighing = await analyzeWeighing(flow, topic, paradigmPrompt)

  // Step 2: Per-clash evaluation (parallel)
  const clashVerdicts = await evaluateClashes(flow, topic, weighing, paradigmPrompt)

  // Step 3: Determine provisional winner (deterministic), then devil's advocate
  const provisionalWinner = determineProvisionalWinner(clashVerdicts)
  console.log(`[judge] Step 3: Provisional winner: ${provisionalWinner}`)

  // Step 4 & 5 can run in parallel with devil's advocate
  const [devilsAdvocate, rfd] = await Promise.all([
    generateDevilsAdvocate(flow, topic, weighing, clashVerdicts, provisionalWinner, paradigmPrompt),
    writeRFD(flow, topic, weighing, clashVerdicts, provisionalWinner, paradigmPrompt),
  ])

  // Step 5: Per-debater speaker scores (parallel)
  const speakerScores = await assignSpeaks(flow, topic, clashVerdicts, provisionalWinner, rfd, paradigmPrompt)

  // Step 6: Generate feedback
  const { governmentTeam, oppositionTeam } = await generateFeedback(flow, clashVerdicts, speakerScores, provisionalWinner, rfd, paradigmPrompt)

  console.log(`[judge] Complete. Winner: ${provisionalWinner}. Total: ${Date.now() - startMs}ms`)

  return {
    winner: provisionalWinner,
    topic,
    weighing,
    clashVerdicts,
    devilsAdvocatePositions: devilsAdvocate,
    rfd,
    speakerScores,
    governmentTeam,
    oppositionTeam,
  }
}