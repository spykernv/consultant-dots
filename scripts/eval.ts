/**
 * Eval harness: runs the sample cases through the real pipeline and scores them.
 *
 *   npm run eval                                    # Claude Code engine (your Claude login), every sample case
 *   npm run eval -- --engine api --runs 3            # Claude API engine (billed per token), 3 pipeline runs per case
 *   npm run eval -- --engine mock                    # replays recorded runs: checks the harness itself, no model call
 *   npm run eval -- --reuse evals/results/raw/X.json # keeps the pipeline runs of an earlier eval, adds missing challenges
 *   npm run eval -- --cases data-platform --challenge-runs 5 --no-self-critique
 *
 * The interview suite has a simulated candidate (a flawed and a control persona, each following a labelled answer)
 * talk to the interviewer, then scores the debrief, the leaks of the solution and the client's consistency:
 *
 *   npm run eval -- --suite interview --engine mock  # replays the demo interview: checks the harness, no model call
 *   npm run eval -- --suite interview --reuse evals/results/runs-2026-10-01-cli.json --interviews 1
 *   npm run eval -- --suite interview --cases data-platform --interviews 3 --personas control --interview-tools off
 *
 * The report and the summary go to --out (default evals/results), the raw outputs to its raw/ folder, named after the
 * start time (to the second for an interview eval, which also says -tools-off); an eval never overwrites another's.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
import { ANSWER_KINDS, summarize, type AnswerKind, type CaseSample } from "@/lib/eval/metrics";
import { renderReport } from "@/lib/eval/report";
import {
  checkReusedFile,
  countFlag as count,
  interviewPromptVersion,
  labelledAnswer,
  outputName,
  outputWriter,
  runInterviewSuite,
  suiteFlags,
  type LabelledCases,
} from "@/lib/eval/interview-suite";
import { renderInterviewReport } from "@/lib/eval/interview-report";

// Same configuration as the app: .env.local is read the way Next reads it (variables already set win).
loadEnvConfig(process.cwd(), false, { info: () => undefined, error: (...args: unknown[]) => console.error(...args) });

const { values } = parseArgs({
  strict: true,
  options: {
    engine: { type: "string", default: "cli" },
    cases: { type: "string" },
    // The defaults of the suite flags are applied below: a flag given to the wrong suite is an error, not a no-op.
    suite: { type: "string" },
    runs: { type: "string" },
    "challenge-runs": { type: "string" },
    "no-self-critique": { type: "boolean", default: false },
    interviews: { type: "string" },
    personas: { type: "string" },
    "interview-tools": { type: "string" },
    reuse: { type: "string" },
    out: { type: "string", default: path.join("evals", "results") },
  },
});

// The engine is chosen only by the flag, so a paid engine never starts from a leftover environment variable.
const engine = values.engine as "cli" | "api" | "mock";
if (!["cli", "api", "mock"].includes(engine)) throw new Error(`Unknown engine "${engine}" (cli | api | mock).`);
process.env.CONSULTANT_DOTS_ENGINE = engine === "api" ? "api" : "cli";
// An eval must never overwrite the recorded demo runs.
process.env.CONSULTANT_DOTS_RECORD_FIXTURES = "0";

const flags = suiteFlags(values);
// The interviewer's mode too is chosen only by the flag, set before anything reads it.
if (flags.suite === "interview") process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS = flags.interviewTools ? "on" : "off";

const runs = count("runs", values.runs ?? "1", 1);
const challengeRuns = count("challenge-runs", values["challenge-runs"] ?? "3", 0);
const selfCritique = !values["no-self-critique"];
const outDir = values.out!;

const labelsFile = JSON.parse(readFileSync(path.join("evals", "challenge-labels.json"), "utf8")) as {
  reviewedByHand: boolean;
  cases: LabelledCases;
};

if (values.reuse && !existsSync(values.reuse)) throw new Error(`No file ${values.reuse}.`);
type ReusedEntry = CaseSample & { planted?: { run: CaseSample["challenges"][number]["run"] }[] };
// Checked before anything runs: a file of interviews would otherwise start new pipelines labelled reused.
const reused = values.reuse ? (checkReusedFile(JSON.parse(readFileSync(values.reuse, "utf8")), values.reuse, flags.suite) as ReusedEntry[]) : [];
const caseIds = (values.cases ?? (reused.length ? [...new Set(reused.map((s) => s.caseId))].join(",") : SAMPLE_CASES.map((c) => c.id).join(",")))
  .split(",")
  .map((c) => c.trim());
for (const id of caseIds) {
  if (!SAMPLE_CASES.some((c) => c.id === id)) throw new Error(`Unknown sample case "${id}".`);
  if (!labelsFile.cases[id]) throw new Error(`No labels for "${id}" in evals/challenge-labels.json.`);
}

const promptVersion = hashValue({ SYSTEM_PROMPT, INSTRUCTIONS, PLAYBOOKS, STAGE_EFFORT, schemas: STAGE_IDS.map((s) => strictSchemaFor(s)) });
const date = new Date().toISOString();
const name = outputName(date, engine, flags);

const answerOf = (caseId: string, kind: AnswerKind) => labelledAnswer(caseId, kind, labelsFile.cases);

/** Earlier raw files stored the flawed-answer challenges as `planted`. */
function fromRaw(s: (typeof reused)[number]): CaseSample {
  return { ...s, challenges: s.challenges ?? (s.planted ?? []).map((p) => ({ kind: "flawed" as const, run: p.run })) };
}

async function pipelineSuite() {
  const rawFile = path.join(outDir, "raw", `${name}.json`);
  const reportFile = path.join(outDir, `${name}.md`);
  const summaryFile = path.join(outDir, `${name}.json`);
  const out = outputWriter([rawFile, reportFile, summaryFile]);
  mkdirSync(path.dirname(rawFile), { recursive: true });
  const samples: CaseSample[] = [];
  for (const caseId of caseIds) {
    const sample = SAMPLE_CASES.find((c) => c.id === caseId)!;
    const options = { caseId: engine === "mock" ? caseId : null, mock: engine === "mock" };
    const previous = reused.filter((s) => s.caseId === caseId).map(fromRaw);
    for (let run = 1; run <= (previous.length || runs); run++) {
      const kept = previous[run - 1];
      let pipeline = kept?.pipeline;
      // Said reused only when the pipeline run itself comes from the file.
      const reusedRun = pipeline !== undefined;
      if (!pipeline) {
        log(`${caseId} · run ${run} · pipeline…`);
        pipeline = await runPipeline(sample.text, options);
      }
      log(`${caseId} · run ${run} · ${pipeline.stages.filter((s) => s.ok).length}/${pipeline.stages.length} stages in ${(pipeline.wallMs / 1000).toFixed(0)} s${reusedRun ? " (reused)" : ""}`);

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
      out.write(rawFile, JSON.stringify(samples, null, 2));
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
  out.write(reportFile, report);
  out.write(summaryFile, `${JSON.stringify({ promptVersion, engine, summary }, null, 2)}\n`);
  process.stdout.write(`\n${report}\nWritten to ${reportFile} (raw outputs: ${rawFile})\n`);
}

async function interviewSuite() {
  const rawInterviews = path.join(outDir, "raw", `${name}.json`);
  // The pipelines run for this eval, in the format --reuse reads: a crash during the interviews keeps them.
  const rawPipelines = path.join(outDir, "raw", `${name}-pipelines.json`);
  const reportFile = path.join(outDir, `${name}.md`);
  const summaryFile = path.join(outDir, `${name}.json`);
  const out = outputWriter([rawInterviews, rawPipelines, reportFile, summaryFile]);
  mkdirSync(path.dirname(rawInterviews), { recursive: true });

  const { summary, solutions, skipped, freshPipelines, reusedWithoutOptions } = await runInterviewSuite(
    {
      caseIds,
      personas: flags.personas,
      interviews: flags.interviews,
      mock: engine === "mock",
      labels: labelsFile.cases,
      reused,
    },
    {
      log,
      // Written after every pipeline and every interview, so a crash keeps what is done.
      onPipeline: (pipelines) => out.write(rawPipelines, JSON.stringify(pipelines, null, 2)),
      onInterview: (_run, interviews) => out.write(rawInterviews, JSON.stringify(interviews, null, 2)),
    },
  );

  const version = interviewPromptVersion(promptVersion);
  const pipelinesFrom = values.reuse ? path.basename(values.reuse) : null;
  const report = renderInterviewReport(
    {
      date: date.slice(0, 16).replace("T", " ") + " UTC",
      engine,
      requestedModel: engine === "mock" ? "recorded runs" : engineEnv().model,
      cases: caseIds,
      interviewsPerPersona: flags.interviews,
      personas: flags.personas,
      promptVersion: version,
      tools: flags.interviewTools,
      pipelinesFrom,
      skipped,
      freshPipelines,
      labelsReviewedByHand: labelsFile.reviewedByHand,
    },
    summary,
    labelsFile.cases,
    solutions,
  );
  out.write(reportFile, report);
  out.write(
    summaryFile,
    `${JSON.stringify({ promptVersion: version, engine, tools: flags.interviewTools, pipelinesFrom, freshPipelines, reusedWithoutOptions, skipped, summary }, null, 2)}\n`,
  );
  const raw = [rawPipelines, rawInterviews].filter((file) => out.written.includes(file));
  process.stdout.write(`\n${report}\nWritten to ${reportFile} (raw outputs: ${raw.join(", ") || "none"})\n`);
}

function log(message: string) {
  process.stderr.write(`[eval] ${message}\n`);
}

(flags.suite === "interview" ? interviewSuite() : pipelineSuite()).catch((err) => {
  process.stderr.write(`[eval] failed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
