import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SAMPLE_CASES } from "@/lib/samples";
import { oralToText, runChallenge, runPipeline } from "@/lib/eval/run-case";
import { answerBlindBaseline, MAX_FLAGS, scoreFlags, summarize, type AnswerLabels, type CaseLabels, type CaseSample } from "@/lib/eval/metrics";
import { renderReport } from "@/lib/eval/report";
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

  it("turns the oral pitch into the plain text the challenge stage reads", () => {
    const text = oralToText(fixture("oral"));
    expect(text.split("\n")[0]).toBe(fixture("oral").opening);
    expect(text).toContain(fixture("oral").sections[0].bullets[0].point);
  });
});
