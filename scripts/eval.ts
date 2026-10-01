/**
 * Eval harness: runs the sample cases through the real pipeline and scores them.
 *
 *   npm run eval                                    # Claude Code engine (your Claude login), every sample case
 *   npm run eval -- --engine api --runs 3            # Claude API engine (billed per token), 3 pipeline runs per case
 *   npm run eval -- --engine mock                    # replays recorded runs: checks the harness itself, no model call
 *   npm run eval -- --reuse evals/results/raw/X.json # keeps the pipeline runs of an earlier eval, adds missing challenges
 *   npm run eval -- --cases data-platform --challenge-runs 5 --no-self-critique
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadEnvConfig } from "@next/env";
import { SAMPLE_CASES } from "@/lib/samples";
import { STAGE_IDS } from "@/lib/schemas";
import { SYSTEM_PROMPT } from "@/lib/prompts/system";
import { INSTRUCTIONS } from "@/lib/prompts/stages";
import { PLAYBOOKS } from "@/lib/playbooks";
import { strictSchemaFor } from "@/lib/pipeline/run-stage";
import { engineEnv, STAGE_EFFORT } from "@/lib/engine/config";
import { hashValue } from "@/lib/store/machine";
import { oralToText, runChallenge, runPipeline } from "@/lib/eval/run-case";
import { ANSWER_KINDS, summarize, type AnswerKind, type CaseLabels, type CaseSample } from "@/lib/eval/metrics";
import { renderReport } from "@/lib/eval/report";

// Same configuration as the app: .env.local is read the way Next reads it (variables already set win).
loadEnvConfig(process.cwd(), false, { info: () => undefined, error: (...args: unknown[]) => console.error(...args) });

const { values } = parseArgs({
  strict: true,
  options: {
    engine: { type: "string", default: "cli" },
    cases: { type: "string" },
    runs: { type: "string", default: "1" },
    "challenge-runs": { type: "string", default: "3" },
    "no-self-critique": { type: "boolean", default: false },
    reuse: { type: "string" },
    out: { type: "string", default: path.join("evals", "results") },
  },
});

const count = (name: string, raw: string | undefined, min: number) => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}.`);
  return n;
};

// The engine is chosen only by the flag, so a paid engine never starts from a leftover environment variable.
const engine = values.engine as "cli" | "api" | "mock";
if (!["cli", "api", "mock"].includes(engine)) throw new Error(`Unknown engine "${engine}" (cli | api | mock).`);
process.env.CONSULTANT_DOTS_ENGINE = engine === "api" ? "api" : "cli";
// An eval must never overwrite the recorded demo runs.
process.env.CONSULTANT_DOTS_RECORD_FIXTURES = "0";

const runs = count("runs", values.runs, 1);
const challengeRuns = count("challenge-runs", values["challenge-runs"], 0);
const selfCritique = !values["no-self-critique"];
const outDir = values.out!;

const labelsFile = JSON.parse(readFileSync(path.join("evals", "challenge-labels.json"), "utf8")) as {
  reviewedByHand: boolean;
  cases: Record<string, CaseLabels & { control: { answer: string } }>;
};

const reused = values.reuse ? (JSON.parse(readFileSync(values.reuse, "utf8")) as (CaseSample & { planted?: { run: CaseSample["challenges"][number]["run"] }[] })[]) : [];
const caseIds = (values.cases ?? (reused.length ? [...new Set(reused.map((s) => s.caseId))].join(",") : SAMPLE_CASES.map((c) => c.id).join(",")))
  .split(",")
  .map((c) => c.trim());
for (const id of caseIds) {
  if (!SAMPLE_CASES.some((c) => c.id === id)) throw new Error(`Unknown sample case "${id}".`);
  if (!labelsFile.cases[id]) throw new Error(`No labels for "${id}" in evals/challenge-labels.json.`);
}
if (values.reuse && !existsSync(values.reuse)) throw new Error(`No file ${values.reuse}.`);

const promptVersion = hashValue({ SYSTEM_PROMPT, INSTRUCTIONS, PLAYBOOKS, STAGE_EFFORT, schemas: STAGE_IDS.map((s) => strictSchemaFor(s)) });
const date = new Date().toISOString();
const stamp = `${date.slice(0, 16).replace(/[-:]/g, "").replace("T", "-")}-${engine}`;
const rawFile = path.join(outDir, "raw", `${stamp}.json`);

const answerOf = (caseId: string, kind: AnswerKind) =>
  kind === "flawed" ? SAMPLE_CASES.find((c) => c.id === caseId)!.flawedAnswer : labelsFile.cases[caseId].control.answer;

/** Earlier raw files stored the flawed-answer challenges as `planted`. */
function fromRaw(s: (typeof reused)[number]): CaseSample {
  return { ...s, challenges: s.challenges ?? (s.planted ?? []).map((p) => ({ kind: "flawed" as const, run: p.run })) };
}

async function main() {
  mkdirSync(path.dirname(rawFile), { recursive: true });
  const samples: CaseSample[] = [];
  for (const caseId of caseIds) {
    const sample = SAMPLE_CASES.find((c) => c.id === caseId)!;
    const options = { caseId: engine === "mock" ? caseId : null, mock: engine === "mock" };
    const previous = reused.filter((s) => s.caseId === caseId).map(fromRaw);
    for (let run = 1; run <= (previous.length || runs); run++) {
      const kept = previous[run - 1];
      let pipeline = kept?.pipeline;
      if (!pipeline) {
        log(`${caseId} · run ${run} · pipeline…`);
        pipeline = await runPipeline(sample.text, options);
      }
      log(`${caseId} · run ${run} · ${pipeline.stages.filter((s) => s.ok).length}/${pipeline.stages.length} stages in ${(pipeline.wallMs / 1000).toFixed(0)} s${kept ? " (reused)" : ""}`);

      const challenges = [...(kept?.challenges ?? [])];
      for (const kind of ANSWER_KINDS) {
        for (let c = challenges.filter((x) => x.kind === kind).length + 1; c <= challengeRuns; c++) {
          const result = await runChallenge(pipeline.session, answerOf(caseId, kind), options);
          challenges.push({ kind, run: result });
          const flagged = result.data ? [...new Set(result.data.flags.map((f) => f.reflex))].join(" ") || "nothing" : `failed (${result.error?.code})`;
          log(`${caseId} · run ${run} · ${kind} answer, challenge ${c}/${challengeRuns}: ${flagged}`);
        }
      }

      const oral = pipeline.session.stages.oral.data;
      const critique = kept?.selfCritique ?? (selfCritique && oral ? await runChallenge(pipeline.session, oralToText(oral), options) : null);
      samples.push({ caseId, sample: run, pipeline, challenges, selfCritique: critique });
      // Written after every run, so a crash keeps what is done.
      writeFileSync(rawFile, JSON.stringify(samples, null, 2), "utf8");
    }
  }

  const summary = summarize(samples, labelsFile.cases);
  const report = renderReport(
    {
      date: date.slice(0, 16).replace("T", " ") + " UTC",
      engine,
      requestedModel: engine === "mock" ? "recorded runs" : engineEnv().model,
      promptVersion,
      cases: caseIds,
      runs: samples.length,
      challengeRuns,
      selfCritique,
      reusedFrom: values.reuse ? path.basename(values.reuse) : null,
      labelsReviewedByHand: labelsFile.reviewedByHand,
    },
    summary,
    labelsFile.cases,
  );
  writeFileSync(path.join(outDir, `${stamp}.md`), report, "utf8");
  writeFileSync(path.join(outDir, `${stamp}.json`), `${JSON.stringify({ promptVersion, engine, summary }, null, 2)}\n`, "utf8");
  process.stdout.write(`\n${report}\nWritten to ${path.join(outDir, `${stamp}.md`)} (raw outputs: ${rawFile})\n`);
}

function log(message: string) {
  process.stderr.write(`[eval] ${message}\n`);
}

main().catch((err) => {
  process.stderr.write(`[eval] failed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
