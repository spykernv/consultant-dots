import { MAX_CANDIDATE_CHARS } from "@/lib/interview/schema";
import type { CandidatePersona, SolutionTerms } from "./interview-types";
import type { InterviewBlock, InterviewSummary, PerCaseRuns } from "./interview-metrics";
import { ANSWER_KINDS, type CaseLabels, type Ratio } from "./metrics";

export type InterviewRunInfo = {
  date: string;
  engine: string;
  requestedModel: string;
  cases: string[];
  /** Interviews per case and persona. */
  interviewsPerPersona: number;
  /** The personas that were run. */
  personas: CandidatePersona[];
  /** Hash of the pipeline, interviewer and candidate prompts and schemas, to tell results apart. */
  promptVersion: string;
  /** Whether the interviewer ran in tool mode. */
  tools: boolean;
  /** The raw file the pipeline runs came from (--reuse), or null when none was given. */
  pipelinesFrom: string | null;
  /** Cases whose pipeline was run for this eval instead of being reused. */
  freshPipelines: string[];
  /** Cases with no interview: their pipeline stopped before the clarification questions. */
  skipped: string[];
  labelsReviewedByHand: boolean;
};

const pct = (r: Ratio) => (r.value == null ? "n/a" : `${r.num}/${r.den} (${Math.round(r.value * 100)} %)`);
const sec = (ms: number | null) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const num = (v: number | null, digits = 1) => (v == null ? "n/a" : v.toFixed(digits));
/** A mean kept as a ratio (total over count). */
const per = (r: Ratio, digits = 1) => num(r.value, digits);
const counts = (values: Record<string, number>) =>
  Object.entries(values)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => `${key} × ${n}`)
    .join(", ") || "n/a";
/** One value per interview, in order. */
const runs = <T>(values: (T | null)[], show: (v: T) => string) =>
  values.length ? values.map((v) => (v == null ? "n/a" : show(v))).join(" · ") : "n/a";
/** Free text in a table cell: a pipe would open a new column. */
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** One table row per metric: the flawed persona, the control persona, then all interviews. */
const row = (label: string, s: InterviewSummary, value: (b: InterviewBlock) => string, what: string) =>
  `| ${label} | ${ANSWER_KINDS.map((p) => value(s.byPersona[p])).join(" | ")} | ${value(s.overall)} | ${what} |`;

const PERSONA_HEADER = "| Metric | Flawed persona | Control persona | Overall | What it measures |\n|---|---|---|---|---|";

// The two scopes of the figures, said once in the intro and again in each "What it measures" cell.
const COMPLETED = "completed interviews only";
const EVERY_REPLY = "every reply, failed interviews included";
const TOOL_REPLIES = "every tool-mode reply, failed interviews included";

/** Messages the code cut, with the rounds they were sent at. */
const cuts = (b: InterviewBlock) =>
  b.candidateLength.truncated
    ? `${b.candidateLength.truncated} (round${b.candidateLength.truncated > 1 ? "s" : ""} ${b.candidateLength.truncatedRounds.join(", ")})`
    : "0";

function perCaseRows(caseId: string, persona: CandidatePersona, pc: PerCaseRuns, labels: Record<string, CaseLabels>): string {
  const violated = labels[caseId]?.[persona]?.violated.join(", ") || "none";
  return (
    `| ${caseId} | ${persona} | ${violated} | ${runs(pc.endedBy, String)} | ${runs(pc.scores, String)} | ${runs(pc.levels, String)} | ` +
    `${runs(pc.flagged, (v) => v.join(" ") || "∅")} | ${runs(pc.observed, (v) => v.join(" ") || "∅")} | ` +
    `${runs(pc.coverage, (v) => `${Math.round(v * 100)} %`)} | ${runs(pc.leaks, String)} |`
  );
}

export function renderInterviewReport(
  info: InterviewRunInfo,
  s: InterviewSummary,
  labels: Record<string, CaseLabels>,
  solutions: Record<string, SolutionTerms | null>,
): string {
  const interviewed = info.cases.filter((id) => !info.skipped.includes(id));
  // Without --reuse every pipeline is fresh; with it, a case the file cannot host is run here.
  const reused = info.pipelinesFrom ? info.cases.filter((id) => !info.freshPipelines.includes(id)) : [];
  const flags = s.baselineFlags;
  const lines = [
    `# Interview eval · ${info.date}`,
    "",
    `Engine \`${info.engine}\` · model requested \`${info.requestedModel}\`, served by ${s.servedModels.map((m) => `\`${m}\``).join(", ") || "n/a"} · ` +
      `${interviewed.length} case(s) · ${info.interviewsPerPersona} interview(s) per case and persona (${info.personas.join(" and ")}), ${s.interviews} in total · ` +
      `prompt version \`${info.promptVersion}\` · ` +
      `interviewer in ${info.tools ? "tool mode" : "structured mode (no tools)"}` +
      (reused.length ? ` · pipeline runs reused from \`${info.pipelinesFrom}\`${info.freshPipelines.length ? ` for ${reused.join(", ")}` : ""}` : "") +
      (info.freshPipelines.length ? ` · pipelines run for this eval: ${info.freshPipelines.join(", ")}` : ""),
  ];
  if (info.skipped.length) lines.push("", `No interview (pipeline stopped before its clarification questions): ${info.skipped.join(", ")}.`);
  lines.push(
    "",
    "A simulated candidate follows one of the two labelled answers of the case (the flawed one or the strong control one) " +
      "through up to 8 messages to the interviewer; then the debrief (the challenge stage on the candidate's messages) and the " +
      "score run as in the app. The debrief, the client's live notes, the score, the key-question coverage, the rounds and the " +
      "wall time count completed interviews only: debriefed, and not ended by a failed call. The leaks, the fact-sheet " +
      "consistency, the tool usage and the invalid outputs count every interviewer call or reply, and the message lengths every " +
      "candidate message, failed interviews included.",
    "",
    "## Interviews",
    "",
    PERSONA_HEADER,
    row("Interviews completed", s, (b) => pct(b.completed), "Debriefed, and not ended by a failed call"),
    row(
      "Ended by the client / at the last round / by an error",
      s,
      (b) => `${b.endedBy.client} / ${b.endedBy.max_rounds} / ${b.endedBy.error}`,
      "Who closed the interview: the interviewer, the code at the last round, or a failed call",
    ),
    row("Rounds used (mean)", s, (b) => num(b.meanRounds), `Candidate messages per interview, ${COMPLETED}`),
    row("Key-question coverage", s, (b) => pct(b.coverage), `Clarification questions the client answered, ${COMPLETED}`),
    row(
      "Candidate messages over the cap",
      s,
      (b) => pct(b.candidateLength.overCap),
      `First drafts longer than the ${MAX_CANDIDATE_CHARS} characters the interviewer accepts, over every candidate message sent, ` +
        "failed interviews included (n/a: the raw run predates the count)",
    ),
    row("Asked to shorten", s, (b) => String(b.candidateLength.retried), "Over-cap drafts the candidate was asked once to rewrite shorter"),
    row(
      "Cut by the code",
      s,
      cuts,
      "Messages the code cut to the cap before the interviewer read them (after the request to shorten, if any), with their rounds",
    ),
    "",
    "## Debrief against labelled answers",
    "",
  );
  const ceiling = s.overall.debrief.recallCeiling;
  // Each baseline row sits under the figure it compares with, scored on the same labelled interviews.
  const blind = (rows: string[]) => (flags.length ? rows : []);
  const SAME = "the answer-blind baseline's fixed flags, on the same completed interviews";
  lines.push(
    PERSONA_HEADER,
    row("Precision", s, (b) => pct(b.debrief.precision), `Flagged reflexes that the labels of the persona's answer confirm, ${COMPLETED}`),
    ...blind([row("Precision, answer-blind baseline", s, (b) => pct(b.debrief.baseline.precision), `The same for ${SAME}`)]),
    row(
      "Precision of high-severity flags",
      s,
      (b) => pct(b.debrief.highSeverityPrecision),
      `Reflexes the debrief calls blocking that the labels confirm, ${COMPLETED}`,
    ),
    row(
      "Recall",
      s,
      (b) => pct(b.debrief.recall),
      `Labelled violations that were flagged, ${COMPLETED} (ceiling ${ceiling == null ? "n/a" : `${Math.round(ceiling * 100)} %`}: at most 6 flags per debrief)`,
    ),
    ...blind([row("Recall, answer-blind baseline", s, (b) => pct(b.debrief.baseline.recall), `The same for ${SAME}`)]),
    row("False positives per interview", s, (b) => per(b.debrief.falsePositives), `Reflexes flagged that the labels say the answer respects, ${COMPLETED}`),
    ...blind([
      row("False positives per interview, answer-blind baseline", s, (b) => per(b.debrief.baseline.falsePositives), `The same for ${SAME}`),
    ]),
    "",
    flags.length
      ? `The answer-blind baseline never reads the conversation: it always flags ${flags.join(", ")}, the reflexes most often violated ` +
          "in the labels of these cases. Each column scores it on exactly the labelled answers its debrief was scored on, one per " +
          "completed interview of that column, so the false positives per control interview count completed control interviews " +
          "only, and a column without one shows n/a. The debrief is only worth its flags where it beats the baseline in the same column."
      : "No labels for these cases: no answer-blind baseline.",
    "",
    "## Live observations (tool mode)",
    "",
  );
  if (s.overall.observations.interviews) {
    const SAME_NOTES = "the answer-blind baseline's fixed flags, on the same completed tool-mode interviews";
    lines.push(
      PERSONA_HEADER,
      row(
        "Precision",
        s,
        (b) => pct(b.observations.precision),
        "Reflexes the client noted during the interview that the labels confirm, completed tool-mode interviews only",
      ),
      ...blind([row("Precision, answer-blind baseline", s, (b) => pct(b.observations.baseline.precision), `The same for ${SAME_NOTES}`)]),
      row("Recall", s, (b) => pct(b.observations.recall), "Labelled violations the client noted during the interview, completed tool-mode interviews only"),
      ...blind([row("Recall, answer-blind baseline", s, (b) => pct(b.observations.baseline.recall), `The same for ${SAME_NOTES}`)]),
      row(
        "Observations per interview",
        s,
        (b) => per(b.observations.perInterview),
        "Notes kept by record_observation, one per reflex and interview, completed tool-mode interviews only",
      ),
    );
    if (flags.length) {
      lines.push(
        "",
        "The baseline is the debrief's, scored on the labelled answers of the interviews whose notes are scored: the notes are only " +
          "worth something where they beat it in the same column.",
      );
    }
  } else {
    lines.push("n/a: no completed interview ran in tool mode, so the client took no notes.");
  }

  lines.push(
    "",
    "## Score",
    "",
    "| Persona | Interviews scored | Mean | Standard deviation | Min | Max | Debrief level given |",
    "|---|---|---|---|---|---|---|",
    ...ANSWER_KINDS.map((p) => {
      const b = s.byPersona[p];
      return `| ${p} | ${b.score.n} | ${num(b.score.mean)} | ${num(b.score.sd)} | ${num(b.score.min, 0)} | ${num(b.score.max, 0)} | ${counts(b.debrief.levels)} |`;
    }),
    "",
    `Separation (mean control score − mean flawed score): ${s.separation == null ? "n/a" : `${s.separation >= 0 ? "+" : ""}${s.separation.toFixed(1)} points`}. ` +
      `Ordering: the control interview scored higher in ${pct(s.ordering)} of the same-case (control, flawed) pairs, ties counting half. ` +
      "The score is computed by the code from the debrief level, the key-question coverage and the high-severity flags (src/lib/interview/score.ts), " +
      `${COMPLETED}; the standard deviation is the sample one (n − 1).`,
    "",
    "## Leaks of the solution",
    "",
    PERSONA_HEADER,
    row(
      "Replies with a leaked term",
      s,
      (b) => pct(b.leaks),
      `Interviewer replies (the opening excluded) using a word of the recommended option or the pilot that the candidate had not said yet, ${EVERY_REPLY}`,
    ),
    "",
    Object.keys(s.leakedTerms).length ? `Leaked terms, by replies: ${counts(s.leakedTerms)}.` : "No leaked term.",
  );
  if (s.uncheckedCases.length) lines.push("", `Not checked (no full pipeline run to take the solution from): ${s.uncheckedCases.join(", ")}.`);
  lines.push(
    "",
    "The terms are the words of 5 letters or more of the two names, stopwords and generic words (option, pilote…) aside, " +
      "that appear neither in the case nor in the client's fact sheet (a final s or x ignored); the client may say everything else.",
    "",
    "| Case | Recommended option | Pilot | Terms checked |",
    "|---|---|---|---|",
    ...info.cases.map((caseId) => {
      const t = solutions[caseId];
      if (info.skipped.includes(caseId)) return `| ${caseId} | n/a | n/a | no interview |`;
      if (!t) return `| ${caseId} | n/a | n/a | not checked |`;
      return `| ${caseId} | ${cell(t.option) || "n/a"} | ${cell(t.pilot) || "n/a"} | ${t.terms.join(", ") || "none: every word is in the case or the fact sheet"} |`;
    }),
    "",
    "## Fact-sheet consistency",
    "",
    PERSONA_HEADER,
    row(
      "Unsourced numbers",
      s,
      (b) => `${b.factSheet.unsourcedNumbers} (replies: ${pct(b.factSheet.repliesWithUnsourcedNumbers)})`,
      `Figures in a reply found neither in the case, the fact sheet nor the candidate's messages, ${EVERY_REPLY}`,
    ),
    row(
      "Unknown answer ids",
      s,
      (b) => String(b.factSheet.unknownAnswerIds),
      `Client answers given or looked up that the fact sheet does not hold, ${EVERY_REPLY}`,
    ),
    row("Tool errors", s, (b) => String(b.factSheet.toolErrors), `Tool calls the code refused (unknown id, cap reached, quote not verbatim…), ${EVERY_REPLY}`),
    row("Invalid outputs", s, (b) => pct(b.factSheet.invalidOutputs), "Interviewer calls whose output failed the reply schema, every call, failed interviews included"),
    row("E-mail addresses masked", s, (b) => String(b.factSheet.emailsMasked), `Addresses the code removed from a reply or a note, ${EVERY_REPLY}`),
    "",
    "## Tool usage",
    "",
  );
  if (s.overall.tools.replies) {
    lines.push(
      PERSONA_HEADER,
      row(
        "Tool calls per reply",
        s,
        (b) => per(b.tools.callsPerReply),
        `Calls of the four interview tools, refused ones included, ${TOOL_REPLIES}`,
      ),
      row("Tool rounds per reply", s, (b) => per(b.tools.roundsPerReply), `Model round trips with tool calls before the reply, ${TOOL_REPLIES}`),
      row(
        "Observations recorded / rejected",
        s,
        (b) => `${b.tools.observationsRecorded} / ${b.tools.observationsRejected}`,
        `record_observation calls kept, and refused by the code (quote not verbatim, reflex already noted…), ${TOOL_REPLIES}`,
      ),
    );
  } else {
    lines.push("n/a: no interviewer reply ran in tool mode.");
  }

  lines.push(
    "",
    "## Latency and cost",
    "",
    "| Metric | Result | What it measures |",
    "|---|---|---|",
    `| Candidate message (p50 / p90) | ${sec(s.latencyMs.candidate.p50)} / ${sec(s.latencyMs.candidate.p90)} | Simulated candidate calls that succeeded |`,
    `| Interviewer reply (p50 / p90) | ${sec(s.latencyMs.interviewer.p50)} / ${sec(s.latencyMs.interviewer.p90)} | What the candidate waits for in the app |`,
    `| Debrief (p50 / p90) | ${sec(s.latencyMs.debrief.p50)} / ${sec(s.latencyMs.debrief.p90)} | The challenge stage on the candidate's messages |`,
    `| Interview wall time (p50 / max) | ${sec(s.wallMs.p50)} / ${sec(s.wallMs.max)} | Completed interviews, every turn and the debrief included |`,
    `| Cost per interview | ${s.costUsdPerInterview == null ? "n/a" : `$${s.costUsdPerInterview.toFixed(2)}`} (${pct(s.costCoverage)} of interviews priced) | ` +
      `Candidate + interviewer + debrief, as reported by the engine${info.engine === "cli" ? " (Claude Code reports an API-equivalent cost; a subscription is not billed per call)" : ""} |`,
    "",
    "## Per case",
    "",
    "| Case | Persona | Labelled violations | Ended by | Score | Debrief level | Flagged by the debrief | Noted live | Key-question coverage | Leaking replies |",
    "|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const [caseId, pc] of Object.entries(s.perCase)) {
    for (const persona of ANSWER_KINDS) lines.push(perCaseRows(caseId, persona, pc[persona], labels));
  }
  lines.push("", "One value per interview, in sample order; n/a for an interview not completed (every column but the leaks) or a case not checked for leaks.");

  const errors = Object.entries(s.errors);
  if (errors.length) lines.push("", "## Errors (step: code × count; full messages in the raw file)", "", ...errors.map(([k, n]) => `- ${k} × ${n}`));
  lines.push(
    "",
    "## Caveats",
    "",
    `- Labels: three independent model annotators per answer, majority vote${info.labelsReviewedByHand ? ", reviewed by hand" : "; not yet reviewed by hand"} (\`evals/challenge-labels.json\`). ` +
      "They were written for the two answers, not for the conversations the personas produce: a persona that skips a move of its answer, or that the client draws onto ground the answer never covered, turns a right flag into a false positive or a miss.",
    "- The simulated candidate, the interviewer, the debrief and the label annotators all belong to the same model family: these scores are a consistency check, not an independent benchmark.",
    `- ${s.interviews} interview(s) in total, ${info.interviewsPerPersona} per case and persona: too few for tight confidence intervals; compare versions on repeated runs.`,
    "- The leak check is a word heuristic: a paraphrase or a synonym of the solution goes unseen, and a listed word used in another sense counts. The terms are printed above so that each leak can be checked in the raw transcripts.",
    "- The persona may drift from its plan under the client's questions: read the raw transcripts before trusting a per-case number.",
  );
  if (info.engine === "mock") {
    lines.push(
      "- Mock engine: recorded turns are replayed whatever the candidate says, so this checks the harness, not the interviewer: scores, leaks and debrief figures are meaningless in mock mode.",
    );
  }
  return `${lines.join("\n")}\n`;
}
