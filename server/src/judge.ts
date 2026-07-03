import type { FlowSheet, JudgingResult, WeighingAnalysis, ClashVerdict, DevilsAdvocatePosition, SpeakerScore, TeamFeedback, RFDSection } from './types.js'
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
- Evaluate arguments based on whether they were ANSWERED, not on how "well-substantiated" they are in isolation.`

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

// Step 1: Weighing analysis
async function analyzeWeighing(flow: FlowSheet, topic: string): Promise<WeighingAnalysis> {
  const system = `You are an expert APDA debate judge. You are given a flow sheet from a debate round. Your task is to analyze the weighing — what issues matter most in this round and why.

${APDA_TECH_OVER_TRUTH}

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

// Step 2: Clash evaluation based on weighing
async function evaluateClashes(flow: FlowSheet, topic: string, weighing: WeighingAnalysis): Promise<ClashVerdict[]> {
  const system = `You are an expert APDA debate judge. Given a flow sheet and weighing analysis, evaluate each clash point and determine who won it.

${APDA_TECH_OVER_TRUTH}

For each clash:
- Determine the winner (Government, Opposition, or Tie)
- Explain the reasoning (which args were stronger, what was dropped, which links were conceded)
- Note the key arguments that decided the clash
- IMPORTANT: Identify any arguments from PMR or LOR that appear to be NEW (not referenced or foreshadowed in earlier speeches). In APDA, reply speeches may only crystallize and weigh — they may NOT introduce new arguments. Flag suspected new arguments as "newArgs" and discount them heavily in your evaluation.

CRITICAL: Evaluate EACH clash independently on its own merits. It is COMMON and EXPECTED for different clashes to be won by different sides. A round is not a sweep — most rounds have clashes on both sides. Do NOT default to giving all clashes to the same team. If the Opposition won a clash on their own terms, say so. If the Government won a clash on their own terms, say so. Ties are also valid when neither side clearly wins.

Use the weighing analysis to prioritize which arguments matter most within each clash.

Respond with ONLY valid JSON:
{
  "clashVerdicts": [
    {
      "clashName": "Name of the clash",
      "winner": "Government|Opposition|Tie",
      "reasoning": "2-4 sentences explaining who won and why",
      "keyArgs": ["Short descriptions of the decisive arguments"],
      "newArgs": ["Any arguments from PMR/LOR that appear to be new (not foreshadowed in earlier speeches). Empty array if none suspected."]
    }
  ]
}`

  const user = `Topic: ${topic}

Weighing analysis:
${JSON.stringify(weighing, null, 2)}

Flow sheet:
${flowToText(flow)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: 'judge:clashes',
  }) as { clashVerdicts: ClashVerdict[] }
  console.log(`[judge] Step 2: Evaluated ${parsed.clashVerdicts.length} clashes`)
  return parsed.clashVerdicts
}

// Step 3: Determine provisional winner, then generate devil's advocate positions
async function determineProvisionalWinner(clashVerdicts: ClashVerdict[]): Promise<'Government' | 'Opposition'> {
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
): Promise<DevilsAdvocatePosition[]> {
  const losingSide = provisionalWinner === 'Government' ? 'Opposition' : 'Government'

  const system = `You are an expert APDA debate judge playing devil's advocate. The provisional winner is ${provisionalWinner}. Your job is to construct the STRONGEST possible case for ${losingSide} — 2-3 distinct paths to victory they could have won through.

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
): Promise<RFDSection> {
  const losingSide = provisionalWinner === 'Government' ? 'Opposition' : 'Government'

  const system = `You are an expert APDA debate judge writing the Reason for Decision (RFD).

${APDA_TECH_OVER_TRUTH}

The winner is ${provisionalWinner}. Write a structured RFD with exactly these 4 sections. Do NOT repeat devil's advocate arguments — those are shown separately. Focus on YOUR decision and why you reached it.

Sections:
1. "weighing": What is the winning team's weighing in this round? What metric/scope did they win on? (2-3 sentences)
2. "weighingComparison": Why does the winning team's weighing matter more than the losing team's weighing? How did the winning team out-weigh? (2-3 sentences)
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

// Step 5: Assign speaks and ranks
async function assignSpeaks(
  flow: FlowSheet,
  topic: string,
  clashVerdicts: ClashVerdict[],
  winner: 'Government' | 'Opposition',
  rfd: RFDSection,
): Promise<SpeakerScore[]> {
  const system = `You are an expert APDA debate judge assigning speaker scores and ranks.

${APDA_TECH_OVER_TRUTH}

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

Rules:
- Scores are whole numbers from ~5 to ~45, with 25 being average
- Choose the LOWEST category the speech falls into (limited by weakest criterion)
- No "low-point wins" — the losing team's total speaks must be equal or lower than the winning team's total
- There are 4 debaters who each give 2 speeches. Score each of the 6 speeches individually, but assign RANKS to the 4 DEBATERS (not speeches):
  - Prime Minister (PMC + PMR) = 1 debater
  - Leader of Opposition (LOC + LOR) = 1 debater
  - Member of Government (MG) = 1 debater
  - Member of Opposition (MO) = 1 debater
- Ranks: 1 (best) to 4 (worst). CRITICAL: ranks MUST be a permutation of {1, 2, 3, 4} — each DEBATER gets a DISTINCT rank, no ties, no gaps, no repeats. A debater's two speeches share the same rank (e.g., if PM is rank 1, both PMC and PMR get rank 1). Determine the debater's rank based on their combined contribution across both speeches.
- Evaluate each speaker on: warrant quality, impact quality, weighing quality, engagement, and argument quality
- IMPORTANT: PMR and LOR are reply speeches. They should be evaluated on crystallization, weighing, and voter identification — NOT on new argumentation. If a reply speech introduces new arguments, this is a negative, not a positive. Penalize reply speeches that make new arguments rather than crystallizing existing ones.
- If any clash verdicts flagged "newArgs" from PMR or LOR, those new arguments should LOWER the reply speaker's score, not raise it.

Evaluate each of the 6 speeches (PMC, LOC, MG, MO, LOR, PMR) based on their contributions in the flow sheet. Each speech gets its own score, but the two speeches by the same debater share a rank.

Respond with ONLY valid JSON:
{
  "scores": [
    {
      "speech": "PMC",
      "speaker": "Prime Minister",
      "side": "Government",
      "score": 25,
      "rank": 1,
      "warrant": "Brief assessment of warrant quality",
      "impact": "Brief assessment of impact quality",
      "weighing": "Brief assessment of weighing quality",
      "engagement": "Brief assessment of engagement",
      "argumentQuality": "Brief assessment of argument quality",
      "justification": "1-2 sentences on why this score and rank"
    }
  ]
}`

  const user = `Topic: ${topic}
Winner: ${winner}

RFD:
Weighing: ${rfd.weighing}
Why this weighing outweighs: ${rfd.weighingComparison}
Why ${winner} won: ${rfd.whyWinnerWon}
Link-by-link: ${rfd.linkByLink}

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
    temperature: 0.2,
    label: 'judge:speaks',
  }) as { scores: SpeakerScore[] }
  const scores = fixupRanks(parsed.scores)
  console.log(`[judge] Step 5: Assigned speaks: ${scores.map((s) => `${s.speech}=${s.score}(${s.rank})`).join(', ')}`)
  return scores
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
): Promise<{ governmentTeam: TeamFeedback; oppositionTeam: TeamFeedback }> {
  const govScores = speakerScores.filter((s) => s.side === 'Government')
  const oppScores = speakerScores.filter((s) => s.side === 'Opposition')

  const system = `You are an expert APDA debate judge giving feedback to debaters. Provide constructive, specific feedback for each team.

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

export async function judgeRound(flow: FlowSheet, topic: string): Promise<JudgingResult> {
  const startMs = Date.now()
  console.log('[judge] Starting judging pipeline...')

  // Step 1: Weighing analysis
  const weighing = await analyzeWeighing(flow, topic)

  // Step 2: Clash evaluation
  const clashVerdicts = await evaluateClashes(flow, topic, weighing)

  // Step 3: Determine provisional winner, then devil's advocate
  const provisionalWinner = await determineProvisionalWinner(clashVerdicts)
  const devilsAdvocate = await generateDevilsAdvocate(flow, topic, weighing, clashVerdicts, provisionalWinner)

  // Step 4: Write RFD
  const rfd = await writeRFD(flow, topic, weighing, clashVerdicts, provisionalWinner)

  // Step 5: Assign speaks
  const speakerScores = await assignSpeaks(flow, topic, clashVerdicts, provisionalWinner, rfd)

  // Step 6: Generate feedback
  const { governmentTeam, oppositionTeam } = await generateFeedback(flow, clashVerdicts, speakerScores, provisionalWinner, rfd)

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