import type { FlowSheet, JudgingResult, WeighingAnalysis, ClashVerdict, DevilsAdvocatePosition, SpeakerScore, TeamFeedback } from './types.js'
import { llmChat } from './llm.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const speaksGuide = readFileSync(join(__dirname, '..', 'speaks-guide.md'), 'utf-8')

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

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: 'judge:weighing',
  })

  console.log('[judge] Step 1: Weighing analysis complete')
  return JSON.parse(response.content) as WeighingAnalysis
}

// Step 2: Clash evaluation based on weighing
async function evaluateClashes(flow: FlowSheet, topic: string, weighing: WeighingAnalysis): Promise<ClashVerdict[]> {
  const system = `You are an expert APDA debate judge. Given a flow sheet and weighing analysis, evaluate each clash point and determine who won it.

For each clash:
- Determine the winner (Government, Opposition, or Tie)
- Explain the reasoning (which args were stronger, what was dropped, which links were conceded)
- Note the key arguments that decided the clash

Use the weighing analysis to prioritize which arguments matter most within each clash.

Respond with ONLY valid JSON:
{
  "clashVerdicts": [
    {
      "clashName": "Name of the clash",
      "winner": "Government|Opposition|Tie",
      "reasoning": "2-4 sentences explaining who won and why",
      "keyArgs": ["Short descriptions of the decisive arguments"]
    }
  ]
}`

  const user = `Topic: ${topic}

Weighing analysis:
${JSON.stringify(weighing, null, 2)}

Flow sheet:
${flowToText(flow)}`

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: 'judge:clashes',
  })

  const parsed = JSON.parse(response.content) as { clashVerdicts: ClashVerdict[] }
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

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge:devils-advocate',
  })

  const parsed = JSON.parse(response.content) as { positions: DevilsAdvocatePosition[] }
  console.log(`[judge] Step 3: Generated ${parsed.positions.length} devil's advocate positions for ${losingSide}`)
  return parsed.positions
}

// Step 4: Write RFD that beats the devil's advocate positions
async function writeRFD(
  flow: FlowSheet,
  topic: string,
  weighing: WeighingAnalysis,
  clashVerdicts: ClashVerdict[],
  provisionalWinner: 'Government' | 'Opposition',
  devilsAdvocate: DevilsAdvocatePosition[],
): Promise<string> {
  const system = `You are an expert APDA debate judge writing the Reason for Decision (RFD).

The provisional winner is ${provisionalWinner}. Multiple devil's advocate positions have been raised arguing for the losing side. Your job is to write a clear, decisive RFD that:

1. States the winner and the core reason
2. Addresses EACH devil's advocate position — explain why the winner's case overcomes it
3. References specific clashes, arguments, and weighing from the round
4. Is concise but thorough (3-5 paragraphs)

Write in the voice of an experienced debate judge giving an oral RFD. Be direct and specific — reference actual arguments from the flow, not vague generalities.`

  const user = `Topic: ${topic}

Provisional winner: ${provisionalWinner}

Weighing analysis:
${JSON.stringify(weighing, null, 2)}

Clash verdicts:
${JSON.stringify(clashVerdicts, null, 2)}

Devil's advocate positions to overcome:
${devilsAdvocate.map((d, i) => `${i + 1}. [${d.label}] ${d.argument}\n   Why it could win: ${d.whyItCouldWin}`).join('\n\n')}

Flow sheet:
${flowToText(flow)}`

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    label: 'judge:rfd',
  })

  console.log('[judge] Step 4: RFD written')
  return response.content.trim()
}

// Step 5: Assign speaks and ranks
async function assignSpeaks(
  flow: FlowSheet,
  topic: string,
  clashVerdicts: ClashVerdict[],
  winner: 'Government' | 'Opposition',
  rfd: string,
): Promise<SpeakerScore[]> {
  const system = `You are an expert APDA debate judge assigning speaker scores and ranks.

Use this APDA Speaker Scale to assign scores:

${speaksGuide}

Rules:
- Scores are whole numbers from ~5 to ~45, with 25 being average
- Choose the LOWEST category the speech falls into (limited by weakest criterion)
- No "low-point wins" — the losing team's total speaks must be equal or lower than the winning team's total
- Ranks: 1 (best) to 4 (worst), one per speaker, no ties
- Evaluate each speaker on: warrant quality, impact quality, weighing quality, engagement, and argument quality

Evaluate each of the 6 speeches (PMC, LOC, MG, MO, LOR, PMR) based on their contributions in the flow sheet.

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
${rfd}

Clash verdicts:
${JSON.stringify(clashVerdicts, null, 2)}

Flow sheet:
${flowToText(flow)}`

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: 'judge:speaks',
  })

  const parsed = JSON.parse(response.content) as { scores: SpeakerScore[] }
  console.log(`[judge] Step 5: Assigned speaks: ${parsed.scores.map((s) => `${s.speech}=${s.score}(${s.rank})`).join(', ')}`)
  return parsed.scores
}

// Step 6: Generate per-team feedback
async function generateFeedback(
  flow: FlowSheet,
  clashVerdicts: ClashVerdict[],
  speakerScores: SpeakerScore[],
  winner: 'Government' | 'Opposition',
  rfd: string,
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
${rfd}

Clash verdicts:
${JSON.stringify(clashVerdicts, null, 2)}

Government speaker scores:
${govScores.map((s) => `${s.speech}: ${s.score} (rank ${s.rank})`).join(', ')}

Opposition speaker scores:
${oppScores.map((s) => `${s.speech}: ${s.score} (rank ${s.rank})`).join(', ')}

Flow sheet:
${flowToText(flow)}`

  const response = await llmChat({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge:feedback',
  })

  console.log('[judge] Step 6: Feedback generated')
  return JSON.parse(response.content) as { governmentTeam: TeamFeedback; oppositionTeam: TeamFeedback }
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
  const rfd = await writeRFD(flow, topic, weighing, clashVerdicts, provisionalWinner, devilsAdvocate)

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