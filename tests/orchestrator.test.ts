import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PIPELINE_STAGE_IDS, type StageId } from "@/lib/schemas";
import type { StageEvent } from "@/lib/schemas/api";
import type { Initiative, OptionsAnalysis } from "@/lib/schemas/options";
import {
  addInitiative,
  cycleScore,
  effectiveOptions,
  pilotOverrideOf,
  removeInitiative,
  setVerdict,
  setWeight,
  sortByScore,
  type Session,
} from "@/lib/store/machine";
import { carryMatrix, matrixCarryHint, matrixNotices } from "@/lib/store/matrix-carry";
import { actions } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import { fixture, sessionWith } from "./helpers";

type Call = {
  stage: StageId;
  body: { inputs: Record<string, unknown>; steer: string | null; previous: unknown; choices: unknown };
  send: (event: StageEvent) => void;
  end: () => void;
};

let calls: Call[] = [];
const encoder = new TextEncoder();

/** A /api/stage stream the test feeds event by event, as the route would. */
function mockStageRoute() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (controller) => void (stream = controller) });
      init.signal?.addEventListener("abort", () => stream.error(new DOMException("Aborted", "AbortError")));
      calls.push({
        stage: url.split("/").pop() as StageId,
        body: JSON.parse(init.body as string),
        send: (event) => stream.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
        end: () => stream.close(),
      });
      return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
    }),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastCall = (stage: StageId) => calls.filter((c) => c.stage === stage).at(-1)!;
const state = () => useSession.getState();

async function finish(stage: StageId, data: unknown, notes: string[] = []) {
  const call = lastCall(stage);
  call.send({ type: "done", data, meta: { ms: 1200, model: "test", costUsd: null, notes } });
  call.end();
  await settle();
}

async function fail(stage: StageId) {
  const call = lastCall(stage);
  call.send({ type: "error", code: "usage_limit", message: "Limite d'usage atteinte." });
  call.end();
  await settle();
}

const options = fixture("options");
const indexOf = (prefix: string) => options.initiatives.findIndex((i) => i.name.startsWith(prefix));
const MARGE = options.initiatives[indexOf("Marge")].name;
const OTD = options.initiatives[indexOf("OTD")].name;
const REFERENTIELS = options.initiatives[indexOf("Référentiels")].name;
const allDone = (patch: Partial<Session> = {}) => sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true, ...patch });

/** The model's new version: everything re-scored, the same pilot as before unless `initiatives` says otherwise. */
const regenerated = (initiatives: Initiative[] = options.initiatives): OptionsAnalysis => ({
  ...options,
  initiatives: initiatives.map((i) => ({ ...i, feasibility: 1 })),
});

/** The fixture's initiatives with `name` as the pilot. */
const piloting = (name: string): Initiative[] =>
  options.initiatives.map((i) => ({ ...i, verdict: i.name === name ? "pilot" : i.verdict === "pilot" ? "next" : i.verdict }));

beforeEach(mockStageRoute);
afterEach(async () => {
  actions.clear();
  await settle();
  vi.unstubAllGlobals();
});

describe("regenerating Options", () => {
  it("sends the matrix the user sees and keeps their pilot, their added initiatives and their weights", async () => {
    const edited = addInitiative(setWeight(setVerdict(allDone(), indexOf("Marge"), "pilot"), "risk", 3), "Mon idée");
    useSession.setState(edited, true);

    actions.regenerate("options", "  ");
    await settle();
    expect(lastCall("options").body).toEqual(
      expect.objectContaining({
        steer: null,
        previous: effectiveOptions(edited),
        choices: { pilot: { chosen: MARGE, suggested: OTD }, added: ["Mon idée"] },
      }),
    );

    // The model writes the pilot's name differently and keeps its own pilot.
    await finish(
      "options",
      regenerated(options.initiatives.map((i) => (i.name === MARGE ? { ...i, name: " marge CONSOLIDEE trois  filiales" } : i))),
    );
    const s = state();
    expect(s.stages.options.status).toBe("done");
    expect(s.matrix.weights.risk).toBe(3);
    const rows = s.matrix.initiatives!;
    expect(rows.filter((i) => i.verdict === "pilot").map((i) => i.name)).toEqual([" marge CONSOLIDEE trois  filiales"]);
    expect(rows.find((i) => i.name === OTD)!.verdict).toBe("next");
    expect(rows.at(-1)).toMatchObject({ name: "Mon idée", comment: "Ajoutée par moi", feasibility: 3 });
    expect(rows.slice(0, -1).every((i) => i.feasibility === 1)).toBe(true);
    expect(pilotOverrideOf(s)).toEqual({ chosen: " marge CONSOLIDEE trois  filiales", suggested: OTD });
    expect(matrixNotices(s.stages.options.notes)).toEqual([]);
  });

  it("tells the user when their pilot no longer exists instead of silently reverting", async () => {
    useSession.setState(setVerdict(allDone(), indexOf("Marge"), "pilot"), true);
    actions.regenerate("options", "");
    await settle();
    await finish("options", regenerated(options.initiatives.filter((i) => i.name !== MARGE)), ["Note du serveur."]);

    const s = state();
    expect(s.matrix.initiatives).toBeNull();
    expect(effectiveOptions(s)!.initiatives.find((i) => i.verdict === "pilot")!.name).toBe(OTD);
    expect(s.stages.options.notes[0]).toBe("Note du serveur.");
    expect(matrixNotices(s.stages.options.notes)).toEqual([
      `Ton pilote « ${MARGE} » n'existe plus dans les nouvelles options, c'est « ${OTD} » qui est proposé. Clique sur un verdict pour en choisir un autre.`,
    ]);

    // The notice stays until the user works on the new matrix, then only the server's note remains.
    actions.matrix.setWeight("risk", 3);
    expect(matrixNotices(state().stages.options.notes)).toHaveLength(1);
    actions.matrix.setVerdict(1, "pilot");
    expect(state().stages.options.notes).toEqual(["Note du serveur."]);
  });

  it("lets the model's pilot stand when an instruction asked for another one, and says so", async () => {
    useSession.setState(addInitiative(setVerdict(allDone(), indexOf("Marge"), "pilot"), "Mon idée"), true);
    actions.regenerate("options", "Propose un autre pilote : plutôt les référentiels");
    await settle();
    await finish("options", regenerated(piloting(REFERENTIELS)));

    const s = state();
    expect(pilotOverrideOf(s)).toBeNull();
    expect(s.matrix.initiatives!.filter((i) => i.verdict === "pilot").map((i) => i.name)).toEqual([REFERENTIELS]);
    expect(s.matrix.initiatives!.at(-1)).toMatchObject({ name: "Mon idée", verdict: "later" });
    expect(matrixNotices(s.stages.options.notes)).toEqual([
      `Avec ta consigne, la nouvelle version propose « ${REFERENTIELS} » comme pilote au lieu de « ${MARGE} ». Pour revenir à ton choix, fais de « ${MARGE} » le pilote dans le tableau ou le graphique.`,
    ]);

    actions.matrix.reset();
    expect(matrixNotices(state().stages.options.notes)).toEqual([]);
  });

  it("says nothing when the instruction kept the user's pilot", async () => {
    useSession.setState(setVerdict(allDone(), indexOf("Marge"), "pilot"), true);
    actions.regenerate("options", "Plus concis");
    await settle();
    await finish("options", regenerated(piloting(MARGE)));

    const s = state();
    expect(s.matrix.initiatives).toBeNull();
    expect(effectiveOptions(s)!.initiatives.find((i) => i.verdict === "pilot")!.name).toBe(MARGE);
    expect(matrixNotices(s.stages.options.notes)).toEqual([]);
  });

  it("keeps a pilot picked during a stale cascade, and the next sections are built on it", async () => {
    useSession.setState(allDone(), true);
    actions.setAnswer("Q1", "Nouvelle réponse du client");
    actions.refreshStale();
    await settle();
    expect(calls.map((c) => c.stage).sort()).toEqual(["currentState", "diagnose"]);

    actions.matrix.setVerdict(indexOf("Marge"), "pilot");
    await finish("diagnose", fixture("diagnose"));
    await finish("currentState", fixture("currentState"));
    expect(lastCall("options").body).toMatchObject({
      steer: null,
      previous: null,
      choices: { pilot: { chosen: MARGE, suggested: OTD }, added: [] },
    });
    // Generated from scratch, the names come back with other dashes, quotes and punctuation.
    const RENAMED = "Marge consolidée – trois filiales.";
    await finish("options", regenerated(options.initiatives.map((i) => (i.name === MARGE ? { ...i, name: RENAMED } : i))));

    expect(state().matrix.initiatives!.find((i) => i.verdict === "pilot")!.name).toBe(RENAMED);
    expect(lastCall("target").body.inputs.pilotOverride).toEqual({ chosen: RENAMED, suggested: OTD });
    expect(lastCall("roadmap").body.inputs.pilotOverride).toEqual({ chosen: RENAMED, suggested: OTD });
  });
});

describe("regenerating the questions before the gate", () => {
  const withAnswer = () => sessionWith(["classify", "frame", "questions"], { answers: { Q1: "Ancienne réponse" } });

  it("clears the answers when the run starts, so nothing entered afterwards is erased at the end", async () => {
    useSession.setState(withAnswer(), true);
    actions.regenerate("questions", "");
    await settle();
    expect(state().answers).toEqual({});

    actions.setAnswer("Q2", "Réponse à la nouvelle question");
    await finish("questions", fixture("questions"));
    expect(state().stages.questions.status).toBe("done");
    expect(state().answers).toEqual({ Q2: "Réponse à la nouvelle question" });
  });

  it("gives the answers back when no new questions arrive", async () => {
    useSession.setState(withAnswer(), true);
    actions.regenerate("questions", "");
    await settle();
    await fail("questions");
    expect(state().stages.questions.status).toBe("error");
    expect(state().answers).toEqual({ Q1: "Ancienne réponse" });

    actions.regenerate("questions", "");
    await settle();
    expect(state().answers).toEqual({});
    actions.stop();
    await settle();
    expect(state().stages.questions.status).toBe("interrupted");
    expect(state().answers).toEqual({ Q1: "Ancienne réponse" });
  });
});

describe("a failed or interrupted challenge", () => {
  const ANSWER = "Je structurerais ma réponse en quatre étapes : cadrage, diagnostic, options, pilote.";
  const withChallenge = (status: "error" | "interrupted", challengeAnswer = ANSWER): Session => {
    const s = allDone({ challengeAnswer });
    const error = status === "error" ? { code: "timeout", message: "Délai dépassé." } : null;
    return { ...s, stages: { ...s.stages, challenge: { ...s.stages.challenge, status, error } } };
  };

  it("runs again on 'Relancer'", async () => {
    useSession.setState(withChallenge("error"), true);
    actions.retry("challenge");
    await settle();
    expect(calls.map((c) => c.stage)).toEqual(["challenge"]);
    expect(state().stages.challenge.status).toBe("running");
    await finish("challenge", fixture("challenge"));
    expect(state().stages.challenge.status).toBe("done");
  });

  it("runs again on 'Reprendre', or stops showing as stopped when its answer is now too short", async () => {
    useSession.setState(withChallenge("interrupted"), true);
    actions.resume();
    await settle();
    expect(calls.map((c) => c.stage)).toEqual(["challenge"]);
    await finish("challenge", fixture("challenge"));
    expect(state().stages.challenge.status).toBe("done");

    calls = [];
    useSession.setState(withChallenge("error", "Trop court"), true);
    actions.resume();
    await settle();
    expect(calls).toEqual([]);
    expect(state().stages.challenge).toMatchObject({ status: "idle", error: null });
    expect(Object.values(state().stages).some((r) => r.status === "interrupted" || r.status === "error")).toBe(false);
  });
});

describe("carrying the matrix over to new options", () => {
  const done = allDone();
  const next = regenerated();

  it("keeps nothing when the user had not touched the initiatives", () => {
    expect(carryMatrix(null, options.initiatives, next.initiatives)).toEqual({ initiatives: null, notes: [] });
  });

  it("follows the model's new pilot when the user had kept the suggested one", () => {
    const moved = next.initiatives.map((i) => ({ ...i, verdict: i.name === MARGE ? "pilot" : i.name === OTD ? "next" : i.verdict }) as Initiative);
    const sorted = sortByScore(setWeight(done, "value", 0)).matrix.initiatives;
    expect(carryMatrix(sorted, options.initiatives, moved)).toEqual({ initiatives: null, notes: [] });
  });

  it("does not duplicate an added initiative the model took over, and keeps it as the pilot", () => {
    const withIdea = addInitiative(done, "Mon idée");
    const working = setVerdict(withIdea, withIdea.matrix.initiatives!.length - 1, "pilot").matrix.initiatives;
    const taken = [...next.initiatives, { ...next.initiatives[0], name: "Mon Idée", verdict: "next" as const }];
    const carried = carryMatrix(working, options.initiatives, taken).initiatives!;
    expect(carried.map((i) => i.name)).toEqual(taken.map((i) => i.name));
    expect(carried.filter((i) => i.verdict === "pilot").map((i) => i.name)).toEqual(["Mon Idée"]);
  });

  it("matches names whatever their case, accents, quotes, dashes and punctuation", () => {
    const withIdea = addInitiative(done, "L'usine 4.0 : pilotage");
    const working = setVerdict(withIdea, indexOf("Marge"), "pilot").matrix.initiatives;
    const renamed = next.initiatives.map((i) => (i.name === MARGE ? { ...i, name: "MARGE consolidee (trois filiales)" } : i));
    const taken = [...renamed, { ...next.initiatives[0], name: "L’Usine 4.0 – pilotage", verdict: "later" as const }];
    const carried = carryMatrix(working, options.initiatives, taken).initiatives!;
    expect(carried.map((i) => i.name)).toEqual(taken.map((i) => i.name));
    expect(carried.filter((i) => i.verdict === "pilot").map((i) => i.name)).toEqual(["MARGE consolidee (trois filiales)"]);
  });

  it("says when score tweaks or removals are dropped, and only then", () => {
    const dropped = ["Priorisation : la nouvelle version ne reprend pas tes ajustements (scores, verdicts, retraits)."];
    const tweaked = cycleScore(done, 0, "value", -1).matrix.initiatives!;
    expect(carryMatrix(tweaked, options.initiatives, next.initiatives)).toEqual({ initiatives: null, notes: dropped });
    expect(carryMatrix(tweaked, options.initiatives, tweaked).notes).toEqual([]);

    const removed = removeInitiative(done, indexOf("Plateforme")).matrix.initiatives;
    expect(carryMatrix(removed, options.initiatives, next.initiatives).notes).toEqual(dropped);
    expect(carryMatrix(removed, options.initiatives, removed!).notes).toEqual([]);
  });

  it("tells before a regeneration what will be kept", () => {
    expect(matrixCarryHint(null, options.initiatives)).toBeNull();
    const pilot = setVerdict(done, indexOf("Marge"), "pilot");
    expect(matrixCarryHint(addInitiative(pilot, "Mon idée").matrix.initiatives, options.initiatives)).toBe(
      `tu gardes ton pilote « ${MARGE} » (s'il existe encore) et ton initiative ajoutée ; les scores et les autres verdicts suivront la nouvelle version.`,
    );
    expect(matrixCarryHint(pilot.matrix.initiatives, options.initiatives, true)).toBe(
      `tu gardes ton pilote « ${MARGE} » (sauf si ta consigne en fait proposer un autre) ; les scores et les autres verdicts suivront la nouvelle version.`,
    );
    expect(matrixCarryHint(cycleScore(done, 0, "value", 1).matrix.initiatives, options.initiatives)).toBe(
      "tes ajustements seront remplacés par les scores et verdicts de la nouvelle version.",
    );
  });
});
