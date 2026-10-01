import { describe, expect, it } from "vitest";
import { PIPELINE_STAGE_IDS, POST_GATE_STAGES, type StageId } from "@/lib/schemas";
import type { OptionsAnalysis } from "@/lib/schemas/options";
import {
  addInitiative,
  buildInputs,
  canRun,
  clarificationList,
  cycleScore,
  derivePhase,
  effectiveOptions,
  hashInputsOf,
  hashValue,
  initialSession,
  isStale,
  markInterrupted,
  matrixChoicesOf,
  matrixEdited,
  migrateSession,
  passGate,
  resetStale,
  runnableStages,
  setVerdict,
  setWeight,
  sortByScore,
  staleStages,
} from "@/lib/store/machine";
import { buildCaseBrief } from "@/lib/prompts/brief";
import { fixture, sessionWith } from "./helpers";

describe("session state machine", () => {
  it("runs classify first, then frame and questions in parallel", () => {
    expect(runnableStages(sessionWith([]))).toEqual(["classify"]);
    expect(runnableStages(sessionWith(["classify"]))).toEqual(["frame", "questions"]);
  });

  it("blocks every post-gate stage until the clarifications are validated", () => {
    const s = sessionWith(["classify", "frame", "questions"]);
    expect(derivePhase(s)).toBe("clarifying");
    expect(runnableStages(s)).toEqual([]);
    expect(runnableStages(passGate(s))).toEqual(["diagnose", "currentState"]);
  });

  it("chains the waves after the gate", () => {
    const gate = (done: StageId[]) => runnableStages(passGate(sessionWith(done)));
    expect(gate(["classify", "frame", "questions", "diagnose", "currentState"])).toEqual(["options"]);
    expect(gate(["classify", "frame", "questions", "diagnose", "currentState", "options"])).toEqual([
      "target",
      "roadmap",
    ]);
    expect(gate(PIPELINE_STAGE_IDS.filter((s) => s !== "oral"))).toEqual(["oral"]);
  });

  it("turns unanswered questions into explicit working assumptions once the gate is passed", () => {
    const questions = fixture("questions").questions;
    const s = passGate(sessionWith(["classify", "frame", "questions"], { answers: { [questions[0].id]: "Réponse" } }));
    const list = clarificationList(s);
    expect(list[0]).toMatchObject({ status: "answered", answer: "Réponse" });
    expect(list.slice(1).every((c) => c.status === "assumed")).toBe(true);

    const brief = buildCaseBrief(buildInputs(s, "diagnose"));
    expect(brief.clarifications[0].source).toBe("client");
    expect(brief.clarifications[1]).toMatchObject({ source: "assumption", answer: questions[1].defaultAssumption });
  });

  it("marks results stale when an answer changes, and re-runs them with everything downstream", () => {
    const all = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true });
    expect(staleStages(all)).toEqual([]);

    const edited = { ...all, answers: { ...all.answers, Q1: "Nouvelle réponse du client" } };
    expect(isStale(edited, "diagnose")).toBe(true);
    expect(isStale(edited, "frame")).toBe(false);

    const refreshed = resetStale(edited);
    expect(runnableStages(refreshed)).toEqual(["diagnose", "currentState"]);
    expect(["options", "target", "roadmap", "oral"].every((s) => refreshed.stages[s as StageId].status === "idle")).toBe(true);
    expect(refreshed.stages.oral.data).not.toBeNull();
    expect(refreshed.stages.classify.status).toBe("done");
  });

  it("ignores edits the prompts do not see: spaces, blank lines and bullets around notes and answers", () => {
    const s = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true, clientNotes: "Budget validé", answers: { Q1: "Le reporting DG" } });
    expect(staleStages({ ...s, clientNotes: "- Budget validé\n\n", answers: { Q1: "  Le reporting DG\n" } })).toEqual([]);
    expect(staleStages({ ...s, clientNotes: "Budget validé\nLe DAF tranche les définitions" })).toEqual([...POST_GATE_STAGES]);
  });

  it("keeps results hashed by the previous version up to date, and still sees real changes", () => {
    // The hash before it followed the prompts: raw notes and initiatives in row order.
    const legacyHash = (stage: StageId, inputs: Record<string, unknown>) => {
      const options = inputs.options as OptionsAnalysis | undefined;
      if (!options || !["target", "roadmap", "oral"].includes(stage)) return hashValue(inputs);
      return hashValue({ ...inputs, options: { ...options, initiatives: options.initiatives.map(({ name, verdict }) => ({ name, verdict })) } });
    };
    const base = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true, clientNotes: "- Budget validé\n" });
    const other = base.stages.options.data!.initiatives.findIndex((i) => i.verdict !== "pilot");
    const edited = setVerdict(base, other, "pilot");
    const legacy = { ...edited, stages: { ...edited.stages } };
    for (const stage of PIPELINE_STAGE_IDS) {
      legacy.stages[stage] = { ...edited.stages[stage], inputHash: legacyHash(stage, buildInputs(edited, stage)) } as never;
    }
    for (const stage of POST_GATE_STAGES) {
      expect(legacy.stages[stage].inputHash).not.toBe(hashInputsOf(stage, buildInputs(edited, stage)));
    }
    expect(staleStages(legacy)).toEqual([]);
    expect(staleStages({ ...legacy, answers: { Q1: "Nouvelle réponse du client" } })).toEqual([...POST_GATE_STAGES]);
  });

  it("turns runs interrupted by a page refresh into 'interrupted'", () => {
    const s = sessionWith(["classify"]);
    s.stages.frame = { ...s.stages.frame, status: "running" };
    const restored = markInterrupted(s);
    expect(restored.stages.frame.status).toBe("interrupted");
    expect(restored.stages.classify.status).toBe("done");
  });

  it("hashes inputs independently of key order", () => {
    expect(hashValue({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(hashValue({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});

describe("challenge stage", () => {
  it("is never chained automatically and needs a real answer", () => {
    const s = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true, challengeAnswer: "trop court" });
    expect(canRun(s, "challenge")).toBe(false);
    const ready = { ...s, challengeAnswer: "Je structurerais ma réponse en quatre étapes : cadrage, diagnostic, options, pilote." };
    expect(canRun(ready, "challenge")).toBe(true);
    expect(runnableStages({ ...ready, stages: { ...ready.stages, challenge: { ...ready.stages.challenge } } })).not.toContain(
      "challenge",
    );
  });

  it("only goes stale when the answer itself changes", () => {
    const answer = "Je structurerais ma réponse en quatre étapes : cadrage, diagnostic, options, pilote.";
    const base = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true, challengeAnswer: answer });
    const s = {
      ...base,
      stages: {
        ...base.stages,
        challenge: {
          ...base.stages.challenge,
          status: "done" as const,
          data: { level: "correct" as const, verdict: "", flags: [], strengths: [], missing: [], nextVersion: [] },
          inputHash: hashInputsOf("challenge", buildInputs(base, "challenge")),
        },
      },
    };
    expect(isStale(s, "challenge")).toBe(false);
    expect(isStale({ ...s, answers: { Q1: "autre chose" } }, "challenge")).toBe(false);
    expect(isStale({ ...s, clientNotes: "Le DAF tranche les définitions" }, "challenge")).toBe(false);
    expect(isStale({ ...s, challengeAnswer: `${answer} Et des KPIs.` }, "challenge")).toBe(true);
  });
});

describe("prioritization working copy", () => {
  const done = sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true });

  it("wraps scores between 1 and 5 in both directions", () => {
    const first = done.stages.options.data!.initiatives[0];
    const up = cycleScore(done, 0, "value", 1);
    expect(up.matrix.initiatives![0].value).toBe(first.value === 5 ? 1 : first.value + 1);
    const down = cycleScore(done, 0, "value", -1);
    expect(down.matrix.initiatives![0].value).toBe(first.value === 1 ? 5 : first.value - 1);
  });

  it("keeps a single pilot when the user picks another one", () => {
    const initiatives = done.stages.options.data!.initiatives;
    const other = initiatives.findIndex((i) => i.verdict !== "pilot");
    const s = setVerdict(done, other, "pilot");
    expect(s.matrix.initiatives!.filter((i) => i.verdict === "pilot").map((i) => i.name)).toEqual([initiatives[other].name]);
    expect(effectiveOptions(s)!.initiatives[other].verdict).toBe("pilot");
  });

  it("makes target, roadmap and oral stale when the pilot changes, but not for a score tweak", () => {
    expect(staleStages(cycleScore(done, 0, "feasibility", 1))).toEqual([]);
    const other = done.stages.options.data!.initiatives.findIndex((i) => i.verdict !== "pilot");
    expect(staleStages(setVerdict(done, other, "pilot"))).toEqual(["target", "roadmap", "oral"]);
  });

  it("keeps downstream results up to date when the user only re-sorts the rows", () => {
    const sorted = sortByScore(setWeight(done, "value", 0));
    const names = (s: typeof done) => effectiveOptions(s)!.initiatives.map((i) => i.name);
    expect(names(sorted)).not.toEqual(names(done));
    expect(staleStages(sorted)).toEqual([]);
    expect(staleStages(addInitiative(sorted, "Mon idée"))).toEqual(["target", "roadmap", "oral"]);
  });

  it("only reports the pilot and the added initiatives as the user's choices for a new Options version", () => {
    expect(matrixChoicesOf(done)).toBeNull();
    expect(matrixChoicesOf(sortByScore(cycleScore(done, 0, "risk", 1)))).toBeNull();
    const initiatives = done.stages.options.data!.initiatives;
    const suggested = initiatives.find((i) => i.verdict === "pilot")!.name;
    const other = initiatives.findIndex((i) => i.verdict !== "pilot");
    expect(matrixChoicesOf(setVerdict(done, other, "pilot"))).toEqual({
      pilot: { chosen: initiatives[other].name, suggested },
      added: [],
    });
    expect(matrixChoicesOf(addInitiative(done, " Mon idée "))).toEqual({ pilot: null, added: ["Mon idée"] });
  });

  it("sorts by the weighted score and tracks whether the user edited anything", () => {
    expect(matrixEdited(done)).toBe(false);
    const riskOnly = ["value", "feasibility", "timeToValue", "reuse"].reduce(
      (s, c) => setWeight(s, c as "value", 0),
      setWeight(done, "risk", 3),
    );
    const sorted = sortByScore(riskOnly).matrix.initiatives!;
    const risks = sorted.map((i) => i.risk);
    expect(risks).toEqual([...risks].sort((a, b) => a - b));
    expect(matrixEdited(riskOnly)).toBe(true);
    expect(addInitiative(done, "  Mon idée  ").matrix.initiatives!.at(-1)).toMatchObject({ name: "Mon idée", verdict: "later" });
  });
});

describe("persisted session migration", () => {
  it("upgrades a v1 session without losing the analysis", () => {
    const v1 = { ...sessionWith(["classify", "frame"]), version: 1 } as Record<string, unknown>;
    delete v1.notes;
    delete v1.matrix;
    delete v1.challengeAnswer;
    const migrated = migrateSession(v1, 1);
    expect(migrated.version).toBe(2);
    expect(migrated.stages.frame.data).toEqual(fixture("frame"));
    expect(migrated.stages.challenge.status).toBe("idle");
    expect(migrated.matrix.initiatives).toBeNull();
    expect(migrated.notes).toEqual({});
  });

  it("starts fresh from an unknown version", () => {
    expect(migrateSession({ started: true }, 7)).toEqual(initialSession());
  });
});
