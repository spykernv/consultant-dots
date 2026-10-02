import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SAMPLE_CASES } from "@/lib/samples";
import { oralToText, runChallenge, runPipeline } from "@/lib/eval/run-case";
import { answerBlindBaseline, MAX_FLAGS, scoreFlags, summarize, type AnswerLabels, type CaseLabels, type CaseSample } from "@/lib/eval/metrics";
import { renderReport } from "@/lib/eval/report";
import { countFlag, labelledAnswer, outputName, suiteFlags } from "@/lib/eval/interview-suite";
import { stageChecks } from "@/lib/pipeline/checks";
import { buildInputs } from "@/lib/store/machine";
import { PIPELINE_STAGE_IDS, type StageOutputs } from "@/lib/schemas";
import { fixture, sessionWith } from "./helpers";

const labels = (JSON.parse(readFileSync("evals/challenge-labels.json", "utf8")) as { cases: Record<string, CaseLabels & { control: { answer: string } }> }).cases;
const ALL = ["E1", "E10", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9"];

describe("eval harness", () => {
  it("labels every reflex exactly once for both answers of every sample case", () => {
    for (const sample of SAMPLE_CASES) {
      for (const kind of ["flawed", "control"] as const) {
        const l = labels[sample.id][kind];
        expect([...l.violated, ...l.notViolated, ...l.ambiguous].sort()).toEqual(ALL);
      }
      expect(labels[sample.id].control.answer.length).toBeGreaterThan(200);
    }
  });

  it("scores flagged reflexes against the labels, ignoring ambiguous ones and repeated flags", () => {
    const l: AnswerLabels = { violated: ["E1", "E3", "E4"], notViolated: ["E8", "E10"], ambiguous: ["E7"] };
    expect(scoreFlags(["E1", "E1", "E3", "E7", "E8"], l)).toEqual({ tp: 2, fp: 1, fn: 1, flagged: ["E1", "E3", "E7", "E8"] });
  });

  it("builds the answer-blind baseline from the most often violated reflexes, and penalizes it on clean answers", () => {
    const clean: AnswerLabels = { violated: [], notViolated: ALL, ambiguous: [] };
    const two: Record<string, CaseLabels> = {
      a: { flawed: { violated: ["E1", "E2", "E3"], notViolated: ["E4", "E5", "E6", "E7", "E8", "E9", "E10"], ambiguous: [] }, control: clean },
    };
    const baseline = answerBlindBaseline(["a"], two);
    expect(baseline.flags).toEqual(["E1", "E2", "E3"]);
    expect(baseline.precision).toEqual({ value: 0.5, num: 3, den: 6 });
    expect(baseline.recall.value).toBe(1);
  });

  it("counts a finding with an empty basis as inference, not as an invalid citation", () => {
    const s = sessionWith(["classify", "frame", "questions"], { gatePassed: true });
    const raw = { ...fixture("diagnose"), findings: [{ ...fixture("diagnose").findings[0], basis: [] }, { ...fixture("diagnose").findings[0], basis: ["F99"] }] } as StageOutputs["diagnose"];
    expect(stageChecks("diagnose", raw, raw, buildInputs(s, "diagnose"))).toMatchObject({ findingsInferred: 1, findingsUncited: 1, citationsDropped: 1 });
  });

  it("runs the pipeline headless through the app's state machine, then scores both answers", async () => {
    const sample = SAMPLE_CASES.find((c) => c.id === "data-platform")!;
    const options = { caseId: sample.id, mock: true };
    const pipeline = await runPipeline(sample.text, options);
    expect(pipeline.stages.map((s) => s.stage).sort()).toEqual([...PIPELINE_STAGE_IDS].sort());
    expect(pipeline.stages.every((s) => s.ok)).toBe(true);
    expect(pipeline.session.gatePassed).toBe(true);
    expect(pipeline.stages.find((s) => s.stage === "frame")?.meta?.checks).toMatchObject({ factsProposed: 8, factsVerified: 8 });

    const flawed = await runChallenge(pipeline.session, sample.flawedAnswer, options);
    const control = await runChallenge(pipeline.session, labels[sample.id].control.answer, options);
    const critique = await runChallenge(pipeline.session, oralToText(pipeline.session.stages.oral.data!), options);
    const run: CaseSample = { caseId: sample.id, sample: 1, pipeline, challenges: [{ kind: "flawed", run: flawed }, { kind: "control", run: control }], selfCritique: critique };

    const summary = summarize([run], labels);
    expect(summary.pipelinesCompleted.value).toBe(1);
    expect(summary.stageSuccess.value).toBe(1);
    expect(summary.factVerification).toEqual({ value: 1, num: 8, den: 8 });
    expect(summary.challenge.flawedRecall.den).toBe(labels[sample.id].flawed.violated.length);
    // The mock replays the flawed-answer critique for the control answer too: every flag there is a false positive.
    expect(summary.challenge.controlFalsePositives.value).toBe(new Set(fixture("challenge").flags.map((f) => f.reflex)).size);
    expect(summary.challenge.recallCeiling).toBeCloseTo(MAX_FLAGS / labels[sample.id].flawed.violated.length);
    expect(summary.costUsdPerRun).toBe(0);

    const report = renderReport(
      { date: "2026-10-01 12:00 UTC", engine: "mock", requestedModel: "recorded runs", promptVersion: "abc", cases: [sample.id], runs: 1, challengeRuns: 1, selfCritique: true, reusedFrom: null, labelsReviewedByHand: false },
      summary,
      labels,
    );
    expect(report).toContain("| Facts verified in the case text | 8/8 (100 %)");
    expect(report).toContain("Answer-blind baseline");
    expect(report).toContain("Mock engine: recorded runs are replayed");
  }, 60_000);

  it("keeps the pipeline suite the default, with the same labelled answers and run counts", () => {
    expect(suiteFlags({ runs: "3", "challenge-runs": "0", "no-self-critique": true }).suite).toBe("pipeline");
    for (const sample of SAMPLE_CASES) {
      expect(labelledAnswer(sample.id, "flawed", labels)).toBe(sample.flawedAnswer);
      expect(labelledAnswer(sample.id, "control", labels)).toBe(labels[sample.id].control.answer);
    }
    expect(countFlag("runs", "1", 1)).toBe(1);
    expect(countFlag("challenge-runs", "3", 0)).toBe(3);
    expect(() => countFlag("runs", "0", 1)).toThrow("--runs must be an integer >= 1.");
    expect(() => countFlag("challenge-runs", "-1", 0)).toThrow("--challenge-runs must be an integer >= 0.");
    // Its files keep their names, to the minute.
    expect(outputName("2026-10-01T18:00:59.999Z", "cli", suiteFlags({}))).toBe("20261001-1800-cli");
  });

  it("turns the oral pitch into the plain text the challenge stage reads", () => {
    const text = oralToText(fixture("oral"));
    expect(text.split("\n")[0]).toBe(fixture("oral").opening);
    expect(text).toContain(fixture("oral").sections[0].bullets[0].point);
  });
});

/** Scratch directories of these tests, removed at the end. */
const scratch: string[] = [];
const scratchDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "eval-pipeline-"));
  scratch.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

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

describe("the eval script, pipeline suite", () => {
  // Read only: the challenges and the self-critique are kept, so nothing runs.
  const reuseArgs = ["--reuse", path.join("evals", "results", "runs-2026-10-01-cli.json"), "--cases", "data-platform", "--challenge-runs", "0", "--no-self-critique"];

  it("keeps a reused pipeline run and says so, names its files to the minute as before, and never overwrites them", async () => {
    const out = path.join(scratchDir(), "results");
    const first = await runEvalScript([...reuseArgs, "--out", out]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stderr).toMatch(/data-platform · run 1 · 9\/9 stages in \d+ s \(reused\)/);
    expect(first.stderr).not.toContain("pipeline…");
    const report = readdirSync(out).find((f) => f.endsWith(".md"))!;
    expect(report).toMatch(/^\d{8}-\d{4}-mock\.md$/);
    const name = report.slice(0, -".md".length);
    expect(readdirSync(out).sort()).toEqual([`${name}.json`, report, "raw"]);
    expect(readdirSync(path.join(out, "raw"))).toEqual([`${name}.json`]);

    // The same minute is taken by this run, the next ones by another eval: the next run is refused.
    const taken = [1, 2]
      .map((m) => path.join(out, `${outputName(new Date(Date.now() + m * 60_000).toISOString(), "mock", suiteFlags({}))}.md`))
      .filter((file) => !existsSync(file));
    for (const file of taken) writeFileSync(file, "autre eval", "utf8");
    const raw = readFileSync(path.join(out, "raw", `${name}.json`), "utf8");
    const second = await runEvalScript([...reuseArgs, "--out", out]);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("already exists: an eval never overwrites the files of another one");
    expect(second.stderr).not.toContain("stages in");
    expect(readFileSync(path.join(out, "raw", `${name}.json`), "utf8")).toBe(raw);
    for (const file of taken) expect(readFileSync(file, "utf8")).toBe("autre eval");
  }, 120_000);

  it("refuses a raw file of the interview suite instead of running new pipelines labelled reused", async () => {
    const dir = scratchDir();
    const reuse = path.join(dir, "interviews.json");
    writeFileSync(reuse, JSON.stringify([{ caseId: "data-platform", persona: "flawed", sample: 1, tools: true, turns: [] }]), "utf8");
    const out = path.join(dir, "results");
    const result = await runEvalScript(["--reuse", reuse, "--challenge-runs", "0", "--no-self-critique", "--out", out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`${reuse} holds interviews, not pipeline runs: --reuse takes a raw file of the pipeline suite`);
    expect(result.stderr).not.toContain("pipeline…");
    expect(result.stderr).not.toContain("(reused)");
    expect(existsSync(out)).toBe(false);
  }, 120_000);
});
