import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runLiveEngine } from "@/lib/engine/dispatch";
import { engineEnv } from "@/lib/engine/config";
import { renderInterviewReport } from "@/lib/eval/interview-report";
import { solutionTerms } from "@/lib/eval/interview-metrics";
import {
  checkReusedFile,
  countFlag,
  describeInterview,
  inPool,
  INTERVIEW_CONCURRENCY,
  interviewJobs,
  interviewPromptVersion,
  labelledAnswer,
  outputName,
  outputWriter,
  reusableSession,
  runInterviewSuite,
  suiteFlags,
  type LabelledCases,
  type RawPipelineSample,
} from "@/lib/eval/interview-suite";
import type { CandidateTurn, InterviewRun } from "@/lib/eval/interview-types";
import { ANSWER_KINDS, type CaseSample } from "@/lib/eval/metrics";
import { runPipeline, type ChallengeRun, type PipelineRun, type StageRecord } from "@/lib/eval/run-case";
import { runInterview } from "@/lib/eval/run-interview";
import { buildFactSheet, INTERVIEW_OPENING } from "@/lib/interview/debrief";
import { INTERVIEW_MAX_ROUNDS } from "@/lib/interview/schema";
import { PIPELINE_STAGE_IDS } from "@/lib/schemas";
import { SAMPLE_CASES } from "@/lib/samples";
import type { Session } from "@/lib/store/machine";
import { fixture, sessionWith } from "./helpers";

// No live model call in these tests: the engine is a stub that every test checks was never called.
vi.mock("@/lib/engine/dispatch", () => ({ runLiveEngine: vi.fn() }));
// The real pipeline and interviews, watched: the tests read what the suite asked for, and fake a few.
vi.mock("@/lib/eval/run-case", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/eval/run-case")>();
  return { ...actual, runPipeline: vi.fn(actual.runPipeline) };
});
vi.mock("@/lib/eval/run-interview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/eval/run-interview")>();
  return { ...actual, runInterview: vi.fn(actual.runInterview) };
});

const labels = (JSON.parse(readFileSync("evals/challenge-labels.json", "utf8")) as { cases: LabelledCases }).cases;
/** The pipeline runs of the latest live eval, read only: the sessions a reused interview eval starts from. */
const CLI_RUNS = JSON.parse(readFileSync("evals/results/runs-2026-10-01-cli.json", "utf8")) as CaseSample[];

const SAMPLE = SAMPLE_CASES[0];
const CASE_ID = SAMPLE.id;

/** A session as a full pipeline run leaves it: every stage done and the gate passed. */
const fullSession = (patch: Partial<Session> = {}) => sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true, ...patch });
const pipelineOf = (session: Session): PipelineRun => ({ session, stages: [], wallMs: 0 });
const entry = (caseId: string, sample: number, session: Session): RawPipelineSample => ({ caseId, sample, pipeline: pipelineOf(session) });

const candidate = (patch: Partial<CandidateTurn> = {}): CandidateTurn => ({
  message: "Mon message.",
  truncated: false,
  originalChars: 12,
  retried: false,
  ms: 10,
  model: "candidate-model",
  costUsd: 0,
  error: null,
  ...patch,
});

const debrief = (patch: Partial<ChallengeRun> = {}): ChallengeRun => ({
  stage: "challenge",
  ok: true,
  ms: 10,
  meta: { ms: 10, model: "debrief-model", costUsd: 0, notes: [] },
  error: null,
  data: fixture("challenge"),
  ...patch,
});

/** A finished interview of two rounds that revealed Q1, built by hand. */
function fakeRun(patch: Partial<InterviewRun> = {}): InterviewRun {
  return {
    caseId: CASE_ID,
    persona: "flawed",
    sample: 1,
    tools: true,
    turns: [],
    messages: [
      { role: "interviewer", text: INTERVIEW_OPENING },
      { role: "candidate", text: "Premier message." },
      { role: "interviewer", text: "Pouvez-vous préciser ?" },
      { role: "candidate", text: "Second message." },
      { role: "interviewer", text: "Merci." },
    ],
    revealed: ["Q1", "Q9"],
    observations: [],
    endedBy: "client",
    debrief: debrief(),
    score: { score: 62, keyQuestions: { asked: ["Q1"], missed: ["Q2", "Q3"], total: 3 }, level: "correct", blockingFlags: 0, roundsUsed: 2, maxRounds: 8 },
    questionIds: ["Q1", "Q2", "Q3"],
    wallMs: 100,
    ...patch,
  };
}

/** The next `n` interviews return a hand-built run for their job instead of playing it. */
function fakeInterviews(n: number, wait: (index: number) => Promise<void> = async () => undefined) {
  for (let i = 0; i < n; i++) {
    vi.mocked(runInterview).mockImplementationOnce(async (input) => {
      await wait(i);
      return fakeRun({ caseId: input.caseId, persona: input.persona, sample: input.sample });
    });
  }
}

let info: MockInstance<typeof console.info>;
let warn: MockInstance<typeof console.warn>;
let toolsEnv: string | undefined;

beforeEach(() => {
  toolsEnv = process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS;
  delete process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS;
  info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  if (toolsEnv === undefined) delete process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS;
  else process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS = toolsEnv;
  // mockClear, not mockReset: the watched functions keep running the real ones; fakes are only ever set once.
  vi.mocked(runPipeline).mockClear();
  vi.mocked(runInterview).mockClear();
  vi.mocked(runLiveEngine).mockReset();
  info.mockRestore();
  warn.mockRestore();
});

// ── Flags ───────────────────────────────────────────────────────────────────

describe("suite flags", () => {
  it("defaults to the pipeline suite, and the interview flags to one interview of each persona in tool mode", () => {
    expect(suiteFlags({})).toEqual({ suite: "pipeline", interviews: 1, personas: ["flawed", "control"], interviewTools: true });
    expect(suiteFlags({ suite: "interview" })).toEqual({ suite: "interview", interviews: 1, personas: ["flawed", "control"], interviewTools: true });
    // parseArgs gives the boolean flag a default of false: that is not a flag given to the wrong suite.
    expect(suiteFlags({ suite: "interview", "no-self-critique": false }).suite).toBe("interview");
  });

  it("reads the interview flags: the count, each persona once in label order, the tool mode", () => {
    expect(suiteFlags({ suite: "interview", interviews: "3", personas: " control , flawed,control,", "interview-tools": "off" })).toEqual({
      suite: "interview",
      interviews: 3,
      personas: ["flawed", "control"],
      interviewTools: false,
    });
    expect(suiteFlags({ suite: "interview", personas: "control" }).personas).toEqual(["control"]);
    expect(suiteFlags({ suite: "interview", personas: "flawed", "interview-tools": "on" })).toMatchObject({ personas: ["flawed"], interviewTools: true });
  });

  it("rejects an unknown suite, persona or tool mode, and a count that is not a positive integer", () => {
    expect(() => suiteFlags({ suite: "interviews" })).toThrow('Unknown suite "interviews" (pipeline | interview).');
    expect(() => suiteFlags({ suite: "interview", personas: "flawed,expert" })).toThrow('Unknown persona "expert" (flawed | control).');
    expect(() => suiteFlags({ suite: "interview", personas: "Control" })).toThrow('Unknown persona "Control"');
    expect(() => suiteFlags({ suite: "interview", personas: " , " })).toThrow("--personas must name at least one persona (flawed | control).");
    expect(() => suiteFlags({ suite: "interview", "interview-tools": "yes" })).toThrow('--interview-tools must be on or off, not "yes".');
    expect(() => suiteFlags({ suite: "interview", "interview-tools": "" })).toThrow("--interview-tools must be on or off");
    for (const bad of ["0", "-1", "1.5", "deux", ""]) {
      expect(() => suiteFlags({ suite: "interview", interviews: bad })).toThrow("--interviews must be an integer >= 1.");
    }
  });

  it("rejects a flag of the other suite instead of ignoring it", () => {
    expect(() => suiteFlags({ suite: "interview", runs: "3" })).toThrow("--runs only applies to --suite pipeline.");
    expect(() => suiteFlags({ suite: "interview", "challenge-runs": "0", "no-self-critique": true })).toThrow(
      "--challenge-runs, --no-self-critique only apply to --suite pipeline.",
    );
    expect(() => suiteFlags({ interviews: "2" })).toThrow("--interviews only applies to --suite interview.");
    expect(() => suiteFlags({ suite: "pipeline", personas: "flawed", "interview-tools": "off" })).toThrow(
      "--personas, --interview-tools only apply to --suite interview.",
    );
  });

  it("checks counts as the pipeline suite always did", () => {
    expect(countFlag("runs", "2", 1)).toBe(2);
    expect(countFlag("challenge-runs", "0", 0)).toBe(0);
    expect(() => countFlag("runs", "0", 1)).toThrow("--runs must be an integer >= 1.");
    expect(() => countFlag("challenge-runs", undefined, 0)).toThrow("--challenge-runs must be an integer >= 0.");
  });

  it("gives the interviewer the tool mode the script sets from the flag", () => {
    process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS = suiteFlags({ suite: "interview", "interview-tools": "off" }).interviewTools ? "on" : "off";
    expect(engineEnv().interviewTools).toBe(false);
    process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS = suiteFlags({ suite: "interview" }).interviewTools ? "on" : "off";
    expect(engineEnv().interviewTools).toBe(true);
  });
});

// ── Output files ────────────────────────────────────────────────────────────

/** Scratch directories of these tests, removed at the end. */
const scratch: string[] = [];
const scratchDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eval-interview-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("outputName", () => {
  it("names an interview eval to the second, with the tool mode when it is off, and a pipeline eval to the minute", () => {
    const at = "2026-10-02T15:04:12.345Z";
    expect(outputName(at, "cli", { suite: "interview", interviewTools: true })).toBe("20261002-150412-cli-interview");
    expect(outputName(at, "cli", { suite: "interview", interviewTools: false })).toBe("20261002-150412-cli-interview-tools-off");
    expect(outputName("2026-10-02T15:04:13.001Z", "cli", { suite: "interview", interviewTools: true })).not.toBe(
      outputName(at, "cli", { suite: "interview", interviewTools: true }),
    );
    expect(outputName(at, "mock", { suite: "pipeline", interviewTools: true })).toBe("20261002-1504-mock");
  });
});

describe("outputWriter", () => {
  it("refuses, before anything is written, an eval one of whose files already exists", () => {
    const dir = scratchDir();
    const [report, raw] = [path.join(dir, "a.md"), path.join(dir, "a.json")];
    writeFileSync(raw, "autre eval", "utf8");
    expect(() => outputWriter([report, raw])).toThrow(`${raw} already exists: an eval never overwrites the files of another one`);
    expect(existsSync(report)).toBe(false);
    expect(readFileSync(raw, "utf8")).toBe("autre eval");
  });

  it("writes each file exclusively the first time, then over its own earlier write", () => {
    const dir = scratchDir();
    const [raw, report] = [path.join(dir, "raw.json"), path.join(dir, "report.md")];
    const out = outputWriter([raw, report]);
    out.write(raw, "[1]");
    out.write(raw, "[1,2]");
    expect(readFileSync(raw, "utf8")).toBe("[1,2]");
    expect(out.written).toEqual([raw]);

    // Another eval took the name between the check and the first write: it keeps its file.
    writeFileSync(report, "autre eval", "utf8");
    expect(() => out.write(report, "rapport")).toThrow(`${report} already exists`);
    expect(readFileSync(report, "utf8")).toBe("autre eval");
    expect(out.written).toEqual([raw]);
    expect(() => out.write(path.join(dir, "autre.md"), "x")).toThrow("is not one of this eval's files.");
  });
});

// ── Plans and sessions ──────────────────────────────────────────────────────

describe("checkReusedFile", () => {
  const file = "x.json";
  const expected = "--reuse takes a raw file of the pipeline suite, or the -pipelines.json file of an interview eval.";

  it("takes the pipeline runs of an earlier eval, for both suites", () => {
    expect(checkReusedFile(CLI_RUNS, file, "pipeline")).toBe(CLI_RUNS);
    expect(checkReusedFile(CLI_RUNS, file, "interview")).toBe(CLI_RUNS);
  });

  it("refuses a file of interviews, even mixed with pipeline runs, for both suites", () => {
    for (const suite of ["pipeline", "interview"] as const) {
      expect(() => checkReusedFile([fakeRun()], file, suite)).toThrow(`x.json holds interviews, not pipeline runs: ${expected}`);
      expect(() => checkReusedFile([...CLI_RUNS, { caseId: CASE_ID, sample: 2, turns: [] }], file, suite)).toThrow("holds interviews");
    }
  });

  it("refuses anything but a list holding a pipeline run", () => {
    for (const suite of ["pipeline", "interview"] as const) {
      expect(() => checkReusedFile({ promptVersion: "abc", summary: {} }, file, suite)).toThrow(`x.json is not a list of pipeline runs: ${expected}`);
      expect(() => checkReusedFile([], file, suite)).toThrow(`x.json holds no pipeline run: ${expected}`);
      expect(() => checkReusedFile([{ caseId: CASE_ID, sample: 1 }], file, suite)).toThrow("holds no pipeline run");
    }
  });

  it("needs a pipeline session in every entry for the pipeline suite, which keeps each one as a run", () => {
    const partial = [CLI_RUNS[0], { caseId: CASE_ID, sample: 2, pipeline: { stages: [] } }];
    expect(() => checkReusedFile(partial, file, "pipeline")).toThrow(`Entry 2 of x.json holds no pipeline run (no pipeline.session): ${expected}`);
    // The interview suite takes one session per case, and skips the others.
    expect(checkReusedFile(partial, file, "interview")).toBe(partial);
  });
});

describe("labelledAnswer", () => {
  it("gives the flawed persona the sample's flawed answer and the control persona the labelled control answer", () => {
    for (const sample of SAMPLE_CASES) {
      expect(labelledAnswer(sample.id, "flawed", labels)).toBe(sample.flawedAnswer);
      expect(labelledAnswer(sample.id, "control", labels)).toBe(labels[sample.id].control.answer);
    }
  });

  it("throws on a case it has no answer for", () => {
    expect(() => labelledAnswer("inconnu", "flawed", labels)).toThrow('Unknown sample case "inconnu".');
    expect(() => labelledAnswer("inconnu", "control", labels)).toThrow('No control answer for "inconnu" in evals/challenge-labels.json.');
    const blank = { [CASE_ID]: { ...labels[CASE_ID], control: { ...labels[CASE_ID].control, answer: "  " } } };
    expect(() => labelledAnswer(CASE_ID, "control", blank)).toThrow(`No control answer for "${CASE_ID}"`);
  });
});

describe("reusableSession", () => {
  it("takes sample 1 of each case from the latest live eval, a session that can host an interview", () => {
    for (const sample of SAMPLE_CASES) {
      const kept = reusableSession(CLI_RUNS, sample.id)!;
      expect(kept.sample).toBe(1);
      expect(kept.session.caseText).toBe(CLI_RUNS.find((s) => s.caseId === sample.id)!.pipeline.session.caseText);
      expect(kept.session.interview).toBeNull();
      const factSheet = buildFactSheet(kept.session)!;
      expect(factSheet.clientAnswers.length).toBeGreaterThan(0);
      // A full run: the recommended option and the pilot are there for the leak check.
      const terms = solutionTerms(kept.session, factSheet)!;
      expect(terms.option).not.toBe("");
      expect(terms.pilot).not.toBe("");
    }
  });

  it("takes the first sample of the case, in file order, whose frame and questions are done", () => {
    const samples = [
      entry(CASE_ID, 1, sessionWith(["classify", "frame"])),
      entry("autre-cas", 1, fullSession({ caseText: "Autre cas." })),
      entry(CASE_ID, 3, fullSession({ caseText: "Troisième." })),
      entry(CASE_ID, 2, fullSession({ caseText: "Deuxième." })),
    ];
    expect(reusableSession(samples, CASE_ID)).toMatchObject({ sample: 3, session: { caseText: "Troisième." } });
    expect(reusableSession(samples, "autre-cas")?.session.caseText).toBe("Autre cas.");
    expect(reusableSession(samples, "absent")).toBeNull();
    expect(reusableSession([entry(CASE_ID, 1, sessionWith(["classify"]))], CASE_ID)).toBeNull();
  });

  it("prefers the first sample whose options are done, so the leak check has its terms, then falls back", () => {
    const noOptions = (caseText: string) => sessionWith(["classify", "frame", "questions"], { gatePassed: true, caseText });
    const failedOptions = fullSession({ caseText: "Options en échec." });
    failedOptions.stages.options = { ...failedOptions.stages.options, status: "error", data: null };
    const samples = [
      entry(CASE_ID, 1, noOptions("Sans options.")),
      entry(CASE_ID, 2, failedOptions),
      entry(CASE_ID, 3, fullSession({ caseText: "Avec options." })),
      entry(CASE_ID, 4, fullSession({ caseText: "Avec options, plus tard." })),
    ];
    expect(reusableSession(samples, CASE_ID)).toMatchObject({ sample: 3, session: { caseText: "Avec options." }, withoutOptions: false });

    const fallback = reusableSession(samples.slice(0, 2), CASE_ID)!;
    expect(fallback).toMatchObject({ sample: 1, session: { caseText: "Sans options." }, withoutOptions: true });
    expect(solutionTerms(fallback.session, buildFactSheet(fallback.session)!)).toBeNull();
  });

  it("skips malformed entries, fills the fields an older session lacks and drops a stored interview", () => {
    const old = fullSession({ answers: { Q1: "Le DAF tranche." } }) as Partial<Session>;
    delete old.interview;
    const stored = { ...fullSession(), interview: { status: "done" } } as unknown as Session;
    const samples = [
      { caseId: CASE_ID, sample: 1 },
      { caseId: CASE_ID, sample: 2, pipeline: { session: { caseText: "Sans étapes." } } },
      null,
      { caseId: CASE_ID, sample: 4, pipeline: pipelineOf(old as Session) },
    ] as unknown as RawPipelineSample[];
    const kept = reusableSession(samples, CASE_ID)!;
    expect(kept.sample).toBe(4);
    expect(kept.session.interview).toBeNull();
    expect(buildFactSheet(kept.session)?.clientAnswers.find((a) => a.id === "Q1")?.answer).toBe("Le DAF tranche.");

    const noAnswers = { ...fullSession() } as Partial<Session>;
    delete noAnswers.answers;
    expect(reusableSession([entry(CASE_ID, 1, noAnswers as Session)], CASE_ID)?.session.answers).toEqual({});
    expect(reusableSession([entry(CASE_ID, 1, stored)], CASE_ID)?.session.interview).toBeNull();
  });
});

describe("interviewJobs", () => {
  it("plans every case × persona × sample, sample-major, each persona with its labelled answer", () => {
    const a = fullSession();
    const b = fullSession({ caseText: "Autre." });
    const jobs = interviewJobs(
      [
        { caseId: "data-platform", session: a },
        { caseId: "cloud-industriel", session: b },
      ],
      ["flawed", "control"],
      2,
      labels,
    );
    expect(jobs.map((j) => `${j.caseId}:${j.persona}:${j.sample}`)).toEqual([
      "data-platform:flawed:1",
      "data-platform:control:1",
      "cloud-industriel:flawed:1",
      "cloud-industriel:control:1",
      "data-platform:flawed:2",
      "data-platform:control:2",
      "cloud-industriel:flawed:2",
      "cloud-industriel:control:2",
    ]);
    expect(jobs[0].session).toBe(a);
    expect(jobs[2].session).toBe(b);
    expect(jobs[0].plan).toBe(SAMPLE.flawedAnswer);
    expect(jobs[3].plan).toBe(labels["cloud-industriel"].control.answer);
    expect(interviewJobs([{ caseId: CASE_ID, session: a }], ["control"], 1, labels).map((j) => j.persona)).toEqual(["control"]);
    expect(interviewJobs([], ["flawed"], 3, labels)).toEqual([]);
  });
});

// ── Running ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("inPool", () => {
  it("runs at most `limit` items at a time, starts them in order and returns the results in item order", async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const results = await inPool([30, 5, 20, 1, 10], 2, async (ms, index) => {
      started.push(index);
      active++;
      peak = Math.max(peak, active);
      await sleep(ms);
      active--;
      return ms * 2;
    });
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(results).toEqual([60, 10, 40, 2, 20]);
  });

  it("handles no items, a limit above the item count and a limit below one", async () => {
    const fn = vi.fn(async (n: number) => n);
    expect(await inPool([], 3, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
    expect(await inPool([1, 2], 5, fn)).toEqual([1, 2]);
    expect(await inPool([1, 2, 3], 0, fn)).toEqual([1, 2, 3]);
  });

  it("rejects when an item throws", async () => {
    await expect(inPool([1, 2], 2, async (n) => (n === 2 ? Promise.reject(new Error("boom")) : n))).rejects.toThrow("boom");
  });
});

describe("describeInterview", () => {
  it("logs case, persona, sample, rounds, ending, score, level and coverage of the case's questions", () => {
    expect(describeInterview(fakeRun({ persona: "control", sample: 2 }), 3)).toBe(
      `${CASE_ID} · control 2/3 · 2 round(s), ended by client · score 62 · level ${fixture("challenge").level} · coverage 1/3`,
    );
  });

  it("says what failed: the candidate, the interviewer, or the debrief", () => {
    const candidateFailed = fakeRun({
      endedBy: "error",
      turns: [{ round: 1, candidate: candidate({ message: "", error: { code: "usage_limit", message: "Limite." } }), interviewer: null }],
      messages: [{ role: "interviewer", text: INTERVIEW_OPENING }],
      revealed: [],
      debrief: null,
      score: null,
    });
    expect(describeInterview(candidateFailed, 1)).toBe(
      `${CASE_ID} · flawed 1/1 · 0 round(s), ended by error · score n/a · level n/a · coverage 0/3 · candidate failed at round 1: usage_limit`,
    );

    const interviewerFailed = fakeRun({
      endedBy: "error",
      turns: [
        { round: 1, candidate: candidate(), interviewer: { ok: true, ms: 5, data: null, meta: null, error: null } },
        { round: 2, candidate: candidate(), interviewer: { ok: false, ms: 5, data: null, meta: null, error: { code: "timeout", message: "Délai." } } },
      ],
    });
    expect(describeInterview(interviewerFailed, 1)).toMatch(/ended by error · score 62 · .* · interviewer failed at round 2: timeout$/);

    const debriefFailed = fakeRun({
      endedBy: "max_rounds",
      debrief: debrief({ ok: false, data: null, meta: null, error: { code: "overloaded", message: "Surchargé." } }),
      score: null,
    });
    expect(describeInterview(debriefFailed, 1)).toBe(
      `${CASE_ID} · flawed 1/1 · 2 round(s), ended by max_rounds · score n/a · level n/a · coverage 1/3 · debrief failed: overloaded`,
    );
  });
});

describe("runInterviewSuite, mock", () => {
  it("plays one case with both personas on the recorded runs: its pipeline once, two debriefed interviews, the report", async () => {
    const logs: string[] = [];
    const pipelineWrites: CaseSample[][] = [];
    const interviewWrites: { run: InterviewRun; runs: InterviewRun[] }[] = [];
    const result = await runInterviewSuite(
      { caseIds: [CASE_ID], personas: [...ANSWER_KINDS], interviews: 1, mock: true, labels, reused: [] },
      {
        log: (message) => logs.push(message),
        onPipeline: (samples) => pipelineWrites.push([...samples]),
        onInterview: (run, runs) => interviewWrites.push({ run, runs: [...runs] }),
      },
    );

    // The full pipeline ran once, on the recorded runs, and was handed over in the format --reuse reads.
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(SAMPLE.text, { caseId: CASE_ID, mock: true, signal: undefined });
    expect(pipelineWrites).toHaveLength(1);
    const [written] = pipelineWrites[0];
    expect(written).toMatchObject({ caseId: CASE_ID, sample: 1, challenges: [], selfCritique: null });
    expect(written.pipeline.stages.every((s) => s.ok)).toBe(true);
    expect(reusableSession(pipelineWrites[0], CASE_ID)?.sample).toBe(1);

    // Each persona played its labelled answer, against the same session.
    const calls = vi.mocked(runInterview).mock.calls;
    expect(calls.map(([input, options]) => [input.persona, input.plan, input.sample, options])).toEqual([
      ["flawed", SAMPLE.flawedAnswer, 1, { mock: true, caseId: CASE_ID, signal: undefined }],
      ["control", labels[CASE_ID].control.answer, 1, { mock: true, caseId: CASE_ID, signal: undefined }],
    ]);
    expect(calls[0][0].session).toBe(calls[1][0].session);
    expect(calls[0][0].session.interview).toBeNull();

    const { runs, summary, solutions, skipped, freshPipelines, reusedWithoutOptions } = result;
    expect(skipped).toEqual([]);
    expect(freshPipelines).toEqual([CASE_ID]);
    expect(reusedWithoutOptions).toEqual([]);
    expect(runs.map((r) => [r.caseId, r.persona, r.sample])).toEqual([
      [CASE_ID, "flawed", 1],
      [CASE_ID, "control", 1],
    ]);
    for (const run of runs) {
      expect(run).toMatchObject({ tools: true, endedBy: "max_rounds", debrief: { stage: "challenge", ok: true, error: null } });
      expect(run.turns).toHaveLength(INTERVIEW_MAX_ROUNDS);
      expect(run.debrief?.data?.level).toBe(fixture("challenge").level);
      expect(run.score?.score).toEqual(expect.any(Number));
    }

    // The summary has the two interviews, each debriefed and scored against its persona's labels.
    expect(summary.interviews).toBe(2);
    for (const persona of ANSWER_KINDS) {
      expect(summary.byPersona[persona]).toMatchObject({ interviews: 1, completed: { value: 1, num: 1, den: 1 } });
      expect(summary.byPersona[persona].debrief.interviews).toBe(1);
      expect(summary.perCase[CASE_ID][persona].levels).toEqual([fixture("challenge").level]);
    }
    expect(summary.overall.debrief.interviews).toBe(2);
    expect(summary.latencyMs.debrief.p50).toEqual(expect.any(Number));
    expect(summary.uncheckedCases).toEqual([]);

    // The leak check reads the solution of the pipeline that ran.
    const session = written.pipeline.session;
    expect(solutions).toEqual({ [CASE_ID]: solutionTerms(session, buildFactSheet(session)!) });
    expect(solutions[CASE_ID]?.terms.length).toBeGreaterThan(0);

    // Written after each interview: every finished one so far, in plan order.
    expect(interviewWrites).toHaveLength(2);
    expect(interviewWrites[0].runs).toEqual([interviewWrites[0].run]);
    expect(interviewWrites[1].runs.map((r) => r.persona)).toEqual(["flawed", "control"]);

    expect(logs.slice(0, 3)).toEqual([
      `${CASE_ID} · pipeline…`,
      expect.stringMatching(new RegExp(`^${CASE_ID} · pipeline: 9/9 stages in \\d+ s$`)),
      `${CASE_ID} · leak check: ${solutions[CASE_ID]!.terms.join(", ")}`,
    ]);
    expect(logs.slice(3).sort()).toEqual(runs.map((run) => describeInterview(run, 1)).sort());

    const report = renderInterviewReport(
      {
        date: "2026-10-02 12:00 UTC",
        engine: "mock",
        requestedModel: "recorded runs",
        cases: [CASE_ID],
        interviewsPerPersona: 1,
        personas: ["flawed", "control"],
        promptVersion: "abcd1234",
        tools: true,
        pipelinesFrom: null,
        skipped,
        freshPipelines,
        labelsReviewedByHand: false,
      },
      summary,
      labels,
      solutions,
    );
    expect(report).toContain("1 interview(s) per case and persona (flawed and control), 2 in total · prompt version `abcd1234` · interviewer in tool mode");
    expect(report).toContain("| Interviews completed | 1/1 (100 %) | 1/1 (100 %) | 2/2 (100 %) |");
    expect(report).toContain(`| ${CASE_ID} | flawed |`);
    expect(report).toContain(`| ${CASE_ID} | control |`);
    expect(report).toContain("Mock engine: recorded turns are replayed");
    expect(runLiveEngine).not.toHaveBeenCalled();
  }, 120_000);

  it("reuses the first sample of a raw pipeline file, without a pipeline run, in structured mode", async () => {
    process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS = "off";
    const logs: string[] = [];
    const onPipeline = vi.fn();
    const caseId = "genai-assurance";
    const { runs, summary, solutions, freshPipelines, reusedWithoutOptions } = await runInterviewSuite(
      { caseIds: [caseId], personas: ["control"], interviews: 2, mock: true, labels, reused: CLI_RUNS },
      { log: (message) => logs.push(message), onPipeline },
    );

    expect(runPipeline).not.toHaveBeenCalled();
    expect(onPipeline).not.toHaveBeenCalled();
    expect(freshPipelines).toEqual([]);
    expect(reusedWithoutOptions).toEqual([]);
    expect(logs[0]).toBe(`${caseId} · pipeline of sample 1 reused: 9/9 stages`);
    const reused = reusableSession(CLI_RUNS, caseId)!.session;
    for (const [input, options] of vi.mocked(runInterview).mock.calls) {
      expect(input).toMatchObject({ caseId, persona: "control", plan: labels[caseId].control.answer });
      expect(input.session).toEqual(reused);
      expect(options).toEqual({ mock: true, caseId, signal: undefined });
    }
    expect(runs.map((r) => [r.persona, r.sample, r.tools, r.debrief?.ok])).toEqual([
      ["control", 1, false, true],
      ["control", 2, false, true],
    ]);
    expect(summary).toMatchObject({ interviews: 2, byPersona: { flawed: { interviews: 0 }, control: { interviews: 2, completed: { value: 1 } } } });
    expect(solutions[caseId]).toEqual(solutionTerms(reused, buildFactSheet(reused)!));
    expect(runLiveEngine).not.toHaveBeenCalled();
  }, 120_000);
});

describe("runInterviewSuite, wiring", () => {
  it("live, never passes the case id: it only picks the recorded runs of a mock interview", async () => {
    fakeInterviews(2);
    const { runs } = await runInterviewSuite({
      caseIds: [CASE_ID],
      personas: [...ANSWER_KINDS],
      interviews: 1,
      mock: false,
      labels,
      reused: [entry(CASE_ID, 1, fullSession())],
    });
    expect(runs).toHaveLength(2);
    expect(vi.mocked(runInterview).mock.calls.map(([, options]) => options)).toEqual([
      { mock: false, caseId: null, signal: undefined },
      { mock: false, caseId: null, signal: undefined },
    ]);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it(`plays ${INTERVIEW_CONCURRENCY} interviews at a time at most, and returns them in plan order`, async () => {
    expect(INTERVIEW_CONCURRENCY).toBe(3);
    let active = 0;
    let peak = 0;
    fakeInterviews(8, async (index) => {
      active++;
      peak = Math.max(peak, active);
      // Later jobs finish first: the order of the result must not depend on it.
      await sleep(40 - index * 4);
      active--;
    });
    const finished: string[] = [];
    const { runs } = await runInterviewSuite(
      { caseIds: [CASE_ID, "cloud-industriel"], personas: [...ANSWER_KINDS], interviews: 2, mock: false, labels, reused: [entry(CASE_ID, 1, fullSession()), entry("cloud-industriel", 1, fullSession())] },
      { onInterview: (_run, done) => finished.push(done.map((r) => `${r.caseId}:${r.persona}:${r.sample}`).join(" ")) },
    );
    expect(peak).toBe(INTERVIEW_CONCURRENCY);
    expect(runs.map((r) => `${r.caseId}:${r.persona}:${r.sample}`)).toEqual([
      `${CASE_ID}:flawed:1`,
      `${CASE_ID}:control:1`,
      "cloud-industriel:flawed:1",
      "cloud-industriel:control:1",
      `${CASE_ID}:flawed:2`,
      `${CASE_ID}:control:2`,
      "cloud-industriel:flawed:2",
      "cloud-industriel:control:2",
    ]);
    expect(finished).toHaveLength(8);
    expect(finished.at(-1)).toBe(runs.map((r) => `${r.caseId}:${r.persona}:${r.sample}`).join(" "));

    // A smaller pool, as a caller may ask.
    active = 0;
    peak = 0;
    fakeInterviews(4, async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
    });
    await runInterviewSuite({ caseIds: [CASE_ID], personas: [...ANSWER_KINDS], interviews: 2, mock: false, labels, reused: [entry(CASE_ID, 1, fullSession())], concurrency: 1 });
    expect(peak).toBe(1);
  });

  it("runs the pipeline of a case the reused file lacks, as the pipeline suite does", async () => {
    vi.mocked(runPipeline).mockResolvedValueOnce(pipelineOf(fullSession({ caseText: "Pipeline lancé." })));
    fakeInterviews(2);
    const onPipeline = vi.fn();
    const { runs, freshPipelines } = await runInterviewSuite(
      { caseIds: [CASE_ID, "cloud-industriel"], personas: ["flawed"], interviews: 1, mock: false, labels, reused: [entry(CASE_ID, 1, fullSession())] },
      { onPipeline },
    );
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(freshPipelines).toEqual(["cloud-industriel"]);
    expect(runPipeline).toHaveBeenCalledWith(SAMPLE_CASES.find((c) => c.id === "cloud-industriel")!.text, { caseId: null, mock: false, signal: undefined });
    expect(onPipeline).toHaveBeenCalledTimes(1);
    expect(onPipeline.mock.calls[0][0]).toEqual([expect.objectContaining({ caseId: "cloud-industriel", sample: 1, challenges: [], selfCritique: null })]);
    expect(runs.map((r) => r.caseId)).toEqual([CASE_ID, "cloud-industriel"]);
    expect(vi.mocked(runInterview).mock.calls[1][0].session.caseText).toBe("Pipeline lancé.");
  });

  it("skips a case whose pipeline stopped before its questions, and says so", async () => {
    vi.mocked(runPipeline).mockResolvedValueOnce(pipelineOf(sessionWith(["classify"])));
    const logs: string[] = [];
    const onPipeline = vi.fn();
    const result = await runInterviewSuite(
      { caseIds: [CASE_ID], personas: [...ANSWER_KINDS], interviews: 1, mock: true, labels, reused: [] },
      { log: (message) => logs.push(message), onPipeline },
    );
    expect(result).toMatchObject({ runs: [], skipped: [CASE_ID], freshPipelines: [CASE_ID], solutions: { [CASE_ID]: null }, summary: { interviews: 0 } });
    // Kept anyway: the raw file shows why.
    expect(onPipeline).toHaveBeenCalledTimes(1);
    expect(logs).toContain(`${CASE_ID} · no interview: the pipeline stopped before its clarification questions`);
    expect(runInterview).not.toHaveBeenCalled();
  });

  it("turns the leak check off for a pipeline without options, and records the case", async () => {
    const logs: string[] = [];
    fakeInterviews(1);
    const { solutions, reusedWithoutOptions, freshPipelines } = await runInterviewSuite(
      { caseIds: [CASE_ID], personas: ["flawed"], interviews: 1, mock: false, labels, reused: [entry(CASE_ID, 1, sessionWith(["classify", "frame", "questions"], { gatePassed: true }))] },
      { log: (message) => logs.push(message) },
    );
    expect(solutions[CASE_ID]).toBeNull();
    expect(reusedWithoutOptions).toEqual([CASE_ID]);
    expect(freshPipelines).toEqual([]);
    expect(logs).toContain(`${CASE_ID} · pipeline of sample 1 reused: 0/0 stages, no run of the case in the file has its options`);
    expect(logs).toContain(`${CASE_ID} · leak check: off, the pipeline has no options`);
  });

  it("reuses a run with options over an earlier one without, and records the cases that fell back or ran their pipeline", async () => {
    const ok = (stage: StageRecord["stage"], passed = true): StageRecord => ({ stage, ok: passed, ms: 1, meta: null, error: null });
    const noOptions = (caseText: string) => sessionWith(["classify", "frame", "questions"], { gatePassed: true, caseText });
    // Two entries with the same sample number: the log must count the stages of the one kept.
    const reused: RawPipelineSample[] = [
      { caseId: CASE_ID, sample: 1, pipeline: { session: noOptions("Sans options."), stages: [ok("classify"), ok("options", false)], wallMs: 0 } },
      { caseId: CASE_ID, sample: 1, pipeline: { session: fullSession({ caseText: "Avec options." }), stages: [ok("classify"), ok("options")], wallMs: 0 } },
      entry("cloud-industriel", 1, noOptions("Cloud sans options.")),
    ];
    vi.mocked(runPipeline).mockResolvedValueOnce(pipelineOf(fullSession({ caseText: "Pipeline lancé." })));
    fakeInterviews(3);
    const logs: string[] = [];
    const result = await runInterviewSuite(
      { caseIds: [CASE_ID, "cloud-industriel", "genai-assurance"], personas: ["flawed"], interviews: 1, mock: false, labels, reused },
      { log: (message) => logs.push(message) },
    );

    expect(vi.mocked(runInterview).mock.calls.map(([input]) => input.session.caseText)).toEqual(["Avec options.", "Cloud sans options.", "Pipeline lancé."]);
    expect(result).toMatchObject({ freshPipelines: ["genai-assurance"], reusedWithoutOptions: ["cloud-industriel"], skipped: [] });
    expect(result.solutions[CASE_ID]?.option).not.toBe("");
    expect(result.solutions["cloud-industriel"]).toBeNull();
    expect(logs).toContain(`${CASE_ID} · pipeline of sample 1 reused: 2/2 stages`);
    expect(logs).toContain("cloud-industriel · pipeline of sample 1 reused: 0/0 stages, no run of the case in the file has its options");
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it("refuses a reused file that holds no pipeline run, before any call", async () => {
    const interviewFile = [fakeRun()] as unknown as RawPipelineSample[];
    await expect(
      runInterviewSuite({ caseIds: [CASE_ID], personas: ["flawed"], interviews: 1, mock: true, labels, reused: interviewFile }),
    ).rejects.toThrow("The reused file holds no pipeline run: --reuse takes a raw file of the pipeline suite.");
    expect(runPipeline).not.toHaveBeenCalled();
    expect(runInterview).not.toHaveBeenCalled();
  });
});

// ── The script ──────────────────────────────────────────────────────────────

/**
 * `npm run eval` on the mock engine, in a child process. No model call: the mock engine replays recorded runs, the
 * CLI a live engine would need does not exist there, and NODE_ENV=test keeps the local settings out.
 */
function runEvalScript(args: string[]): Promise<{ code: number; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "test", CONSULTANT_DOTS_CLAUDE_BIN: path.join(os.tmpdir(), "no-claude-here.exe") };
  const argv = ["--import", "tsx", path.join("scripts", "eval.ts"), "--engine", "mock", ...args];
  return new Promise((resolve) => {
    execFile(process.execPath, argv, { env, timeout: 90_000 }, (err, _stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stderr });
    });
  });
}

describe("the eval script, interview suite", () => {
  it("names its files to the second with the tool mode, records where the pipelines came from, and never overwrites", async () => {
    const dir = scratchDir();
    const out = path.join(dir, "results");
    // The case's run of the latest live eval, without its options: the reuse falls back, and the summary says so.
    const run = structuredClone(CLI_RUNS.find((s) => s.caseId === CASE_ID)!);
    run.pipeline.session.stages.options = { ...run.pipeline.session.stages.options, status: "idle", data: null };
    const reuse = path.join(dir, "reuse.json");
    writeFileSync(reuse, JSON.stringify([run]), "utf8");
    const args = ["--suite", "interview", "--cases", CASE_ID, "--personas", "control", "--interview-tools", "off", "--reuse", reuse, "--out", out];

    const first = await runEvalScript(args);
    expect(first.code, first.stderr).toBe(0);
    const report = readdirSync(out).find((f) => f.endsWith(".md"))!;
    expect(report).toMatch(/^\d{8}-\d{6}-mock-interview-tools-off\.md$/);
    const name = report.slice(0, -".md".length);
    expect(readdirSync(out).sort()).toEqual([`${name}.json`, report, "raw"]);
    // Every pipeline was reused: no -pipelines.json beside the interviews.
    expect(readdirSync(path.join(out, "raw"))).toEqual([`${name}.json`]);
    expect(JSON.parse(readFileSync(path.join(out, `${name}.json`), "utf8"))).toMatchObject({
      engine: "mock",
      tools: false,
      pipelinesFrom: "reuse.json",
      freshPipelines: [],
      reusedWithoutOptions: [CASE_ID],
      skipped: [],
      summary: { interviews: 1, uncheckedCases: [CASE_ID] },
    });

    // Another eval holds the names of the coming minute: the next run is refused before any interview.
    const taken = Array.from({ length: 61 }, (_, s) =>
      path.join(out, `${outputName(new Date(Date.now() + s * 1000).toISOString(), "mock", { suite: "interview", interviewTools: false })}.md`),
    ).filter((file) => !existsSync(file));
    for (const file of taken) writeFileSync(file, "autre eval", "utf8");
    const raw = readFileSync(path.join(out, "raw", `${name}.json`), "utf8");
    const second = await runEvalScript(args);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("already exists: an eval never overwrites the files of another one");
    expect(second.stderr).not.toContain("pipeline of sample");
    expect(readdirSync(path.join(out, "raw"))).toEqual([`${name}.json`]);
    expect(readFileSync(path.join(out, "raw", `${name}.json`), "utf8")).toBe(raw);
    for (const file of taken) expect(readFileSync(file, "utf8")).toBe("autre eval");
  }, 120_000);
});

describe("interviewPromptVersion", () => {
  it("is stable for the same prompts and follows the pipeline's version", () => {
    expect(interviewPromptVersion("abc")).toMatch(/^[0-9a-f]{8}$/);
    expect(interviewPromptVersion("abc")).toBe(interviewPromptVersion("abc"));
    expect(interviewPromptVersion("abd")).not.toBe(interviewPromptVersion("abc"));
  });
});
