/**
 * British Parliamentary debate round judging pipeline.
 *
 * 6-step parallel judging process:
 * 1. Relative contribution analysis — identify key issues and which team contributed most
 * 2. Extension analysis (BP-specific) — did CG/CO extend from OG/OO? Did they knife?
 * 3. Team ranking — rank 4 teams 1st-4th with reasoning
 * 4. RFD + Devil's advocate — parallel calls for structured decision and alternate paths
 * 5. Speaker scores — parallel LLM calls per debater (8 speakers, WUDC scale)
 * 6. Per-team feedback — 4 teams, each with strengths/weaknesses/improvements
 *
 * BP-specific rules enforced:
 * - 4 teams compete: OG, OO, CG, CO — ranked 1st through 4th
 * - Opening teams set up the debate; closing teams must extend
 * - Closing teams that contradict their opening (knifing) are penalized
 * - Whip speeches (GW, OW) cannot introduce new arguments
 * - Teams ranked on relative contribution, not binary win/loss
 * - No "low-point wins" — speaker points don't determine ranking, but higher-ranked
 *   teams should generally have better speaker points as a sanity check
 */

import type { BPFlowSheet, BPFlowEntry, TeamFeedback, BPTeam, BPTeamRanking, BPExtensionAnalysis, BPRFDSection, BPDevilsAdvocatePosition, BPSpeakerScore, BPJudgingResult } from './types.js'
import { llmJSON } from './llm.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const speaksGuideBP = readFileSync(join(__dirname, '..', 'speaks-guide-bp.md'), 'utf-8')

const BP_DEBATERS: Record<string, { speeches: string[]; team: BPTeam; side: string }> = {
  'Prime Minister': { speeches: ['PM'], team: 'OG', side: 'Government' },
  'Deputy Prime Minister': { speeches: ['DPM'], team: 'OG', side: 'Government' },
  'Leader of Opposition': { speeches: ['LO'], team: 'OO', side: 'Opposition' },
  'Deputy Leader of Opposition': { speeches: ['DLO'], team: 'OO', side: 'Opposition' },
  'Member of Government': { speeches: ['MG'], team: 'CG', side: 'Government' },
  'Government Whip': { speeches: ['GW'], team: 'CG', side: 'Government' },
  'Member of Opposition': { speeches: ['MO'], team: 'CO', side: 'Opposition' },
  'Opposition Whip': { speeches: ['OW'], team: 'CO', side: 'Opposition' },
}

const BP_PARADIGM_CONTEXT = `BRITISH PARLIAMENTARY RULES — These are always true regardless of paradigm:
- 4 teams compete: Opening Government (OG), Opening Opposition (OO), Closing Government (CG), Closing Opposition (CO)
- Teams are ranked 1st through 4th based on RELATIVE CONTRIBUTION to the debate
- Opening teams (OG, OO) set up the debate with their case construction and initial arguments
- Closing teams (CG, CO) must EXTEND — bring new material that differentiates them from their opening team
- Closing teams that contradict their opening team (knifing) take a strategic risk — soft or minor knifing is often forgiven if the team otherwise contributed well, but direct contradictions that undermine the opening's core case should be penalized
- Whip speeches (GW, OW) may NOT introduce new arguments — they crystallize, weigh, and summarize
- New arguments in whip speeches should be disregarded and penalized in scoring
- There is no "low-point wins" rule in the traditional sense, but speaker points serve as a sanity check: teams ranked higher should generally have better combined speaker points
- Relative comparison between ALL FOUR teams is essential — this is not a binary win/loss
- Ranking is determined by PAIRWISE IMPACT WEIGHING: compare teams head-to-head on each key issue. The team that proves the larger, more probable, or more important impact wins that clash. Having an extension does NOT automatically outrank an opening team — CG must prove their extension has bigger impacts than OO's case, and vice versa for all pairwise matchups
- Opening teams (OG, OO) often present the most germane arguments to the motion — their arguments are first-principled and directly responsive to the topic. Do not overcredit closing teams just because they do explicit "weighing" or "framing" — explicit weighing language does not make an impact bigger. What matters is whether the impact IS bigger, not whether a debater says it is`

function bpFlowToText(flow: BPFlowSheet): string {
  return flow.entries
    .map((entry) => {
      const args = entry.args
        .map((a) => `  [${entry.speech} (${entry.team}/${entry.side})] ${a.tag}: ${a.text}\n${a.components.map((c) => `    - ${c.label}: ${c.text}`).join('\n')}${a.isExtension ? ' [EXTENSION]' : ''}${a.isNewInWhip ? ' [NEW IN WHIP]' : ''}${a.respondsTo ? ` [responds to: ${a.respondsTo}]` : ''}`)
        .join('\n')
      let header = `### ${entry.speech} (${entry.team}/${entry.side})`
      if (entry.isExtension) header += ' — EXTENSION SPEECH'
      if (entry.knifeDetected) header += ' — ⚠ KNIFE DETECTED (consider severity; minor knifing is often forgiven)'
      if (entry.extensionSummary) header += `\n   Extension summary: ${entry.extensionSummary}`
      if (entry.knifeExplanation) header += `\n   Knife explanation: ${entry.knifeExplanation}`
      return `${header}\n${args}`
    })
    .join('\n\n')
}

function entryToText(entry: BPFlowEntry): string {
  const args = entry.args
    .map((a) => `  [${entry.speech} (${entry.team}/${entry.side})] ${a.tag}: ${a.text}\n${a.components.map((c) => `    - ${c.label}: ${c.text}`).join('\n')}${a.isExtension ? ' [EXTENSION]' : ''}${a.isNewInWhip ? ' [NEW IN WHIP]' : ''}${a.respondsTo ? ` [responds to: ${a.respondsTo}]` : ''}`)
    .join('\n')
  let header = `### ${entry.speech} (${entry.team}/${entry.side})`
  if (entry.isExtension) header += ' — EXTENSION SPEECH'
  if (entry.knifeDetected) header += ' — ⚠ KNIFE DETECTED (consider severity; minor knifing is often forgiven)'
  if (entry.extensionSummary) header += `\n   Extension summary: ${entry.extensionSummary}`
  if (entry.knifeExplanation) header += `\n   Knife explanation: ${entry.knifeExplanation}`
  return `${header}\n${args}`
}

// Step 1: Relative Contribution Analysis
async function analyzeRelativeContribution(flow: BPFlowSheet, topic: string, paradigmPrompt: string): Promise<{
  keyIssues: { name: string; importance: string; whyItMatters: string; leadingTeam: string }[]
  overallFramework: string
  relativeContributions: { team: BPTeam; contribution: string; strengths: string; weaknesses: string }[]
}> {
  const system = `You are an expert British Parliamentary debate judge. You are given a flow sheet from a BP debate round. Your task is to analyze the RELATIVE CONTRIBUTION of each team — which team contributed most to the debate?

${BP_PARADIGM_CONTEXT}

${paradigmPrompt}

Identify the 2-4 key issues that will decide this round. For each, explain:
- What the issue is
- How important it is relative to other issues
- Why it matters (what turns on this issue)
- Which team is leading on this issue based on IMPACT WEIGHING — which team proved the bigger, more probable, or more important impact on this issue?

Then assess each team's relative contribution:
- What did each team contribute to the debate?
- What were their key strengths?
- What were their key weaknesses?
- How do their impacts compare pairwise against other teams?

Provide an overall framework for how this round should be evaluated across all 4 teams.

Respond with ONLY valid JSON:
{
  "keyIssues": [
    {
      "name": "Issue name (2-4 words)",
      "importance": "high/medium/low",
      "whyItMatters": "1-2 sentences explaining what turns on this",
      "leadingTeam": "OG/OO/CG/CO"
    }
  ],
  "overallFramework": "2-3 sentences on how to evaluate this round across all 4 teams",
  "relativeContributions": [
    {
      "team": "OG/OO/CG/CO",
      "contribution": "2-3 sentences on what this team contributed",
      "strengths": "1-2 sentences on their key strengths",
      "weaknesses": "1-2 sentences on their key weaknesses"
    }
  ]
}`

  const user = `Topic: ${topic}

Flow sheet:
${bpFlowToText(flow)}`

  const result = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: 'judge-bp:relative-contribution',
  }) as { keyIssues: { name: string; importance: string; whyItMatters: string; leadingTeam: string }[]; overallFramework: string; relativeContributions: { team: BPTeam; contribution: string; strengths: string; weaknesses: string }[] }

  console.log('[judge-bp] Step 1: Relative contribution analysis complete')
  return result
}

// Step 2: Extension Analysis (BP-specific, for CG and CO)
async function analyzeExtensions(flow: BPFlowSheet, topic: string, paradigmPrompt: string): Promise<BPExtensionAnalysis[]> {
  const closingEntries = flow.entries.filter((e) => e.team === 'CG' || e.team === 'CO')

  const system = `You are an expert British Parliamentary debate judge analyzing EXTENSIONS in a BP round.

${BP_PARADIGM_CONTEXT}

${paradigmPrompt}

In BP, closing teams (CG and CO) MUST extend from their opening team's case. An extension is new, distinctive material that adds value beyond what the opening team established. A closing team that simply repeats or re-explains their opening's arguments has NOT extended.

KNIFING occurs when a closing team contradicts or undercuts their opening team's arguments. This is heavily penalized.

For each closing team, analyze:
1. Did they extend? What was their extension?
2. Did the extension genuinely differentiate from the opening team?
3. Did they knife (contradict) their opening team? How? Note: minor or soft knifing — where a closing team takes a slightly different angle that doesn't undermine the opening's core case — is common and often forgiven. Only flag as knifing if the closing team directly contradicts or undercuts the opening's central thesis.

Respond with ONLY valid JSON:
{
  "analyses": [
    {
      "team": "CG/CO",
      "hasExtension": true/false,
      "extensionSummary": "2-3 sentences describing the extension (or why there isn't one)",
      "differentiatedFromOpening": true/false,
      "knifeDetected": true/false,
      "knifeExplanation": "If knifing detected, explain how they contradicted their opening and whether it undermines the opening's core case or is a minor soft knife. If no knifing, explain why they are consistent."
    }
  ]
}`

  const user = `Topic: ${topic}

Closing team entries from the flow:
${closingEntries.map((e) => entryToText(e)).join('\n\n')}

Opening team entries for reference:
${flow.entries.filter((e) => e.team === 'OG' || e.team === 'OO').map((e) => entryToText(e)).join('\n\n')}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: 'judge-bp:extension-analysis',
  }) as { analyses: BPExtensionAnalysis[] }

  console.log(`[judge-bp] Step 2: Extension analysis complete — CG: ${parsed.analyses.find((a) => a.team === 'CG')?.hasExtension ? 'has extension' : 'no extension'}, CO: ${parsed.analyses.find((a) => a.team === 'CO')?.hasExtension ? 'has extension' : 'no extension'}`)
  return parsed.analyses
}

// Step 3: Team Ranking
async function rankTeams(
  flow: BPFlowSheet,
  topic: string,
  relativeContribution: Awaited<ReturnType<typeof analyzeRelativeContribution>>,
  extensionAnalysis: BPExtensionAnalysis[],
  paradigmPrompt: string,
): Promise<BPTeamRanking[]> {
  const system = `You are an expert British Parliamentary debate judge ranking 4 teams from 1st to 4th.

${BP_PARADIGM_CONTEXT}

${paradigmPrompt}

Rank all 4 teams (OG, OO, CG, CO) from 1st (best) to 4th (worst) based on their RELATIVE CONTRIBUTION to the debate. Consider:
- Which team contributed most to the debate's progression?
- Which team's arguments were most persuasive and well-developed?
- How do the extensions affect CG and CO's rankings?
- Were there any knifing issues? Consider severity — minor knifing that doesn't undermine the opening's core case is often forgiven, while direct contradictions should be penalized
- Did any whip speeches introduce new arguments (which should be penalized)?

CRITICAL — PAIRWISE IMPACT WEIGHING:
Rankings are determined by comparing teams head-to-head on the key issues of the round. For each clash, ask: which team proved the bigger impact? Which team's mechanisms are stronger and more probable? The team that wins the most important clashes on impact weighing ranks higher.

IMPORTANT: Having an extension does NOT automatically mean a closing team outranks an opening team. CG's extension must be weighed against OO's case — if OO proved bigger impacts on the key issues, OO ranks above CG regardless of whether CG extended. Similarly, CO must win their clashes against OG's case to rank above OG.

IMPORTANT — DO NOT OVERCREDIT BACKHALF WEIGHING:
Closing teams (CG, CO) often do explicit "weighing" or "framing" language that sounds impressive but doesn't make their impacts bigger. Opening teams (OG, OO) often present the most germane, first-principled arguments directly responsive to the motion. Evaluate impacts by their actual size, probability, and relevance — not by whether a team explicitly said "we outweigh on scope" or "this is the most important issue in the round." A strong, obvious argument from OG that directly addresses the motion can beat a heavily-weighed but narrower extension from CG.

IMPORTANT RULES:
- No ties — each rank must be unique (1, 2, 3, 4)
- Rank by IMPACT WEIGHING: which team proved the bigger, more probable, more important impacts on the key clashes?
- Closing teams without genuine extensions should generally rank below their opening counterparts
- Closing teams that knife their opening should be penalized proportionally — minor knifing is often forgiven, but direct contradictions that undermine the opening's core case warrant a significant penalty
- Opening teams that left no room for extension may still rank well if their case was strong

Respond with ONLY valid JSON:
{
  "rankings": [
    {
      "team": "OG/OO/CG/CO",
      "rank": 1,
      "reasoning": "2-3 sentences explaining why this team received this rank"
    },
    {
      "team": "OG/OO/CG/CO",
      "rank": 2,
      "reasoning": "2-3 sentences explaining why this team received this rank"
    },
    {
      "team": "OG/OO/CG/CO",
      "rank": 3,
      "reasoning": "2-3 sentences explaining why this team received this rank"
    },
    {
      "team": "OG/OO/CG/CO",
      "rank": 4,
      "reasoning": "2-3 sentences explaining why this team received this rank"
    }
  ]
}`

  const user = `Topic: ${topic}

Relative contribution analysis:
${JSON.stringify(relativeContribution, null, 2)}

Extension analysis:
${JSON.stringify(extensionAnalysis, null, 2)}

Flow sheet:
${bpFlowToText(flow)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge-bp:ranking',
  }) as { rankings: BPTeamRanking[] }

  const sorted = parsed.rankings.sort((a, b) => a.rank - b.rank)
  console.log(`[judge-bp] Step 3: Rankings — ${sorted.map((r) => `${r.rank}:${r.team}`).join(', ')}`)
  return sorted
}

// Step 4a: RFD
async function writeRFD(
  flow: BPFlowSheet,
  topic: string,
  relativeContribution: Awaited<ReturnType<typeof analyzeRelativeContribution>>,
  extensionAnalysis: BPExtensionAnalysis[],
  rankings: BPTeamRanking[],
  paradigmPrompt: string,
): Promise<BPRFDSection> {
  const system = `You are an expert British Parliamentary debate judge writing the Reason for Decision (RFD) for a BP round.

${BP_PARADIGM_CONTEXT}

${paradigmPrompt}

Write a structured RFD that builds through the round speech-by-speech, as real BP judges deliver decisions. The RFD should follow this narrative arc:

1. "topHalfSummary": Summarize the contributions of both opening teams (OG and OO). What arguments did each bring? What was the clash between them? Who won the top half and why? (3-5 sentences, referencing specific arguments)

2. "topHalfWinner": Just the team name — "OG" or "OO" — of who won the top half.

3. "topHalfReasoning": Why the winning opening team beat the other. What specific arguments or weighing gave them the edge? (2-3 sentences)

4. "closingGovernment": What did CG bring as their extension? How does it compare to OG's case and OO's rebuttal? Did they differentiate from OG? Did they knife OG, and if so, was it a minor soft knife or a direct contradiction that undermines OG's core case? On impact weighing, does CG's extension prove bigger impacts than OO's case? Where does CG rank relative to OG and OO, and why? (3-5 sentences)

5. "closingOpposition": What did CO bring as their extension? How does it compare to OO's case, OG's case, and CG's extension? Did they differentiate from OO? Did they knife OO, and if so, was it a minor soft knife or a direct contradiction that undermines OO's core case? On impact weighing, does CO's extension prove bigger impacts than OG's case? Where does CO rank relative to the other three teams, and why? (3-5 sentences)

6. "finalRankingJustification": Tie it all together. State the final ranking (1st through 4th) and for each adjacent pair, explain which team won the key clashes on impact weighing — who proved the bigger, more probable, or more important impact. (3-5 sentences)

Be direct and specific — reference actual arguments from the flow, not vague generalities.

Respond with ONLY valid JSON:
{
  "topHalfSummary": "...",
  "topHalfWinner": "OG" or "OO",
  "topHalfReasoning": "...",
  "closingGovernment": "...",
  "closingOpposition": "...",
  "finalRankingJustification": "..."
}`

  const user = `Topic: ${topic}
Rankings: ${rankings.sort((a, b) => a.rank - b.rank).map((r) => `${r.rank}${r.rank === 1 ? 'st' : r.rank === 2 ? 'nd' : r.rank === 3 ? 'rd' : 'th'}=${r.team}`).join(', ')}

Relative contribution analysis:
${JSON.stringify(relativeContribution, null, 2)}

Extension analysis:
${JSON.stringify(extensionAnalysis, null, 2)}

Flow sheet:
${bpFlowToText(flow)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge-bp:rfd',
  }) as BPRFDSection

  console.log('[judge-bp] Step 4: RFD written')
  return parsed
}

// Step 4b: Devil's Advocate (for the 4th-place team)
async function generateDevilsAdvocate(
  flow: BPFlowSheet,
  topic: string,
  relativeContribution: Awaited<ReturnType<typeof analyzeRelativeContribution>>,
  rankings: BPTeamRanking[],
  paradigmPrompt: string,
): Promise<BPDevilsAdvocatePosition[]> {
  const fourthPlaceTeam = rankings.find((r) => r.rank === 4)!.team

  const system = `You are an expert British Parliamentary debate judge playing devil's advocate. The team ranked 4th (last) is ${fourthPlaceTeam}. Your job is to construct the STRONGEST possible case for ${fourthPlaceTeam} — 2-3 distinct paths through which they could have placed higher.

${BP_PARADIGM_CONTEXT}

${paradigmPrompt}

Each path should be a genuine, plausible argument for why ${fourthPlaceTeam} should have ranked higher. Focus on IMPACT WEIGHING — where could ${fourthPlaceTeam} have won key clashes by proving bigger, more probable, or more important impacts? Consider:
- Issues they could have won with different framing or impact calculus
- Weighing they could have used to prioritize their impacts over higher-ranked teams' impacts
- Extensions they could have run (if closing) or extensions from their closing that could have elevated them (if opening)
- Drops by higher-ranked teams that could have been exploited
- Alternative frameworks that favor ${fourthPlaceTeam}'s impacts

Respond with ONLY valid JSON:
{
  "positions": [
    {
      "label": "Short name for this path (3-5 words)",
      "team": "${fourthPlaceTeam}",
      "argument": "2-3 sentences on the core argument",
      "whyItCouldWin": "2-3 sentences on why this path could overcome the ranking"
    }
  ]
}`

  const user = `Topic: ${topic}
4th place team: ${fourthPlaceTeam}

Rankings:
${rankings.map((r) => `${r.rank}. ${r.team}: ${r.reasoning}`).join('\n')}

Relative contribution analysis:
${JSON.stringify(relativeContribution, null, 2)}

Flow sheet:
${bpFlowToText(flow)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge-bp:devils-advocate',
  }) as { positions: BPDevilsAdvocatePosition[] }

  console.log(`[judge-bp] Step 4: Generated ${parsed.positions.length} devil's advocate positions for ${fourthPlaceTeam}`)
  return parsed.positions
}

// Step 5: Per-debater speaker scores (parallel)
async function scoreDebater(
  debaterName: string,
  speeches: string[],
  team: BPTeam,
  side: string,
  flow: BPFlowSheet,
  topic: string,
  rankings: BPTeamRanking[],
  rfd: BPRFDSection,
  paradigmPrompt: string,
): Promise<BPSpeakerScore[]> {
  const isWhip = speeches.includes('GW') || speeches.includes('OW')
  const isExtension = speeches.includes('MG') || speeches.includes('MO')

  const debaterArgs = flow.entries
    .filter((e) => speeches.includes(e.speech))
    .flatMap((e) => e.args)

  const argsText = debaterArgs.length > 0
    ? debaterArgs.map((a) => `[${speeches[0]}] ${a.tag}: ${a.text}`).join('\n')
    : 'No arguments found for this debater in the flow.'

  const teamRank = rankings.find((r) => r.team === team)?.rank ?? 4

  const system = `You are an expert British Parliamentary debate judge assigning speaker scores and ranks for a SINGLE debater using the WUDC scale.

${BP_PARADIGM_CONTEXT}

${paradigmPrompt}

WUDC/BP Speaker Scale Reference:
${speaksGuideBP}

PRACTICAL CALIBRATION:
- 75 is a solid, truly average speech. A competent debater who does everything right but nothing exceptional gets a 75.
- 70-74 is below average — noticeable gaps or weaknesses.
- 65-69 is noticeably below average — significant errors or omissions.
- 60-64 is poor — major errors or major drops.
- 50-59 is very poor — should be rare.
- 80-84 is excellent — strong engagement, clear argumentation, good weighing.
- 85-89 is outstanding — near-perfect execution.
- 90+ is exceptional — debate-changing, rare.

IMPORTANT — SPEAKER SCORES MUST CORRELATE WITH TEAM PLACEMENT:
In BP, speaker scores are a sanity check on rankings. The combined speaker scores of each team MUST correlate with their placement:
- The 1st-place team's combined speaker scores must be the highest among all 4 teams.
- The 2nd-place team's combined scores must be the second-highest.
- The 3rd-place team's combined scores must be the third-highest.
- The 4th-place team's combined scores must be the lowest.
If your scores would violate this correlation, adjust them accordingly. Individual debaters within a team may vary, but the team totals must match the ranking order.

You are scoring: ${debaterName} (${team}/${side}), who gave these speeches: ${speeches.join(', ')}.
This debater's team (${team}) is ranked ${teamRank} out of 4.

${isWhip ? 'IMPORTANT: This debater gave a WHIP speech. Whip speeches may ONLY crystallize, weigh, and summarize. They may NOT introduce new arguments. If they introduced new arguments, that is a NEGATIVE. Score whip speeches on: strategic voting, crystallization quality, weighing, and comparison — NOT on new material.' : ''}
${isExtension ? 'IMPORTANT: This debater gave an EXTENSION speech (MG or MO). Extension speeches should bring NEW, DISTINCTIVE material that differentiates their closing team from their opening team. Reward genuine extension and penalize mere repetition of opening arguments.' : ''}

Rules:
- Score each speech individually on the WUDC scale (50-100)
- Assign a tentative rank from 1-8 based on this debater's performance relative to an average debater (1=best, 8=worst). Final ranks will be reconciled across all debaters.
- For each speech, evaluate: warrant quality, impact quality, weighing quality, engagement, and argument quality
- Consider the debater's role in the debate (opening vs. extension vs. whip)

Respond with ONLY valid JSON:
{
  "scores": [
    ${speeches.map((s) => `{
      "speech": "${s}",
      "speaker": "${debaterName}",
      "team": "${team}",
      "side": "${side}",
      "score": 75,
      "rank": 4,
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
Debater: ${debaterName} (${team}/${side}), speeches: ${speeches.join(', ')}

Rankings: ${rankings.map((r) => `${r.rank}. ${r.team}`).join(', ')}

RFD:
Top half: ${rfd.topHalfSummary}
Top half winner: ${rfd.topHalfWinner} — ${rfd.topHalfReasoning}
CG: ${rfd.closingGovernment}
CO: ${rfd.closingOpposition}
Final: ${rfd.finalRankingJustification}

This debater's arguments from the flow:
${argsText}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.2,
    label: `judge-bp:speaks:${debaterName}`,
  }) as { scores: BPSpeakerScore[] }

  console.log(`[judge-bp] Step 5: Scored ${debaterName}: ${parsed.scores.map((s) => `${s.speech}=${s.score}`).join(', ')}`)
  return parsed.scores
}

async function assignSpeaks(
  flow: BPFlowSheet,
  topic: string,
  rankings: BPTeamRanking[],
  rfd: BPRFDSection,
  paradigmPrompt: string,
): Promise<BPSpeakerScore[]> {
  const results = await Promise.all(
    Object.entries(BP_DEBATERS).map(([name, info]) =>
      scoreDebater(name, info.speeches, info.team, info.side, flow, topic, rankings, rfd, paradigmPrompt),
    ),
  )

  const allScores = results.flat()
  return fixupBPRanks(allScores, rankings)
}

function fixupBPRanks(scores: BPSpeakerScore[], rankings: BPTeamRanking[]): BPSpeakerScore[] {
  if (scores.length !== 8) return scores

  const debaterBestScore = new Map<string, number>()
  for (const s of scores) {
    const current = debaterBestScore.get(s.speaker) ?? -1
    debaterBestScore.set(s.speaker, Math.max(current, s.score))
  }

  const debaterRanks = new Map<string, number>()
  for (const s of scores) {
    if (!debaterRanks.has(s.speaker) || s.rank < (debaterRanks.get(s.speaker) ?? Infinity)) {
      debaterRanks.set(s.speaker, s.rank)
    }
  }

  const uniqueRanks = new Set(debaterRanks.values())
  const sortedRanks = [...uniqueRanks].sort((a, b) => a - b)
  const isValid = sortedRanks.length === 8 && sortedRanks.every((r, i) => r === i + 1)

  if (isValid) {
    // Ranks are valid — still enforce team score correlation
    return enforceTeamScoreCorrelation(scores, rankings)
  }

  console.warn(`[judge-bp] Fixing invalid ranks: reassigning by score`)
  const sortedDebaters = [...debaterBestScore.entries()].sort((a, b) => b[1] - a[1])
  const newRanks = new Map<string, number>()
  sortedDebaters.forEach(([, ], i) => {
    const debater = sortedDebaters[i][0]
    newRanks.set(debater, i + 1)
  })

  for (const s of scores) {
    s.rank = newRanks.get(s.speaker) ?? s.rank
  }

  return enforceTeamScoreCorrelation(scores, rankings)
}

/**
 * Enforce WUDC rule: combined speaker scores must correlate with team placement.
 * 1st place = highest combined speaks, 2nd = second highest, etc.
 * Adjusts scores upward/downward to match the ranking order.
 */
function enforceTeamScoreCorrelation(scores: BPSpeakerScore[], rankings: BPTeamRanking[]): BPSpeakerScore[] {
  const sortedRankings = [...rankings].sort((a, b) => a.rank - b.rank)

  // Calculate combined score per team
  const teamCombined = new Map<string, number>()
  for (const s of scores) {
    teamCombined.set(s.team, (teamCombined.get(s.team) ?? 0) + s.score)
  }

  // Check if correlation already holds
  const teamRankOrder = sortedRankings.map((r) => r.team)
  const sortedByScore = [...teamCombined.entries()].sort((a, b) => b[1] - a[1])
  const scoreOrder = sortedByScore.map((e) => e[0])

  const alreadyCorrelated = teamRankOrder.every((team, i) => scoreOrder[i] === team)
  if (alreadyCorrelated) return scores

  console.warn(`[judge-bp] Fixing speaker score correlation: rank order ${teamRankOrder.join(',')} but score order ${scoreOrder.join(',')}`)

  // Calculate gaps between teams' combined scores
  const targetOrder = teamRankOrder
  const currentSums = targetOrder.map((team) => teamCombined.get(team) ?? 150)
  const avgSum = currentSums.reduce((a, b) => a + b, 0) / currentSums.length

  // Redistribute: ensure each team's combined score respects rank order
  // Use 3-point gaps between adjacent ranks as baseline, centered around average
  const baseScore = avgSum - 4.5 // center the distribution
  for (let i = 0; i < targetOrder.length; i++) {
    const targetCombined = baseScore + (targetOrder.length - i) * 3
    const currentCombined = teamCombined.get(targetOrder[i]) ?? 150
    const diff = targetCombined - currentCombined

    // Distribute the adjustment proportionally across the team's speakers
    const teamScores = scores.filter((s) => s.team === targetOrder[i])
    const teamTotalCurrent = teamScores.reduce((sum, s) => sum + s.score, 0)
    for (const s of teamScores) {
      if (teamTotalCurrent > 0) {
        s.score = Math.round(Math.min(100, Math.max(50, s.score + (diff * s.score / teamTotalCurrent))))
      }
    }
  }

  // Recalculate combined scores after adjustment
  const newTeamCombined = new Map<string, number>()
  for (const s of scores) {
    newTeamCombined.set(s.team, (newTeamCombined.get(s.team) ?? 0) + s.score)
  }

  // Verify correlation holds; if still off due to rounding, nudge
  const newScoreOrder = [...newTeamCombined.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])
  if (!teamRankOrder.every((team, i) => newScoreOrder[i] === team)) {
    // Last resort: add 1 to each speaker on higher-ranked teams until order is correct
    for (let i = 0; i < teamRankOrder.length - 1; i++) {
      const upperTeam = teamRankOrder[i]
      const lowerTeam = teamRankOrder[i + 1]
      let upperSum = scores.filter((s) => s.team === upperTeam).reduce((sum, s) => sum + s.score, 0)
      let lowerSum = scores.filter((s) => s.team === lowerTeam).reduce((sum, s) => sum + s.score, 0)
      while (upperSum <= lowerSum) {
        for (const s of scores) {
          if (s.team === upperTeam) { s.score++; upperSum++ }
        }
      }
    }
  }

  return scores
}

// Step 6: Per-team feedback (4 teams)
async function generateFeedback(
  flow: BPFlowSheet,
  rankings: BPTeamRanking[],
  speakerScores: BPSpeakerScore[],
  rfd: BPRFDSection,
  paradigmPrompt: string,
): Promise<Record<BPTeam, TeamFeedback>> {
  const teamScores: Record<string, BPSpeakerScore[]> = { OG: [], OO: [], CG: [], CO: [] }
  for (const s of speakerScores) {
    teamScores[s.team]?.push(s)
  }

  const system = `You are an expert British Parliamentary debate judge giving feedback to debaters. Provide constructive, specific feedback for each of the 4 teams.

${BP_PARADIGM_CONTEXT}

${paradigmPrompt}

For each team:
- Strengths: 2-4 specific things they did well (reference actual arguments)
- Weaknesses: 2-4 specific things they could improve (reference dropped args, weak links, etc.)
- Improvements: 2-4 actionable suggestions for future rounds

Remember:
- For opening teams (OG, OO), evaluate how well they set up the debate and whether they left room for their closing to extend
- For closing teams (CG, CO), evaluate the quality of their extension and whether they differentiated from their opening
- For whip speeches, evaluate crystallization and weighing, not new material

Respond with ONLY valid JSON:
{
  "OG": {
    "side": "Government",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "improvements": ["..."]
  },
  "OO": {
    "side": "Opposition",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "improvements": ["..."]
  },
  "CG": {
    "side": "Government",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "improvements": ["..."]
  },
  "CO": {
    "side": "Opposition",
    "strengths": ["..."],
    "weaknesses": ["..."],
    "improvements": ["..."]
  }
}`

  const user = `Rankings: ${rankings.map((r) => `${r.rank}. ${r.team}: ${r.reasoning}`).join('\n')}

RFD:
Top half: ${rfd.topHalfSummary}
Top half winner: ${rfd.topHalfWinner} — ${rfd.topHalfReasoning}
CG: ${rfd.closingGovernment}
CO: ${rfd.closingOpposition}
Final: ${rfd.finalRankingJustification}

OG speaker scores: ${teamScores['OG'].map((s) => `${s.speech}: ${s.score} (rank ${s.rank})`).join(', ') || 'N/A'}
OO speaker scores: ${teamScores['OO'].map((s) => `${s.speech}: ${s.score} (rank ${s.rank})`).join(', ') || 'N/A'}
CG speaker scores: ${teamScores['CG'].map((s) => `${s.speech}: ${s.score} (rank ${s.rank})`).join(', ') || 'N/A'}
CO speaker scores: ${teamScores['CO'].map((s) => `${s.speech}: ${s.score} (rank ${s.rank})`).join(', ') || 'N/A'}

Flow sheet:
${bpFlowToText(flow)}`

  const parsed = await llmJSON({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: 'json',
    temperature: 0.3,
    label: 'judge-bp:feedback',
  }) as Record<BPTeam, TeamFeedback>

  console.log('[judge-bp] Step 6: Feedback generated')
  return parsed
}

export async function judgeRoundBP(flow: BPFlowSheet, topic: string, paradigmPrompt: string): Promise<BPJudgingResult> {
  const startMs = Date.now()
  console.log('[judge-bp] Starting BP judging pipeline...')

  const relativeContribution = await analyzeRelativeContribution(flow, topic, paradigmPrompt)

  const extensionAnalysis = await analyzeExtensions(flow, topic, paradigmPrompt)

  const rankings = await rankTeams(flow, topic, relativeContribution, extensionAnalysis, paradigmPrompt)

  const [devilsAdvocate, rfd] = await Promise.all([
    generateDevilsAdvocate(flow, topic, relativeContribution, rankings, paradigmPrompt),
    writeRFD(flow, topic, relativeContribution, extensionAnalysis, rankings, paradigmPrompt),
  ])

  const speakerScores = await assignSpeaks(flow, topic, rankings, rfd, paradigmPrompt)

  const teams = await generateFeedback(flow, rankings, speakerScores, rfd, paradigmPrompt)

  console.log(`[judge-bp] Complete. Rankings: ${rankings.map((r) => `${r.rank}:${r.team}`).join(', ')}. Total: ${Date.now() - startMs}ms`)

  return {
    format: 'bp',
    topic,
    rankings,
    extensionAnalysis,
    rfd,
    devilsAdvocatePositions: devilsAdvocate,
    speakerScores,
    teams,
  }
}