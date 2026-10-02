import { existsSync, writeFileSync } from "node:fs";
import { SAMPLE_CASES } from "@/lib/samples";
import { buildFactSheet } from "@/lib/interview/debrief";
import { INTERVIEWER_SYSTEM_PROMPT, INTERVIEWER_TOOLS_SYSTEM_PROMPT } from "@/lib/interview/prompt";
import { interviewReplyJsonSchema, interviewTurnJsonSchema, TURN_EFFORT } from "@/lib/interview/run-turn";
import { INTERVIEW_TOOLS } from "@/lib/interview/tools";
import { hashValue, initialSession, type Session } from "@/lib/store/machine";
import { CANDIDATE_EFFORT, CANDIDATE_PERSONAS, CANDIDATE_SYSTEM_PROMPT, candidateTurnJsonSchema } from "./candidate";
import { solutionTerms, summarizeInterviews, type InterviewSummary } from "./interview-metrics";
import type { CandidatePersona, InterviewRun, SolutionTerms } from "./interview-types";
import { ANSWER_KINDS, type AnswerKind, type CaseLabels, type CaseSample } from "./metrics";
import { runPipeline, type StageRecord } from "./run-case";
import { runInterview, type InterviewInput } from "./run-interview";

/**
 * The interview suite of `npm run eval`, kept out of the script so that it can be tested without spawning it: the
 * flags, the reused file and the output files of both suites, the labelled answer each persona follows, the pipeline
 * session each case starts from, and the interviews, run a few at a time. The script only parses the command line,
 * writes the files and prints the report.
 */

// ── Flags ───────────────────────────────────────────────────────────────────

export const SUITES = ["pipeline", "interview"] as const;
export type Suite = (typeof SUITES)[number];

/** The flags that only one suite reads: given to the other suite, they would be silently ignored. */
const SUITE_ONLY: Record<Suite, readonly string[]> = {
  pipeline: ["runs", "challenge-runs", "no-self-critique"],
  interview: ["interviews", "personas", "interview-tools"],
};

/** The command-line values these helpers read, as parseArgs returns them. */
export type EvalFlagValues = {
  suite?: string;
  interviews?: string;
  personas?: string;
  "interview-tools"?: string;
  runs?: string;
  "challenge-runs"?: string;
  "no-self-critique"?: boolean;
};

export type SuiteFlags = {
  suite: Suite;
  /** Interviews per case and persona. */
  interviews: number;
  /** In ANSWER_KINDS order, once each. */
  personas: CandidatePersona[];
  /** Tool mode for the interviewer (CONSULTANT_DOTS_INTERVIEW_TOOLS), which the script sets from this flag. */
  interviewTools: boolean;
};

export function countFlag(name: string, raw: string | undefined, min: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}.`);
  return n;
}

const given = (values: EvalFlagValues, name: string) => {
  const value = values[name as keyof EvalFlagValues];
  return value !== undefined && value !== false;
};

/** The suite and its flags, with their defaults; throws on an unknown value or a flag of the other suite. */
export function suiteFlags(values: EvalFlagValues): SuiteFlags {
  const suite = (values.suite ?? "pipeline") as Suite;
  if (!SUITES.includes(suite)) throw new Error(`Unknown suite "${values.suite}" (pipeline | interview).`);
  const other = SUITES.find((s) => s !== suite)!;
  const misplaced = SUITE_ONLY[other].filter((name) => given(values, name)).map((name) => `--${name}`);
  if (misplaced.length) {
    throw new Error(`${misplaced.join(", ")} only appl${misplaced.length > 1 ? "y" : "ies"} to --suite ${other}.`);
  }

  const names = (values.personas ?? ANSWER_KINDS.join(","))
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const name of names) {
    if (!(ANSWER_KINDS as readonly string[]).includes(name)) throw new Error(`Unknown persona "${name}" (flawed | control).`);
  }
  if (!names.length) throw new Error("--personas must name at least one persona (flawed | control).");

  const tools = values["interview-tools"] ?? "on";
  if (tools !== "on" && tools !== "off") throw new Error(`--interview-tools must be on or off, not "${tools}".`);

  return {
    suite,
    interviews: countFlag("interviews", values.interviews ?? "1", 1),
    personas: ANSWER_KINDS.filter((kind) => names.includes(kind)),
    interviewTools: tools === "on",
  };
}

// ── Output files ────────────────────────────────────────────────────────────

/**
 * The base name of an eval's files, from its start date (ISO). The pipeline suite keeps its name to the minute; the
 * interview suite's goes to the second and carries the tool mode when it is off, so that two interview evals started
 * in the same minute, or one per mode, never share a name.
 */
export function outputName(date: string, engine: string, flags: Pick<SuiteFlags, "suite" | "interviewTools">): string {
  const stamp = (chars: number) => date.slice(0, chars).replace(/[-:]/g, "").replace("T", "-");
  if (flags.suite === "pipeline") return `${stamp(16)}-${engine}`;
  return `${stamp(19)}-${engine}-interview${flags.interviewTools ? "" : "-tools-off"}`;
}

export type OutputWriter = {
  /** Writes one of the eval's files: exclusively the first time, then over what this eval wrote. */
  write: (file: string, content: string) => void;
  /** The files written so far, in the order of their first write. */
  written: string[];
};

/**
 * Writes an eval's files without ever replacing another eval's. Each one is checked before the eval starts, so a clash
 * costs no model call, and its first write is exclusive (flag wx), so an eval started meanwhile fails instead of
 * overwriting. Only the files listed here may be written.
 */
export function outputWriter(files: string[]): OutputWriter {
  const taken = (file: string) =>
    new Error(`${file} already exists: an eval never overwrites the files of another one (start it later, or pass another --out).`);
  const clash = files.find((file) => existsSync(file));
  if (clash) throw taken(clash);
  const written: string[] = [];
  return {
    written,
    write(file, content) {
      if (!files.includes(file)) throw new Error(`${file} is not one of this eval's files.`);
      const first = !written.includes(file);
      try {
        writeFileSync(file, content, { encoding: "utf8", flag: first ? "wx" : "w" });
      } catch (err) {
        throw first && (err as NodeJS.ErrnoException).code === "EEXIST" ? taken(file) : err;
      }
      if (first) written.push(file);
    },
  };
}

// ── Plans and sessions ──────────────────────────────────────────────────────

/** The labels file as the eval reads it: each case's labels, and the strong control answer they were written for. */
export type LabelledCases = Record<string, CaseLabels & { control: { answer: string } }>;

/** A labelled answer: the sample's flawed answer, or the control answer of the labels file. The persona's plan. */
export function labelledAnswer(caseId: string, kind: AnswerKind, labels: LabelledCases): string {
  if (kind === "flawed") {
    const sample = SAMPLE_CASES.find((c) => c.id === caseId);
    if (!sample) throw new Error(`Unknown sample case "${caseId}".`);
    return sample.flawedAnswer;
  }
  const answer = labels[caseId]?.control?.answer;
  if (!answer?.trim()) throw new Error(`No control answer for "${caseId}" in evals/challenge-labels.json.`);
  return answer;
}

/** An entry of a raw file of the pipeline suite, read back from JSON: only its pipeline run is used here. */
export type RawPipelineSample = Pick<CaseSample, "caseId" | "sample" | "pipeline">;

/** An entry of a raw file of the interview suite: an interview, which holds no pipeline run. */
const isInterview = (entry: unknown) => typeof entry === "object" && entry !== null && ("persona" in entry || "turns" in entry);
const hasPipeline = (entry: unknown) => Boolean((entry as RawPipelineSample | null)?.pipeline?.session);

/**
 * The entries of a --reuse file, checked before anything runs: a wrong file fails here instead of quietly running new
 * pipelines labelled reused. Both suites refuse a file of interviews. The pipeline suite keeps every entry as one of
 * its runs, so each must hold a pipeline session; the interview suite needs one per case and skips the others.
 */
export function checkReusedFile(entries: unknown, file: string, suite: Suite): RawPipelineSample[] {
  const expected = "--reuse takes a raw file of the pipeline suite, or the -pipelines.json file of an interview eval";
  if (!Array.isArray(entries)) throw new Error(`${file} is not a list of pipeline runs: ${expected}.`);
  if (entries.some(isInterview)) throw new Error(`${file} holds interviews, not pipeline runs: ${expected}.`);
  const missing = entries.findIndex((entry) => !hasPipeline(entry));
  if (suite === "pipeline" && missing >= 0) {
    throw new Error(`Entry ${missing + 1} of ${file} holds no pipeline run (no pipeline.session): ${expected}.`);
  }
  if (!entries.some(hasPipeline)) throw new Error(`${file} holds no pipeline run: ${expected}.`);
  return entries as RawPipelineSample[];
}

/** The leak check takes the recommended option and the pilot from the options stage. */
const hasOptions = (session: Session) => session.stages.options.status === "done" && session.stages.options.data != null;

export type ReusedSession = {
  sample: number;
  session: Session;
  /** The stage records of the same entry, for the log. */
  stages: StageRecord[];
  /** No run of the case in the file has its options stage done: the leak check is off for the case. */
  withoutOptions: boolean;
};

/**
 * The session a case's interviews start from in a reused raw file: the first sample, in file order, whose options
 * stage is done, so that the leak check has its terms; failing that, the first one that can host an interview (frame
 * and questions done), marked withoutOptions. Fields an older session lacks take their defaults, and its own
 * interview, if any, is dropped: the eval plays its own.
 */
export function reusableSession(samples: RawPipelineSample[], caseId: string): ReusedSession | null {
  let fallback: ReusedSession | null = null;
  for (const entry of samples) {
    const raw = entry?.caseId === caseId ? entry.pipeline?.session : undefined;
    if (!raw?.stages) continue;
    const fresh = initialSession();
    const session: Session = { ...fresh, ...raw, stages: { ...fresh.stages, ...raw.stages }, answers: raw.answers ?? {}, interview: null };
    if (!buildFactSheet(session)) continue;
    const kept = { sample: entry.sample, session, stages: entry.pipeline.stages ?? [], withoutOptions: false };
    if (hasOptions(session)) return kept;
    fallback ??= { ...kept, withoutOptions: true };
  }
  return fallback;
}

/** Same arguments as runInterview: one interview of the plan. */
export type InterviewJob = InterviewInput;

/**
 * Every interview of the eval, sample-major: should the eval stop, the first interview of each case and persona is
 * done before any second one.
 */
export function interviewJobs(
  cases: { caseId: string; session: Session }[],
  personas: CandidatePersona[],
  interviews: number,
  labels: LabelledCases,
): InterviewJob[] {
  const jobs: InterviewJob[] = [];
  for (let sample = 1; sample <= interviews; sample++) {
    for (const { caseId, session } of cases) {
      for (const persona of personas) jobs.push({ caseId, session, persona, plan: labelledAnswer(caseId, persona, labels), sample });
    }
  }
  return jobs;
}

// ── Running ─────────────────────────────────────────────────────────────────

/**
 * Interviews in flight at once. Each one waits on a single model call at a time; the CLI engine also queues beyond
 * its own limit, but a small pool keeps the API engine and the rate limits as calm as the app.
 */
export const INTERVIEW_CONCURRENCY = 3;

/** Runs fn over the items, at most `limit` at a time, started in order; the results come back in item order. */
export async function inPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export type InterviewJobOptions = { mock: boolean; concurrency?: number; signal?: AbortSignal };

/**
 * Plays the jobs a few at a time. onDone gets each finished run and every run finished so far, in plan order, so that
 * the caller can write them as they come.
 */
export async function runInterviewJobs(
  jobs: InterviewJob[],
  options: InterviewJobOptions,
  onDone: (run: InterviewRun, finished: InterviewRun[]) => void = () => undefined,
): Promise<InterviewRun[]> {
  const finished: (InterviewRun | undefined)[] = new Array(jobs.length);
  return inPool(jobs, options.concurrency ?? INTERVIEW_CONCURRENCY, async (job, index) => {
    // As in the pipeline suite: the case id only picks the recorded runs of a mock interview.
    const run = await runInterview(job, { mock: options.mock, caseId: options.mock ? job.caseId : null, signal: options.signal });
    finished[index] = run;
    onDone(run, finished.filter((r): r is InterviewRun => r !== undefined));
    return run;
  });
}

/** What cut an interview short, or failed its debrief, for the log line. */
function failureOf(run: InterviewRun): string | null {
  const failed = run.turns.find((t) => t.candidate.error || t.interviewer?.error);
  if (failed) {
    const [who, error] = failed.candidate.error ? ["candidate", failed.candidate.error] : ["interviewer", failed.interviewer!.error!];
    return `${who} failed at round ${failed.round}: ${error.code}`;
  }
  if (run.debrief?.error) return `debrief failed: ${run.debrief.error.code}`;
  return null;
}

/** One log line per finished interview: case, persona, sample, rounds, ending, score, level and coverage. */
export function describeInterview(run: InterviewRun, perPersona: number): string {
  const rounds = run.messages.filter((m) => m.role === "candidate").length;
  const asked = new Set(run.revealed.filter((id) => run.questionIds.includes(id))).size;
  const failure = failureOf(run);
  return (
    `${run.caseId} · ${run.persona} ${run.sample}/${perPersona} · ${rounds} round(s), ended by ${run.endedBy} · ` +
    `score ${run.score?.score ?? "n/a"} · level ${run.debrief?.data?.level ?? "n/a"} · coverage ${asked}/${run.questionIds.length}` +
    (failure ? ` · ${failure}` : "")
  );
}

export type InterviewSuiteConfig = {
  caseIds: string[];
  personas: CandidatePersona[];
  /** Interviews per case and persona. */
  interviews: number;
  mock: boolean;
  labels: LabelledCases;
  /** The entries of a raw file of the pipeline suite (--reuse); empty to run each case's pipeline here. */
  reused: RawPipelineSample[];
  concurrency?: number;
  signal?: AbortSignal;
};

export type InterviewSuiteHooks = {
  log?: (message: string) => void;
  /** After each pipeline run here: all of them so far, in the raw format that --reuse reads. */
  onPipeline?: (samples: CaseSample[]) => void;
  /** After each interview: every interview finished so far, in plan order. */
  onInterview?: (run: InterviewRun, runs: InterviewRun[]) => void;
};

export type InterviewSuiteResult = {
  /** In plan order. */
  runs: InterviewRun[];
  /** Per case: what a leak would look like, null when the case's pipeline has no options to take it from. */
  solutions: Record<string, SolutionTerms | null>;
  summary: InterviewSummary;
  /** Cases whose pipeline stopped before its clarification questions: no interview could start. */
  skipped: string[];
  /** Cases whose pipeline was run for this eval instead of being reused, in case order. */
  freshPipelines: string[];
  /** Reused cases with no run whose options stage is done in the file: interviewed, but not checked for leaks. */
  reusedWithoutOptions: string[];
};

/**
 * The interview suite: one pipeline session per case (reused, preferably a run whose options stage is done, or run
 * here once with the full pipeline, so that the recommended option and the pilot exist for the leak check), then
 * every case × persona × sample interview, then the summary. Engine failures end up in the runs, as in runInterview;
 * this throws only on a reused file that holds no pipeline run.
 */
export async function runInterviewSuite(config: InterviewSuiteConfig, hooks: InterviewSuiteHooks = {}): Promise<InterviewSuiteResult> {
  const log = hooks.log ?? (() => undefined);
  if (config.reused.length && !config.reused.some((s) => s?.pipeline?.session)) {
    throw new Error("The reused file holds no pipeline run: --reuse takes a raw file of the pipeline suite.");
  }

  const cases: { caseId: string; session: Session }[] = [];
  const solutions: Record<string, SolutionTerms | null> = {};
  const pipelines: CaseSample[] = [];
  const skipped: string[] = [];
  const freshPipelines: string[] = [];
  const reusedWithoutOptions: string[] = [];
  for (const caseId of config.caseIds) {
    const kept = reusableSession(config.reused, caseId);
    let session = kept?.session;
    if (kept) {
      log(
        `${caseId} · pipeline of sample ${kept.sample} reused: ${kept.stages.filter((s) => s.ok).length}/${kept.stages.length} stages` +
          (kept.withoutOptions ? ", no run of the case in the file has its options" : ""),
      );
      if (kept.withoutOptions) reusedWithoutOptions.push(caseId);
    } else {
      const sample = SAMPLE_CASES.find((c) => c.id === caseId);
      if (!sample) throw new Error(`Unknown sample case "${caseId}".`);
      log(`${caseId} · pipeline…`);
      const pipeline = await runPipeline(sample.text, { caseId: config.mock ? caseId : null, mock: config.mock, signal: config.signal });
      log(`${caseId} · pipeline: ${pipeline.stages.filter((s) => s.ok).length}/${pipeline.stages.length} stages in ${(pipeline.wallMs / 1000).toFixed(0)} s`);
      pipelines.push({ caseId, sample: 1, pipeline, challenges: [], selfCritique: null });
      freshPipelines.push(caseId);
      hooks.onPipeline?.(pipelines);
      session = { ...pipeline.session, interview: null };
    }

    const factSheet = session ? buildFactSheet(session) : null;
    if (!session || !factSheet) {
      solutions[caseId] = null;
      skipped.push(caseId);
      log(`${caseId} · no interview: the pipeline stopped before its clarification questions`);
      continue;
    }
    solutions[caseId] = solutionTerms(session, factSheet);
    const terms = solutions[caseId]?.terms;
    log(`${caseId} · leak check: ${terms ? terms.join(", ") || "no term outside the case and the fact sheet" : "off, the pipeline has no options"}`);
    cases.push({ caseId, session });
  }

  const jobs = interviewJobs(cases, config.personas, config.interviews, config.labels);
  const runs = await runInterviewJobs(jobs, { mock: config.mock, concurrency: config.concurrency, signal: config.signal }, (run, finished) => {
    log(describeInterview(run, config.interviews));
    hooks.onInterview?.(run, finished);
  });
  return { runs, solutions, summary: summarizeInterviews(runs, config.labels, solutions), skipped, freshPipelines, reusedWithoutOptions };
}

/**
 * Tells interview results apart the way promptVersion tells pipeline results apart: the pipeline's version (the
 * sessions and the debrief come from it), the interviewer's prompts, tools and schemas, and the candidate's.
 */
export function interviewPromptVersion(pipelineVersion: string): string {
  return hashValue({
    pipelineVersion,
    INTERVIEWER_SYSTEM_PROMPT,
    INTERVIEWER_TOOLS_SYSTEM_PROMPT,
    INTERVIEW_TOOLS,
    TURN_EFFORT,
    CANDIDATE_SYSTEM_PROMPT,
    CANDIDATE_PERSONAS,
    CANDIDATE_EFFORT,
    schemas: [interviewTurnJsonSchema(), interviewReplyJsonSchema(), candidateTurnJsonSchema()],
  });
}
