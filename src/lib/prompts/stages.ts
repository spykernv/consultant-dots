import type { StageId } from "@/lib/schemas";
import type { MatrixChoices, PilotOverride, StageInputs } from "@/lib/schemas/api";
import { DOMAIN_IDS } from "@/lib/schemas/common";
import { DOMAINS } from "@/lib/domain/domains";
import { renderPlaybooksFor } from "@/lib/playbooks";
import { buildCaseBrief, renderBrief, splitClientNotes, type CaseBrief } from "./brief";

const FAST_START = "Latency-sensitive; begin your visible answer immediately.";

const block = (tag: string, body: string) => `<${tag}>\n${body.trim()}\n</${tag}>`;
const json = (value: unknown) => JSON.stringify(value);

export const INSTRUCTIONS: Record<StageId, string> = {
  classify: `STEP 1 — CASE IDENTIFICATION.
Classify the case: one primary domain and 0-2 secondary domains from the list above.
Lower the confidence when the case mixes domains or stays vague.
The rationale names the core business problem, not the technology the client mentions.
Only classify: do not analyze or solve.`,

  frame: `STEP 2 — PROBLEM MAPPING: facts vs assumptions. Do not solve the case.
- businessObjectives: what the company actually wants to achieve. Never a technology ("migrer vers le cloud" is a means; the objective is cost, speed, standardization…).
- facts: only what the case states; each fact quotes its verbatim "evidence" excerpt, copied character for character from the case.
- assumptions: what you believe likely but the case does not say, with the basis. An assumption must never appear among the facts.
- stakeholders: only actors present or clearly implied; do not invent.
- premiseChallenge: only if the case frames a technology or a solution as the goal.`,

  questions: `STEP 3 — MISSING INFORMATION. Do not solve the case.
Select the 3-5 questions with the highest information value: those whose answer could materially change the scope, the target architecture, the prioritization or the pilot.
Use the playbook's core questions as inspiration, not as a list to copy. Skip anything the case already answers.
For each question: whyItMatters (one line), decisionImpact (which decision flips, e.g. "centralisé vs fédéré"), and an explicit defaultAssumption we will use if the client cannot answer.
Ask them the way a consultant would ask the client: short and concrete.`,

  diagnose: `STEP 4 — DIAGNOSTIC OF THE CURRENT STATE, using the primary playbook.
- framework: adapt the universal backbone to this case in 5-7 steps following the playbook's sequence; map each step to its backbone stage; give its case-specific focus and 1-3 key questions.
- findings: apply the playbook's analysis grid to what we know (4-8 findings). Each finding cites the ids it rests on (F#, Q#, C#, A#). Working assumptions (unanswered questions) and A# stay hypotheses.
- rootCauses: 2-4, organizational and governance causes count, not only technical ones.
- keyInsight: the "so what" in one sentence.
Do not design the target solution yet.`,

  currentState: `STEP 5 — CURRENT STATE DIAGRAM.
Draw the current situation as a whiteboard-simple graph (8-16 nodes), the way a consultant would sketch it: actors and entities on the left, their systems and data in the middle, and the pain points and bottlenecks they cause on the right.
- Use groups for entities, sites or subsidiaries. If some data or systems cannot leave an entity (regulation, sovereignty), use a group of kind "local_boundary".
- status "assumption" for anything not confirmed by the case or the client; edge style "dashed" for manual or uncertain flows.
- Labels: 2-5 French words. Prefer clarity over technical completeness.
Also list 1-3 bottlenecks.`,

  options: `STEP 6 — OPTIONS AND PRIORITIZATION.
- options: 2-3 genuinely different structuring options taken from the playbook's option typology, with advantages, drawbacks and the conditions under which each is right.
- comparison: put the options side by side before choosing.
  - constraints: the 1-3 hard constraints of the brief that discriminate between the options (go / no-go), each with the ids it comes from. For every option: pass, partial (only with a workaround or a condition) or fail, and why in a few words. Skip constraints that every option meets.
  - criteria: the 3-4 decision criteria that matter most for this client, phrased so that 5 is best (e.g. "Rapidité de mise en valeur", "Maîtrise du risque", "Portable par l'équipe actuelle"). Score every option 1-5. Be honest: the recommended option does not have to win every row.
- recommendation: the recommended option, the trade-off, and dependsOn = the ids (A#, or Q# answered only by a working assumption) it rests on. Stay consistent with the comparison: never recommend an option that fails a hard constraint. If the choice hinges on an open question, say so and choose under the working assumption.
  - pivots: the 1-3 uncertain points (A#, or Q# answered only by a working assumption) whose other answer would change the recommendation, most decisive first: the short question, what we assume, the other answer, the option you would then recommend (null if the recommendation holds but must be adapted) and what changes. Only genuine pivots.
- targetBlocks: 3-6 building blocks of the recommended target, technical and organizational (e.g. référentiel KPI commun, couche d'accès fédérée, gouvernance data).
- initiatives: 3-6 candidate initiatives, use cases or application groups, scored 1-5; exactly one verdict "pilot" (valuable, feasible, low risk, builds reusable foundations).
- traps: the 2-3 consulting reflexes (E1-E10) most relevant to this case, and why they apply here.`,

  target: `STEP 7 — TARGET STATE, built on the recommended option.
- principles: 3-5 target principles.
- diagram: a whiteboard-simple graph (8-16 nodes) with the same visual grammar as the current state. It must show every target building block. status "new" for new components, "changed" for modified ones, "retired" for removed ones, "assumption" for anything resting on an unvalidated point. If data cannot physically leave an entity, show it explicitly with a "local_boundary" group and an access or federation layer.
- keyChanges: 3-5 shifts "from → to".
- operatingModel: 2-4 non-technical changes (ownership, governance bodies, roles, skills, adoption).`,

  roadmap: `STEP 8 — ROADMAP, PILOT, KPIs, RISKS.
- phases: 3-4 phases with realistic timing (e.g. 0–1 mois cadrage et diagnostic; 1–2 mois cible et design du pilote; 2–3 mois pilote; 3–12 mois passage à l'échelle) that sequence the target building blocks. Each phase: objective, actions, deliverables, decisions, dependencies, KPIs — 2-4 items each.
- pilot: the pilot initiative chosen at the options step, as one complete vertical slice (never "20% de la plateforme"): scope, why this one, measurable success criteria, and the foundations it leaves behind.
- kpis: 4-6 KPIs mixing business, adoption, technical and risk; baseline from the case when available, otherwise "à mesurer au cadrage".
- risks: the 3-5 risks most specific to this case, each with impact and mitigation. No generic filler.`,

  oral: `STEP 9 — ORAL RESTITUTION (2-4 minutes).
Write what the candidate will say to the interviewer, in natural spoken French, first person ("Je structurerais…", "Je commencerais par…").
- opening: one sentence announcing the structure.
- sections: exactly 5, in this order: reformulation, structure, analysis, recommendation (with the roadmap), next_steps (KPIs and immediate next step). 2-4 bullets each: "point" is the line to say (max 15 words), "detail" is 1-3 spoken sentences to develop it if time allows.
- Where the recommendation rests on assumptions, say it briefly ("je fais l'hypothèse que…, à valider en cadrage").
- If the recommendation lists pivots, say the most decisive one in the recommendation section ("Si vous me dites que…, je recommanderais plutôt…").
- differentiators: 2-3 senior-level touches that make the difference for this case, each with how to say it naturally.
No jargon unless useful, no long enumerations.`,

  challenge: `CHALLENGE THE CANDIDATE'S ANSWER.
You now play an interviewer at a technology consulting firm. The candidate (junior consultant position, wants to stand out) wrote the answer in <candidate_answer> for this case. Assess it against the case, the consulting reflexes E1-E10 and what a good case answer contains: reformulation, clear structure, diagnosis before solution, options and trade-offs, a realistic pilot, KPIs with a baseline, stakeholders and adoption.
- flags: only real issues, most severe first, each tied to the one reflex (E1-E10) it breaks. When the issue is visible in the text, quote the candidate's exact words; for an omission (no KPI, no stakeholder, no risk analysis…) leave quote empty. interviewerQuestion: how you would push back, in one sentence. fix: what a strong candidate would say instead.
- The reference analysis, when present, is one valid answer among others: use it only to spot important gaps, never to require the same structure or the same recommendation.
- <client_answers>, when present, is what the client said when asked: a statement backed by a "Réponse du client" or by the client's additional information is legitimate, not an assumption to flag. Only the working assumptions there remain unconfirmed.
- strengths: what is genuinely good, specifically. missing: important elements absent. nextVersion: 2-4 concrete improvements, most impactful first.
- level: a_retravailler, correct, solide or impressionnant, calibrated for a junior consultant.
Be demanding but fair and concrete. Write in French and address the candidate as "tu".`,
};

export type Revision = { steer: string | null; previous: unknown; choices?: MatrixChoices };

/** Regenerating the options sends the candidate's working copy of the prioritization: what they decided stays. */
function ownChoices(choices: MatrixChoices): string {
  if (!choices) return "";
  const { pilot, added } = choices;
  const made = [
    pilot &&
      `they chose "${pilot.chosen}" as the pilot` + (pilot.suggested ? ` instead of the suggested "${pilot.suggested}"` : ""),
    added.length > 0 && `they added the initiatives ${added.map((name) => `"${name}"`).join(", ")}`,
  ].filter(Boolean);
  if (made.length === 0) return "";
  const kept = [pilot && "this pilot", added.length > 0 && "these initiatives"].filter(Boolean);
  return `In their matrix, ${made.join(" and ")}; the previous version includes these choices. Keep ${kept.join(" and ")} unless their instruction explicitly asks to change them.`;
}

/** Options re-run after an upstream change: the candidate's earlier choices are kept under the same names. */
function refreshChoicesBlock(choices: MatrixChoices): string {
  if (!choices) return "";
  const { pilot, added } = choices;
  const made = [
    pilot &&
      `chose "${pilot.chosen}" as the pilot` + (pilot.suggested ? ` instead of the suggested "${pilot.suggested}"` : ""),
    added.length > 0 && `added the initiatives ${added.map((name) => `"${name}"`).join(", ")}`,
  ].filter(Boolean);
  if (made.length === 0) return "";
  const kept = [
    added.length > 0 && "keep these initiatives under these exact names",
    pilot && `keep "${pilot.chosen}", under this exact name, as the pilot unless the new facts rule it out (then say why in the recommendation)`,
  ].filter(Boolean);
  return block(
    "candidate_choices",
    `This step runs again because earlier steps changed. In the previous prioritization, the candidate ${made.join(" and ")}. ${kept.join("; ")}.`,
  );
}

function revisionBlock(stage: StageId, revision: Revision): string {
  const instruction = revision.steer?.trim()
    ? `Their instruction: "${revision.steer.trim()}".`
    : "They gave no instruction: propose a different, sharper version.";
  return block(
    "revision",
    [
      `The candidate asked to regenerate this step. ${instruction}`,
      revision.previous ? `Previous version, to improve rather than copy: ${json(revision.previous)}` : "",
      revision.previous && stage === "options" ? ownChoices(revision.choices ?? null) : "",
      "Apply the request while keeping every rule above: facts vs assumptions and their ids, French, concision, the schema.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** The clarifications labeled as in the brief, so that the interviewer tells the client's answers from assumptions. */
function clientAnswers(inputs: StageInputs["challenge"]): string {
  const byQuestion = new Map((inputs.clarifications ?? []).map((c) => [c.questionId, c]));
  const lines = (inputs.questions?.questions ?? []).map((q) => {
    const c = byQuestion.get(q.id);
    const answer = c?.status === "answered" ? c.answer.trim() : "";
    return answer
      ? `- ${q.id} — ${q.question} → Réponse du client : ${answer}`
      : `- ${q.id} — ${q.question} → Hypothèse de travail, NON confirmée : ${q.defaultAssumption}`;
  });
  if (lines.length) lines.unshift("Clarifications :");
  const notes = splitClientNotes(inputs.clientNotes ?? "");
  if (notes.length) lines.push("Informations complémentaires du client :", ...notes.map((n) => `- ${n.id} : ${n.text}`));
  return lines.join("\n");
}

function challengeMessage(inputs: StageInputs["challenge"]): string {
  const parts = [block("case", inputs.caseText)];
  if (inputs.classification) parts.push(block("playbook", renderPlaybooksFor(inputs.classification)));
  if (inputs.mapping) {
    const m = inputs.mapping;
    parts.push(
      block(
        "case_mapping",
        [
          `Reformulation : ${m.reformulation}`,
          "Faits :",
          ...m.facts.map((f) => `- ${f.id} : ${f.text}`),
          "Hypothèses :",
          ...m.assumptions.map((a) => `- ${a.id} : ${a.text}`),
          "Contraintes :",
          ...m.constraints.map((c) => `- ${c.text}`),
          "Parties prenantes :",
          ...m.stakeholders.map((s) => `- ${s.name} — ${s.role}`),
        ].join("\n"),
      ),
    );
  }
  const answers = clientAnswers(inputs);
  if (answers) parts.push(block("client_answers", answers));
  const reference = [
    inputs.diagnostic ? `diagnostic: ${json({ rootCauses: inputs.diagnostic.rootCauses, keyInsight: inputs.diagnostic.keyInsight })}` : "",
    inputs.options
      ? `options: ${json({ options: inputs.options.options.map((o) => o.name), recommendation: inputs.options.recommendation.statement, pilot: inputs.options.initiatives.find((i) => i.verdict === "pilot")?.name ?? null })}`
      : "",
    inputs.roadmap
      ? `roadmap: ${json({ phases: inputs.roadmap.phases.map((p) => `${p.timing} ${p.name}`), kpis: inputs.roadmap.kpis.map((k) => k.name), risks: inputs.roadmap.risks.map((r) => r.risk) })}`
      : "",
  ].filter(Boolean);
  if (reference.length) parts.push(block("reference_analysis", reference.join("\n")));
  parts.push(block("candidate_answer", inputs.answer));
  parts.push(block("step", INSTRUCTIONS.challenge));
  return parts.join("\n\n");
}

const FAST_STAGES: StageId[] = ["classify", "currentState", "oral"];

function pilotDecisionBlock(override: PilotOverride): string {
  if (!override) return "";
  return block(
    "candidate_decision",
    `At the prioritization step the candidate chose "${override.chosen}" as the pilot` +
      (override.suggested ? ` instead of the suggested "${override.suggested}"` : "") +
      `. This is their decision: "${override.chosen}" is THE pilot. Build this step around it, even where the recommendation text still names the previous pilot, and adjust whatever depends on the pilot.`,
  );
}

function contextFor<K extends StageId>(stage: K, inputs: StageInputs[K], brief: CaseBrief | null): string[] {
  const parts: string[] = [];
  if (brief) parts.push(block("brief", renderBrief(brief)));
  const i = inputs as Record<string, unknown>;
  const decision = pilotDecisionBlock((i.pilotOverride as PilotOverride | undefined) ?? null);

  switch (stage) {
    case "frame":
    case "questions":
      parts.push(block("context", `classification: ${json(i.classification)}`));
      break;
    case "options": {
      const s = inputs as StageInputs["options"];
      parts.push(
        block(
          "context",
          [`diagnostic: ${json(s.diagnostic)}`, `currentStateBottlenecks: ${json(s.currentState.bottlenecks)}`].join("\n"),
        ),
      );
      break;
    }
    case "target": {
      const s = inputs as StageInputs["target"];
      parts.push(
        block(
          "context",
          [
            `diagnostic: ${json({ rootCauses: s.diagnostic.rootCauses, keyInsight: s.diagnostic.keyInsight })}`,
            `currentStateDiagram: ${json(s.currentState.diagram)}`,
            `options: ${json({ options: s.options.options.map(({ id, name }) => ({ id, name })), recommendation: s.options.recommendation, targetBlocks: s.options.targetBlocks, pilot: s.options.initiatives.find((x) => x.verdict === "pilot")?.name ?? null })}`,
          ].join("\n"),
        ),
      );
      break;
    }
    case "roadmap": {
      const s = inputs as StageInputs["roadmap"];
      parts.push(
        block(
          "context",
          [
            `diagnostic: ${json({ framework: s.diagnostic.framework.map((f) => f.step), rootCauses: s.diagnostic.rootCauses, keyInsight: s.diagnostic.keyInsight })}`,
            `options: ${json({ recommendation: s.options.recommendation, targetBlocks: s.options.targetBlocks, initiatives: s.options.initiatives })}`,
          ].join("\n"),
        ),
      );
      break;
    }
    case "oral": {
      const s = inputs as StageInputs["oral"];
      parts.push(
        block(
          "context",
          [
            `diagnostic: ${json({ framework: s.diagnostic.framework.map((f) => ({ step: f.step, focus: f.focus })), rootCauses: s.diagnostic.rootCauses, keyInsight: s.diagnostic.keyInsight })}`,
            `options: ${json({ options: s.options.options.map(({ id, name }) => ({ id, name })), recommendation: s.options.recommendation, pilot: s.options.initiatives.find((x) => x.verdict === "pilot")?.name ?? null, traps: s.options.traps })}`,
            `target: ${json({ principles: s.target.principles, keyChanges: s.target.keyChanges, operatingModel: s.target.operatingModel })}`,
            `roadmap: ${json({ phases: s.roadmap.phases.map((p) => ({ name: p.name, timing: p.timing, objective: p.objective })), pilot: s.roadmap.pilot, kpis: s.roadmap.kpis, risks: s.roadmap.risks.map((r) => r.risk) })}`,
          ].join("\n"),
        ),
      );
      break;
    }
    default:
      break;
  }
  if (decision) parts.push(decision);
  return parts;
}

export function buildUserMessage<K extends StageId>(
  stage: K,
  inputs: StageInputs[K],
  revision: Revision | null = null,
  choices: MatrixChoices = null,
): string {
  if (stage === "challenge") return challengeMessage(inputs as StageInputs["challenge"]);
  const parts: string[] = [block("case", inputs.caseText)];

  if (stage === "classify") {
    parts.push(
      block("domains", DOMAIN_IDS.map((id) => `- ${id}: ${DOMAINS[id].label} — ${DOMAINS[id].description}`).join("\n")),
    );
  } else {
    const classification = (inputs as StageInputs["frame"]).classification;
    if (stage !== "frame") parts.push(block("playbook", renderPlaybooksFor(classification)));
  }

  const brief =
    stage === "classify" || stage === "frame" || stage === "questions"
      ? null
      : buildCaseBrief(inputs as StageInputs["diagnose"]);
  parts.push(...contextFor(stage, inputs, brief));

  const instructions = FAST_STAGES.includes(stage) ? `${INSTRUCTIONS[stage]}\n${FAST_START}` : INSTRUCTIONS[stage];
  parts.push(block("step", instructions));
  if (revision) parts.push(revisionBlock(stage, revision));
  else if (stage === "options") parts.push(refreshChoicesBlock(choices));
  return parts.filter(Boolean).join("\n\n");
}
