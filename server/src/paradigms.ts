/**
 * Judging paradigm definitions.
 *
 * A paradigm is a set of judging instructions injected into every LLM call
 * during the judging step. It determines how the AI evaluates the round —
 * what it prioritizes (technical drops vs. real-world truth vs. persuasiveness).
 *
 * Built-in paradigms are hardcoded. Custom paradigms are user-created and
 * stored in the DB (scoped to client_id).
 */

export interface Paradigm {
  id: string
  name: string
  description: string
  prompt: string
  isBuiltin: boolean
  format: 'apda' | 'bp'
}

export const BUILTIN_PARADIGMS: Paradigm[] = [
  {
    id: 'tech-over-truth',
    name: 'Tech over Truth',
    description: 'Arguments stand as true unless directly answered. Dropping an argument concedes it. Under-substantiated is not a valid reason to discount unanswered args.',
    isBuiltin: true,
    format: 'apda',
    prompt: `APDA follows TECH OVER TRUTH: an argument made in a constructive speech (PMC, LOC, MG, MO) is treated as TRUE in later speeches unless it is directly answered by the opposing team. This means:
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
- Independent offense from MO or MG must be weighed against the other side's case on its own merits, just like any other argument.`,
  },
  {
    id: 'truth-over-tech',
    name: 'Truth over Tech',
    description: 'Arguments must be genuinely persuasive and well-warranted to win. A thin link that was "dropped" still doesn\'t win if the impact is implausible. Warrant quality and real-world truth matter.',
    isBuiltin: true,
    format: 'apda',
    prompt: `This round is judged under TRUTH OVER TECH: arguments must be genuinely persuasive and well-warranted to carry weight. Technical drops alone do not win rounds. This means:
- An argument with a weak or implausible warrant does NOT automatically win just because the other side didn't respond. A dropped argument only wins if it had a legitimate warrant and a believable impact.
- Judges should evaluate whether arguments are actually TRUE or plausible, not just whether they were technically conceded.
- "Under-substantiated" IS a valid reason to discount an argument, even one that was not directly answered. The quality of the warrant matters.
- A thin link chain that was "dropped" does not decide the round if the impact is implausible or the mechanism is unrealistic.
- Engagement matters: directly responding to the other side's best arguments demonstrates stronger argumentation than relying on dropped points.
- Reply speeches (PMR, LOR) may crystallize and weigh existing arguments but may NOT introduce new ones.

CRITICAL — ARGUMENT QUALITY:
- The MO and MG may introduce new arguments (independent offense), but those arguments must meet the same threshold of warrant quality and plausibility.
- New arguments are not inherently more or less valid — they must stand on the quality of their warrant and impact.
- Weigh the QUALITY of argumentation, not just the quantity of unanswered points.
- If one side has more technical drops but the other side has more persuasive, well-warranted arguments, prefer the side with better argumentation quality.`,
  },
  {
    id: 'persuasion',
    name: 'Persuasion / Lay Judge',
    description: 'Judge as an intelligent layperson — clarity, narrative, and framing matter more than technical drops. Which side was more convincing to a reasonable person?',
    isBuiltin: true,
    format: 'apda',
    prompt: `This round is judged as a LAY JUDGE: evaluate which side was more PERSUASIVE to a reasonable, intelligent person with no debate expertise. Technical arguments that would only make sense to a trained debater should not decide the round. This means:
- CLARITY AND NARRATIVE: Which side told a more coherent, compelling story? A clear, well-structured narrative beats a scattered collection of technical points.
- FRAMING: Which side better framed the debate — made the judge understand WHY their side matters? Good framing beats technical responses.
- ACCESSIBILITY: Arguments should be understandable to someone who has never seen a debate round. Jargon-heavy arguments lose force if they can't be explained plainly.
- DROPPED ARGUMENTS: A dropped argument only matters if it was clearly explained and significant. If a side "drops" a point that was buried in jargon or never clearly explained, it doesn't count.
- WEIGHING: Which side better explained why their arguments MATTER more? Comparative weighing — "our impact is bigger/more likely/more important because..." — is the most persuasive tool.
- REAL-WORLD TRUTH: Plausibility matters. Arguments that stretch credulity or rely on extreme hypotheticals are less persuasive than grounded, realistic ones.
- REPLY SPEECHES: PMR and LOR should crystallize the round — clearly identifying the 2-3 most important arguments and why their side wins. The best crystallization often decides lay-judged rounds.
- STYLE: Clear speaking, good organization, and confident delivery matter. Confused or disorganized speeches lose persuasiveness regardless of their content.`,
  },
  // ── BP Paradigms ──
  {
    id: 'bp-comparative',
    name: 'Comparative / Relative Contribution',
    description: 'Standard WUDC judging. Rank teams by their relative contribution to the debate — who moved the debate forward most? Extensions and differentiation from opening matter.',
    isBuiltin: true,
    format: 'bp',
    prompt: `This round is judged under COMPARATIVE / RELATIVE CONTRIBUTION (standard WUDC judging). You are ranking 4 teams (OG, OO, CG, CO) based on their RELATIVE CONTRIBUTION to the debate. This means:

RANKING CRITERIA:
- Rankings are determined by PAIRWISE IMPACT WEIGHING. Compare teams head-to-head on each key issue: which team proved the bigger, more probable, or more important impact?
- Having an extension does NOT automatically outrank an opening team. CG must beat OO on impact weighing to rank above them, and CO must beat OG on impact weighing.
- A team that introduces a novel, important argument that nobody else makes may rank higher than a team that only responds to others' arguments — but only if that argument's impact outweighs the other team's impacts.
- Opening teams (OG, OO) get credit for setting up the debate. Closing teams (CG, CO) must EXTEND — bring genuinely new, distinct material that differentiates them from their opening.

EXTENSIONS (CRITICAL):
- CG must extend from OG's case with NEW material. If CG only rebuts or re-explains OG's arguments, CG likely ranks below OG.
- CO must extend from OO's case with NEW material. If CO only rebuts or re-explains OO's arguments, CO likely ranks below OO.
- An extension can be vertical (deeper analysis of the same argument) or horizontal (a new argument entirely). It must be CLEARLY DIFFERENT from what the opening team said.
- A strong extension that proves bigger impacts than the opening team's case SHOULD outrank that opening team. Being an opening team is not a ranking advantage — only impacts matter.

KNIFING:
- Knifing is when a closing team DIRECTLY CONTRADICTS their opening team's core thesis. This should be penalized.
- Reframing is NOT knifing. If CG argues the same phenomenon has negative consequences that OG presented as positive, that is a legitimate extension — CG is reframing from a new angle, not contradicting OG's case.
- Minor or soft knifing — where a closing team takes a slightly different angle that doesn't undermine the opening's core case — is common and often forgiven.
- Direct contradictions that undermine the opening's central thesis should be penalized, but do not automatically drop a team to 4th. Consider the severity and the rest of their contribution.

WHIP SPEECHES:
- GW and OW are crystallization speeches. They may NOT introduce new arguments.
- If a whip makes a new argument, it should be discounted.
- Whips should weigh, summarize, and identify the most important clashes.

TEAM COMPARISON:
- You must compare ALL FOUR TEAMS against each other, not just opening vs. closing on each bench.
- It is common for one bench (e.g., Government) to take both 1st and 4th place.
- The ranking is about RELATIVE contribution, not which "side" won.
- Do NOT overcredit closing teams for explicit "weighing" or "framing" language. Opening teams often present the most germane, first-principled arguments directly responsive to the motion. Evaluate impacts by their actual size, probability, and relevance — not by whether a team explicitly said "we outweigh." A strong opening argument can beat a heavily-weighed but narrower closing extension.`,
  },
  {
    id: 'bp-persuasion',
    name: 'Persuasion / Lay Judge (BP)',
    description: 'Judge as an intelligent layperson. Which team was most convincing? Clarity, narrative, and framing beat technical drops. No debate jargon needed.',
    isBuiltin: true,
    format: 'bp',
    prompt: `This round is judged as a LAY JUDGE in BP format: evaluate which of the 4 teams was most PERSUASIVE to a reasonable, intelligent person with no debate expertise. Technical arguments that would only make sense to a trained debater should not decide the ranking. This means:

CLARITY AND NARRATIVE: Which team told the most coherent, compelling story? A clear narrative beats scattered technical points.
FRAMING: Which team best explained WHY their arguments matter? Good framing beats technical responses.
ACCESSIBILITY: Arguments should be understandable without debate jargon.
NO DEBATE JARGON: Do not use terms like "extension," "knifing," "POI," "constructive" unless explaining them plainly.
WEIGHING: Which team best explained why their arguments matter MORE than the others? Comparative weighing is the most persuasive tool.

TEAM COMPARISON:
- Rank all 4 teams based on which was most convincing overall.
- Consider: which team would a reasonable person agree with most? Which team made the most sense?
- Extensions matter, but a closing team does NOT automatically outrank an opening team just because they extended. The extension must be more persuasive and have bigger impact than the other team's case.
- Don't overcredit closing teams for jargon like "we outweigh" — opening teams often present the most obvious, intuitive arguments. What matters is what would actually convince a reasonable person.
- If a closing team contradicts their opening team, that can be confusing and unpersuasive — but minor knifing is common and often forgiven. Penalize based on how much it actually undermines the opening's case.

STYLE: Clear speaking, good organization, confident delivery. Disorganized or unclear speeches lose persuasiveness.`,
  },
]

export function getParadigmById(id: string): Paradigm | undefined {
  return BUILTIN_PARADIGMS.find((p) => p.id === id)
}