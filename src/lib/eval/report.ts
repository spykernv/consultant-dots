import type { CaseLabels, Ratio, Summary } from "./metrics";

export type RunInfo = {
  date: string;
  engine: string;
  requestedModel: string;
  promptVersion: string;
  cases: string[];
  runs: number;
  challengeRuns: number;
  selfCritique: boolean;
  reusedFrom: string | null;
  labelsReviewedByHand: boolean;
};

const pct = (r: Ratio) => (r.value == null ? "n/a" : `${r.num}/${r.den} (${Math.round(r.value * 100)} %)`);
const sec = (ms: number | null) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const list = (values: (number | null)[]) => (values.length ? values.map((v) => (v == null ? "n/a" : `${Math.round(v * 100)} %`)).join(" · ") : "n/a");
const sets = (values: string[][]) => (values.length ? values.map((v) => v.join(" ") || "∅").join(" · ") : "n/a");

export function renderReport(info: RunInfo, s: Summary, labels: Record<string, CaseLabels>): string {
  const c = s.challenge;
  const lines = [
    `# Eval run · ${info.date}`,
    "",
    `Engine \`${info.engine}\` · model requested \`${info.requestedModel}\`, served by ${s.servedModels.map((m) => `\`${m}\``).join(", ") || "n/a"} · ` +
      `prompt version \`${info.promptVersion}\` · ${info.cases.length} case(s), ${info.runs} pipeline run(s) · ` +
      `${info.challengeRuns} challenge run(s) per answer (flawed and control)${info.selfCritique ? " · self-critique on" : ""}` +
      (info.reusedFrom ? ` · pipeline runs reused from \`${info.reusedFrom}\`` : ""),
    "",
    "## Pipeline guardrails",
    "",
    "| Metric | Result | What it measures |",
    "|---|---|---|",
    `| Pipelines completed | ${pct(s.pipelinesCompleted)} | Runs that reached the oral pitch (gate passed with no client answers) |`,
    `| Stage runs that succeeded | ${pct(s.stageSuccess)} | Stages never reached because an upstream stage failed count as failures |`,
    `| Invalid outputs | ${s.invalidOutputs} | No structured output, truncated, unparseable JSON, or failed the stage's Zod schema |`,
    `| Facts verified in the case text | ${pct(s.factVerification)} | Grounding: proposed facts whose quote is found in the case |`,
    `| Citations to ids that do not exist | ${pct(s.citationDrop)} | Distinct F/A/Q/C ids cited by the diagnosis and the options that the brief does not contain |`,
    `| Findings whose every citation is invalid | ${pct(s.uncitedFindings)} | Pure-inference findings with no citation are allowed and reported below |`,
    `| Findings marked as pure inference | ${pct(s.inferredFindings)} | Findings with an empty basis, as the schema allows |`,
    `| Recommended option fails a hard constraint | ${pct(s.recommendationFailsConstraint)} | The model's own comparison blocks the option it recommends |`,
    `| Pilot repaired by the code | ${pct(s.pilotFixed)} | The model did not return exactly one pilot initiative |`,
    `| Pipeline wall time (p50 / max) | ${sec(s.pipelineWallMs.p50)} / ${sec(s.pipelineWallMs.max)} | Completed runs, from the first stage to the oral pitch |`,
    `| Cost per pipeline run | ${s.costUsdPerRun == null ? "n/a" : `$${s.costUsdPerRun.toFixed(2)}`} (${pct(s.costCoverage)} of runs priced) | Pipeline + challenges + self-critique, as reported by the engine${info.engine === "cli" ? " (Claude Code reports an API-equivalent cost; a subscription is not billed per call)" : ""} |`,
  ];
  if (s.tokens) {
    lines.push(`| Tokens (input / cache read / cache write / output) | ${s.tokens.input} / ${s.tokens.cacheRead} / ${s.tokens.cacheWrite} / ${s.tokens.output} | API engine only |`);
  }
  lines.push(
    "",
    "## Challenge (interviewer critique) against labelled answers",
    "",
    "| Metric | Challenge | Answer-blind baseline | What it measures |",
    "|---|---|---|---|",
    `| Precision | ${pct(c.precision)} | ${pct(c.baseline.precision)} | Flagged reflexes that the labels confirm |`,
    `| Precision of high-severity flags | ${pct(c.highSeverityPrecision)} | | Reflexes the critic calls blocking that the labels confirm |`,
    `| Recall | ${pct(c.recall)} | ${pct(c.baseline.recall)} | Labelled violations that were flagged (ceiling ${c.recallCeiling == null ? "n/a" : `${Math.round(c.recallCeiling * 100)} %`}: at most 6 flags per answer) |`,
    `| Recall on flawed answers | ${pct(c.flawedRecall)} | | |`,
    `| False positives per control answer | ${c.controlFalsePositives.value == null ? "n/a" : c.controlFalsePositives.value.toFixed(1)} | ${c.baseline.flags.length} | Reflexes flagged on a strong answer that the labels say it respects |`,
    `| Challenge quotes removed | ${pct(s.challengeQuoteRemoval)} | | Quotes of the answer that were not verbatim and were removed by the code |`,
    "",
    `The answer-blind baseline never reads the answer: it always flags ${c.baseline.flags.join(", ")}, the reflexes most often violated in the labels.`,
  );
  const num = (v: number | null) => (v == null ? "n/a" : v.toFixed(1));
  const lvl = (levels: Record<string, number>) => Object.entries(levels).map(([level, n]) => `${level} × ${n}`).join(", ") || "n/a";
  lines.push(
    "",
    "| Answer | Challenge runs | Flags per run | High-severity flags per run | Overall level given |",
    "|---|---|---|---|---|",
    ...(["flawed", "control"] as const).map((kind) => {
      const k = c.byKind[kind];
      return `| ${kind} | ${k.runs} | ${num(k.meanFlags)} | ${num(k.meanHighFlags)} | ${lvl(k.levels)} |`;
    }),
  );
  const missed = Object.entries(c.missedOnFlawed).sort((a, b) => b[1] - a[1]);
  if (missed.length) lines.push("", `Labelled violations missed on flawed answers, by reflex: ${missed.map(([r, n]) => `${r} × ${n}`).join(", ")}.`);

  lines.push("", "| Case | Answer | Labelled violations | Flagged per run | Precision per run | Recall per run |", "|---|---|---|---|---|---|");
  for (const [caseId, pc] of Object.entries(s.perCase)) {
    for (const kind of ["flawed", "control"] as const) {
      const l = labels[caseId]?.[kind];
      lines.push(`| ${caseId} | ${kind} | ${l?.violated.join(", ") || "none"} | ${sets(pc[kind].flagged)} | ${list(pc[kind].precision)} | ${list(pc[kind].recall)} |`);
    }
  }

  lines.push(
    "",
    "## Self-critique",
    "",
    `High-severity flags raised by the challenge on the app's own oral pitch: ${s.selfCritiqueHighFlags.mean == null ? "n/a" : s.selfCritiqueHighFlags.mean.toFixed(1)} per run` +
      (Object.keys(s.selfCritiqueHighFlags.levels).length ? ` (levels: ${Object.entries(s.selfCritiqueHighFlags.levels).map(([level, n]) => `${level} × ${n}`).join(", ")}).` : "."),
    "",
    "## Latency per stage (p50 / p90)",
    "",
    "| Stage | p50 | p90 |",
    "|---|---|---|",
    ...Object.entries(s.latencyMs).map(([stage, l]) => `| ${stage} | ${sec(l.p50)} | ${sec(l.p90)} |`),
  );
  const errors = Object.entries(s.errors);
  if (errors.length) lines.push("", "## Errors (stage: code × count; full messages in the raw file)", "", ...errors.map(([k, n]) => `- ${k} × ${n}`));
  lines.push(
    "",
    "## Caveats",
    "",
    `- Labels: three independent model annotators per answer, majority vote${info.labelsReviewedByHand ? ", reviewed by hand" : "; not yet reviewed by hand"} (\`evals/challenge-labels.json\`).`,
    "- The annotators, the challenge and the pipeline belong to the same model family: these scores are a consistency check, not an independent benchmark.",
    "- Self-critique: the challenge sees, as its reference analysis, the very analysis the pitch was generated from, and grades it as a junior candidate's answer. The count is unlabelled and measures self-consistency, not pitch quality.",
    `- ${info.runs} pipeline run(s) in total: too few for tight confidence intervals; compare prompt versions on repeated runs.`,
  );
  if (info.engine === "mock") {
    lines.push(
      "- Mock engine: recorded runs are replayed, so this checks the harness, not the model. Only data-platform has a recorded challenge and every challenge replays it, whatever the answer: challenge and self-critique scores are meaningless in mock mode.",
    );
  }
  return `${lines.join("\n")}\n`;
}
