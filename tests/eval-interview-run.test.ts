import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runLiveEngine } from "@/lib/engine/dispatch";
import { EngineError, type EngineRequest, type EngineResult } from "@/lib/engine/types";
import { CANDIDATE_SYSTEM_PROMPT, candidateFixturePath, MOCK_CANDIDATE_MODEL } from "@/lib/eval/candidate";
import type { InterviewRun } from "@/lib/eval/interview-types";
import { ANSWER_KINDS, type AnswerKind } from "@/lib/eval/metrics";
import { runInterview } from "@/lib/eval/run-interview";
import { DEBRIEF_HEADER, debriefInputs, INTERVIEW_OPENING, mergeObservations } from "@/lib/interview/debrief";
import { INTERVIEWER_SYSTEM_PROMPT, INTERVIEWER_TOOLS_SYSTEM_PROMPT } from "@/lib/interview/prompt";
import { INTERVIEW_MAX_ROUNDS, MAX_CANDIDATE_CHARS, type InterviewObservation, type InterviewState } from "@/lib/interview/schema";
import { runStage } from "@/lib/pipeline/run-stage";
import { SYSTEM_PROMPT } from "@/lib/prompts/system";
import { PIPELINE_STAGE_IDS } from "@/lib/schemas";
import type { StageInputs, StageRequest } from "@/lib/schemas/api";
import { SAMPLE_CASES } from "@/lib/samples";
import { initialSession, type Session } from "@/lib/store/machine";
import { fixture, sessionWith } from "./helpers";

vi.mock("@/lib/engine/dispatch", () => ({ runLiveEngine: vi.fn() }));
// The real stage, watched: the tests read the debrief request the run sends.
vi.mock("@/lib/pipeline/run-stage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pipeline/run-stage")>();
  return { ...actual, runStage: vi.fn(actual.runStage) };
});

const labels = (JSON.parse(readFileSync("evals/challenge-labels.json", "utf8")) as { cases: Record<string, { control: { answer: string } }> })
  .cases;

const SAMPLE = SAMPLE_CASES[0];
const CASE_ID = SAMPLE.id;
const planOf = (persona: AnswerKind) => (persona === "flawed" ? SAMPLE.flawedAnswer : labels[CASE_ID].control.answer);
const recorded = (persona: AnswerKind) => JSON.parse(readFileSync(candidateFixturePath(CASE_ID, persona), "utf8")) as string[];
const QUESTION_IDS = fixture("questions").questions.map((q) => q.id);

/** A session as a full pipeline run leaves it: every stage done and the gate passed, no answer typed. */
const pipelineSession = () => sessionWith([...PIPELINE_STAGE_IDS], { gatePassed: true });

const MOCK = { mock: true, caseId: CASE_ID };
const LIVE = { mock: false, caseId: null };

const play = (persona: AnswerKind, options: { mock: boolean; caseId: string | null; signal?: AbortSignal } = MOCK, session = pipelineSession()) =>
  runInterview({ caseId: CASE_ID, session, persona, plan: planOf(persona), sample: 1 }, options);

const candidateMessages = (run: InterviewRun) => run.messages.filter((m) => m.role === "candidate").map((m) => m.text);
const replies = (run: InterviewRun) => run.messages.filter((m) => m.role === "interviewer").slice(1);

/** The state the page would hold at the end of this run, before its debrief. */
const stateOf = (run: InterviewRun): InterviewState => ({
  status: "done",
  maxRounds: INTERVIEW_MAX_ROUNDS,
  messages: run.messages,
  revealed: run.revealed,
  debrief: null,
  observations: run.observations,
  notes: [],
  error: null,
  closed: false,
});

/** The debrief requests the run sent, with their inputs read as the challenge's. */
const debriefRequests = () =>
  vi.mocked(runStage).mock.calls.map(([stage, request]) => ({
    stage,
    request: request as StageRequest,
    inputs: request.inputs as StageInputs["challenge"],
  }));

// ── A scripted live engine: the candidate, the interviewer and the debrief, told apart by their system prompts ──

type Call = [name: string, input: unknown];
type ClientTurn = { calls?: Call[]; output: unknown };

type Script = {
  /** `shorten`: the candidate is asked again for a shorter message of that round. */
  candidate?: (round: number, shorten: boolean) => string | Error;
  interviewer?: (round: number) => ClientTurn | Error;
  challenge?: () => unknown;
};

const said = (round: number) => `Mon message numéro ${round}, sans chiffre inventé.`;
const probe = (): ClientTurn => ({ output: { reply: "Pouvez-vous préciser votre approche ?", action: "probe", done: false } });

function scriptEngine(script: Script) {
  let candidateRound = 0;
  let clientRound = 0;
  vi.mocked(runLiveEngine).mockImplementation(async (req: EngineRequest): Promise<EngineResult> => {
    if (req.systemPrompt === CANDIDATE_SYSTEM_PROMPT) {
      const shorten = req.userMessage.includes("<draft_too_long>");
      if (!shorten) candidateRound++;
      const message = (script.candidate ?? said)(candidateRound, shorten);
      if (message instanceof Error) throw message;
      return { output: { message }, model: "candidate-model", costUsd: 0.001, rateLimit: null };
    }
    if (req.systemPrompt === INTERVIEWER_TOOLS_SYSTEM_PROMPT || req.systemPrompt === INTERVIEWER_SYSTEM_PROMPT) {
      const turn = (script.interviewer ?? probe)(++clientRound);
      if (turn instanceof Error) throw turn;
      for (const [i, [name, input]] of (turn.calls ?? []).entries()) await req.tools!.call(name, input, { callId: `toolu_${i}` });
      return { output: turn.output, model: "client-model", costUsd: 0.004, rateLimit: null, toolIterations: turn.calls?.length ? 1 : 0 };
    }
    if (req.systemPrompt === SYSTEM_PROMPT) {
      const output = script.challenge ? script.challenge() : fixture("challenge");
      if (output instanceof Error) throw output;
      return { output, model: "debrief-model", costUsd: 0.01, rateLimit: null };
    }
    throw new Error("unexpected engine request");
  });
}

const requestsTo = (systemPrompt: string) =>
  vi.mocked(runLiveEngine).mock.calls.map(([req]) => req).filter((req) => req.systemPrompt === systemPrompt);

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
  vi.mocked(runLiveEngine).mockReset();
  // mockClear, not mockReset: the watched stage keeps running the real one.
  vi.mocked(runStage).mockClear();
  info.mockRestore();
  warn.mockRestore();
});

describe("runInterview, mock", () => {
  it("plays both personas against the demo client in tool mode, then debriefs and scores them", async () => {
    const session = pipelineSession();
    const runs = await Promise.all(ANSWER_KINDS.map((persona) => play(persona, MOCK, session)));

    for (const [i, run] of runs.entries()) {
      const persona = ANSWER_KINDS[i];
      const script = recorded(persona);
      expect(run).toMatchObject({ caseId: CASE_ID, persona, sample: 1, tools: true, questionIds: QUESTION_IDS });
      // The demo client closes by itself at the last round, where the code closes anyway: a close it was told to make.
      expect(run.endedBy).toBe("max_rounds");
      expect(run.turns.map((t) => t.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      for (const turn of run.turns) {
        expect(turn.candidate).toMatchObject({
          truncated: false,
          originalChars: turn.candidate.message.length,
          retried: false,
          model: MOCK_CANDIDATE_MODEL,
          costUsd: 0,
          error: null,
        });
        expect(turn.interviewer).toMatchObject({ ok: true, error: null });
        expect(turn.interviewer?.meta?.model).toBe("démo (sorties enregistrées)");
      }

      // The conversation as the page stores it: the opening, then each message and its reply.
      expect(run.messages).toHaveLength(1 + 2 * INTERVIEW_MAX_ROUNDS);
      expect(run.messages[0]).toEqual({ role: "interviewer", text: INTERVIEW_OPENING });
      expect(run.messages.map((m) => m.role)).toEqual(["interviewer", ...Array(INTERVIEW_MAX_ROUNDS).fill(["candidate", "interviewer"]).flat()]);
      // One recorded message per round, the last one replayed if the script runs out.
      expect(candidateMessages(run)).toEqual(Array.from({ length: INTERVIEW_MAX_ROUNDS }, (_, i) => script[Math.min(i, script.length - 1)]));

      // Tool mode: what the client revealed comes from its get_client_answer calls.
      expect(run.revealed).toEqual(["Q1", "Q3", "Q2", "Q4", "Q5"]);
      const answers = replies(run);
      expect(answers[0]).toMatchObject({ reveal: ["Q1"], action: "clarify", tools: [{ name: "get_client_answer", target: "Q1", ok: true }] });
      expect(answers[1]).toMatchObject({ reveal: [], action: "challenge", tools: [{ name: "lookup_fact", target: "F5", ok: true }] });
      expect(answers[6].tools).toEqual([
        { name: "lookup_fact", target: "F8", ok: true },
        { name: "get_client_answer", target: "Q5", ok: true },
      ]);
      expect(answers[7]).toMatchObject({ action: "wrap_up", reveal: [] });
      expect(answers[7]).not.toHaveProperty("tools");
      expect(run.turns.every((t) => t.interviewer?.data?.reply.trim() === answers[t.round - 1].text)).toBe(true);
      // The demo script notes nothing.
      expect(run.observations).toEqual([]);

      // The debrief the page shows, and the score computed from it.
      expect(run.debrief).toMatchObject({ stage: "challenge", ok: true, error: null });
      expect(run.debrief?.data?.level).toBe(fixture("challenge").level);
      expect(run.score).toMatchObject({
        keyQuestions: { asked: ["Q1", "Q3", "Q2", "Q4", "Q5"], missed: [], total: QUESTION_IDS.length },
        level: fixture("challenge").level,
        roundsUsed: INTERVIEW_MAX_ROUNDS,
        maxRounds: INTERVIEW_MAX_ROUNDS,
      });
      expect(run.score!.score).toBeGreaterThanOrEqual(0);
      expect(run.score!.score).toBeLessThanOrEqual(100);
      expect(run.wallMs).toBeGreaterThan(0);
    }
    // Same client script, two different candidates.
    expect(candidateMessages(runs[0])[0]).not.toBe(candidateMessages(runs[1])[0]);

    // The debrief request is the page's: the challenge stage on the candidate's messages, the revealed answers answered.
    const sent = debriefRequests();
    expect(sent).toHaveLength(2);
    for (const run of runs) {
      const call = sent.find(({ inputs }) => inputs.answer.includes(candidateMessages(run)[0]))!;
      expect(call.stage).toBe("challenge");
      expect(call.request).toMatchObject({ mock: true, caseId: CASE_ID, steer: null, previous: null, choices: null });
      expect(call.inputs).toEqual(debriefInputs(session, stateOf(run)));
      expect(call.inputs.answer.startsWith(DEBRIEF_HEADER)).toBe(true);
      expect(call.inputs.clarifications?.map((c) => c.status)).toEqual(QUESTION_IDS.map(() => "answered"));
    }
    expect(runLiveEngine).not.toHaveBeenCalled();
  }, 60_000);

  it("runs the structured mode when the tools are off, the reveal declared by the model", async () => {
    process.env.CONSULTANT_DOTS_INTERVIEW_TOOLS = "off";
    const run = await play("control");
    expect(run.tools).toBe(false);
    expect(run.endedBy).toBe("max_rounds");
    expect(run.turns).toHaveLength(INTERVIEW_MAX_ROUNDS);
    expect(run.revealed).toEqual(["Q1", "Q3", "Q2", "Q4", "Q5"]);
    // No tool ran: no trace on any reply, no observation.
    expect(replies(run).every((m) => !("tools" in m))).toBe(true);
    expect(replies(run)[0]).toMatchObject({ reveal: ["Q1"], action: "clarify" });
    expect(run.turns.every((t) => t.interviewer?.data?.toolCalls.length === 0)).toBe(true);
    expect(run.observations).toEqual([]);
    expect(run.debrief?.ok).toBe(true);
    expect(run.score?.keyQuestions.asked).toEqual(["Q1", "Q3", "Q2", "Q4", "Q5"]);
  }, 60_000);

  it("records a stopped run as an error, without a debrief", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = await play("flawed", { ...MOCK, signal: controller.signal });
    expect(run.endedBy).toBe("error");
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0]).toMatchObject({ round: 1, interviewer: null, candidate: { error: { code: "aborted" } } });
    expect(run.messages).toEqual([{ role: "interviewer", text: INTERVIEW_OPENING }]);
    expect(run.debrief).toBeNull();
    expect(run.score).toBeNull();
    expect(runStage).not.toHaveBeenCalled();
  });

  it("throws when the session cannot host an interview", async () => {
    await expect(play("flawed", MOCK, sessionWith(["classify"]))).rejects.toThrow(/cannot host an interview/);
    const noQuestions: Session = { ...initialSession(), started: true, caseText: SAMPLE.text };
    await expect(play("control", MOCK, noQuestions)).rejects.toThrow(/data-platform cannot host an interview/);
    expect(runStage).not.toHaveBeenCalled();
  });
});

describe("runInterview, scripted engine", () => {
  it("ends when the client closes, keeps one observation per reflex and tells the client what it noted", async () => {
    const messages = [
      "Je propose de migrer tout de suite vers un data lake dans le cloud.",
      "Qui tranche les définitions de KPI entre les filiales ?",
      "Je recommande un pilote sur l'OTD, puis une montée en charge par filiale.",
    ];
    const clientTurns: ClientTurn[] = [
      {
        calls: [["record_observation", { reflex: "E1", severity: "high", quote: "migrer tout de suite vers un data lake", note: "Il part de la solution." }]],
        output: { reply: "Avant de parler d'outil : qu'est-ce qui rend mes chiffres contestés ?", action: "challenge", done: false },
      },
      {
        // A second note on E1 in a later turn: the tools refuse it, since the run says E1 is already noted.
        calls: [
          ["get_client_answer", { question_id: "Q3" }],
          ["record_observation", { reflex: "E1", severity: "medium", quote: "Qui tranche les définitions", note: "Encore la solution." }],
          ["record_observation", { reflex: "E6", severity: "medium", quote: "Qui tranche les définitions", note: "Aucune mesure du succès." }],
        ],
        output: { reply: "Le DAF groupe est prêt à porter le sujet. Et ensuite ?", action: "clarify", done: false },
      },
      { output: { reply: "Merci, nous allons nous arrêter là.", action: "wrap_up", done: true } },
    ];
    scriptEngine({ candidate: (round) => messages[round - 1], interviewer: (round) => clientTurns[round - 1] });
    const run = await play("control", LIVE);

    expect(run.endedBy).toBe("client");
    expect(run.turns).toHaveLength(3);
    expect(candidateMessages(run)).toEqual(messages);
    expect(run.revealed).toEqual(["Q3"]);
    expect(run.observations.map(({ reflex, round }) => ({ reflex, round }))).toEqual([
      { reflex: "E1", round: 1 },
      { reflex: "E6", round: 2 },
    ]);
    // The second note on E1 was refused: the client was told E1 was already noted.
    const clientRequests = requestsTo(INTERVIEWER_TOOLS_SYSTEM_PROMPT);
    expect(clientRequests).toHaveLength(3);
    expect(clientRequests[0].userMessage).toContain("Weaknesses already noted: none yet.");
    expect(clientRequests[1].userMessage).toMatch(/Weaknesses already noted: E1 \(/);
    expect(clientRequests[2].userMessage).toMatch(/Weaknesses already noted: E1 \(.*\), E6 \(/);
    expect(clientRequests[1].userMessage).toContain("Client answers already given: none yet.");
    expect(clientRequests[2].userMessage).toContain("Client answers already given: Q3.");
    expect(replies(run)[1].tools?.map((t) => [t.target, t.ok])).toEqual([
      ["Q3", true],
      ["E1", false],
      ["E6", true],
    ]);

    // The candidate saw the client's replies, round after round.
    const candidateRequests = requestsTo(CANDIDATE_SYSTEM_PROMPT);
    expect(candidateRequests).toHaveLength(3);
    expect(candidateRequests[0].userMessage).toContain("Message 1 of 8");
    expect(candidateRequests[2].userMessage).toContain("Message 3 of 8");
    expect(candidateRequests[2].userMessage).toContain("Le DAF groupe est prêt à porter le sujet.");
    expect(run.turns[0].candidate).toMatchObject({ model: "candidate-model", costUsd: 0.001 });

    // Live, the debrief carries no case id, as on the page: it would record over the sample's fixture.
    const [debrief] = debriefRequests();
    expect(debrief.request).toMatchObject({ mock: false, caseId: null });
    expect(debrief.inputs).toEqual(debriefInputs(pipelineSession(), stateOf(run)));
    expect(run.debrief).toMatchObject({ ok: true, meta: { model: "debrief-model" } });
    expect(run.score).toMatchObject({ keyQuestions: { asked: ["Q3"], total: QUESTION_IDS.length }, roundsUsed: 3 });
  });

  it("says max_rounds when the code closes at the last round", async () => {
    scriptEngine({});
    const run = await play("flawed", LIVE);
    expect(run.endedBy).toBe("max_rounds");
    expect(run.turns).toHaveLength(INTERVIEW_MAX_ROUNDS);
    const last = run.turns.at(-1)!.interviewer!;
    expect(last.data).toMatchObject({ action: "wrap_up", done: true });
    expect(last.meta?.checks?.closeForced).toBe(1);
    expect(run.score?.roundsUsed).toBe(INTERVIEW_MAX_ROUNDS);
  });

  it("asks the candidate to shorten an over-cap message, and the client reads the shorter one", async () => {
    const long = `${"Voici une phrase de mon raisonnement, assez longue pour compter. ".repeat(30)}Prochaine étape : un atelier.`;
    const short = "Je recommande le pilote dont nous avons parlé. Prochaine étape : un atelier.";
    scriptEngine({ candidate: (round, shorten) => (round !== 8 ? said(round) : shorten ? short : long) });
    const run = await play("control", LIVE);

    expect(run.endedBy).toBe("max_rounds");
    // One extra call, for the last message only.
    const asked = requestsTo(CANDIDATE_SYSTEM_PROMPT);
    expect(asked).toHaveLength(INTERVIEW_MAX_ROUNDS + 1);
    expect(asked.filter((req) => req.userMessage.includes("<draft_too_long>"))).toHaveLength(1);
    expect(asked.at(-1)?.userMessage).toContain(long.trim());

    const last = run.turns.at(-1)!;
    expect(last.candidate).toMatchObject({ message: short, truncated: false, originalChars: long.trim().length, retried: true, error: null });
    expect(last.candidate.costUsd).toBeCloseTo(0.002, 10);
    expect(run.turns.slice(0, -1).every((t) => !t.candidate.retried && t.candidate.originalChars === said(t.round).length)).toBe(true);
    // The client reads the rewrite, its next step included.
    expect(candidateMessages(run).at(-1)).toBe(short);
    expect(requestsTo(INTERVIEWER_TOOLS_SYSTEM_PROMPT).at(-1)?.userMessage).toContain(short);
    expect(last.interviewer?.ok).toBe(true);
  });

  it("cuts the message before the client reads it when the rewrite is still over the cap", async () => {
    const long = `${"Voici une phrase de mon raisonnement, assez longue pour compter. ".repeat(30)}`;
    scriptEngine({ candidate: () => long });
    const run = await play("control", LIVE);
    expect(run.turns[0].candidate).toMatchObject({ truncated: true, retried: true, originalChars: long.trim().length, error: null });
    expect(run.turns[0].interviewer?.ok).toBe(true);
    expect(requestsTo(CANDIDATE_SYSTEM_PROMPT)).toHaveLength(2 * INTERVIEW_MAX_ROUNDS);
    expect(candidateMessages(run).every((text) => text.length <= MAX_CANDIDATE_CHARS)).toBe(true);
  });

  it("cuts the draft and plays on when the rewrite fails", async () => {
    const long = `${"Voici une phrase de mon raisonnement, assez longue pour compter. ".repeat(30)}`;
    scriptEngine({
      candidate: (round, shorten) => (round !== 2 ? said(round) : shorten ? new EngineError("timeout", "Délai dépassé.") : long),
    });
    const run = await play("flawed", LIVE);
    expect(run.endedBy).toBe("max_rounds");
    expect(run.turns).toHaveLength(INTERVIEW_MAX_ROUNDS);
    expect(run.turns[1].candidate).toMatchObject({ truncated: true, retried: true, costUsd: null, error: null });
    expect(candidateMessages(run)[1].length).toBeLessThanOrEqual(MAX_CANDIDATE_CHARS);
    expect(long.startsWith(candidateMessages(run)[1])).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("records a candidate failure: an error ending, the debrief on what was said, nothing thrown", async () => {
    scriptEngine({ candidate: (round) => (round === 3 ? new EngineError("usage_limit", "Limite d'usage atteinte.") : said(round)) });
    const run = await play("flawed", LIVE);
    expect(run.endedBy).toBe("error");
    expect(run.turns).toHaveLength(3);
    expect(run.turns[2]).toMatchObject({ round: 3, interviewer: null, candidate: { message: "", error: { code: "usage_limit" } } });
    expect(run.messages).toHaveLength(5);
    expect(run.messages.at(-1)?.role).toBe("interviewer");
    const [debrief] = debriefRequests();
    expect(debrief.inputs.answer).toBe(`${DEBRIEF_HEADER}\n1. ${said(1)}\n2. ${said(2)}`);
    expect(run.debrief?.ok).toBe(true);
    expect(run.score?.roundsUsed).toBe(2);
  });

  it("skips the debrief when the candidate never spoke", async () => {
    scriptEngine({ candidate: () => new EngineError("timeout", "Délai dépassé.") });
    const run = await play("control", LIVE);
    expect(run).toMatchObject({ endedBy: "error", debrief: null, score: null });
    expect(run.turns).toEqual([expect.objectContaining({ round: 1, interviewer: null })]);
    expect(run.messages).toEqual([{ role: "interviewer", text: INTERVIEW_OPENING }]);
    expect(runStage).not.toHaveBeenCalled();
    expect(requestsTo(INTERVIEWER_TOOLS_SYSTEM_PROMPT)).toHaveLength(0);
  });

  it("records an interviewer failure: an error ending, the candidate's message kept, nothing thrown", async () => {
    scriptEngine({ interviewer: (round) => (round === 2 ? new EngineError("timeout", "Délai dépassé.") : probe()) });
    const run = await play("control", LIVE);
    expect(run.endedBy).toBe("error");
    expect(run.turns).toHaveLength(2);
    expect(run.turns[1].interviewer).toMatchObject({ ok: false, data: null, meta: null, error: { code: "timeout", message: "Délai dépassé." } });
    // As on the page, the unanswered message stays and the debrief reads it.
    expect(run.messages.map((m) => m.role)).toEqual(["interviewer", "candidate", "interviewer", "candidate"]);
    expect(debriefRequests()[0].inputs.answer).toContain(`2. ${said(2)}`);
    expect(run.debrief?.ok).toBe(true);
    expect(run.score?.roundsUsed).toBe(2);
  });

  it("records an interviewer reply off the schema as invalid output", async () => {
    scriptEngine({ interviewer: () => ({ output: { reply: "Bonjour." } }) });
    const run = await play("flawed", LIVE);
    expect(run.endedBy).toBe("error");
    expect(run.turns).toHaveLength(1);
    expect(run.turns[0].interviewer).toMatchObject({ ok: false, data: null, error: { code: "invalid_output" } });
  });

  it("records a failed debrief without a score", async () => {
    scriptEngine({ challenge: () => new EngineError("overloaded", "Serveurs surchargés.") });
    const run = await play("control", LIVE);
    expect(run.endedBy).toBe("max_rounds");
    expect(run.debrief).toMatchObject({ stage: "challenge", ok: false, data: null, meta: null, error: { code: "overloaded" } });
    expect(run.score).toBeNull();
  });
});

describe("mergeObservations", () => {
  const note = (reflex: InterviewObservation["reflex"], round: number): InterviewObservation => ({
    reflex,
    severity: "high",
    quote: "data lake",
    note: "Une note.",
    round,
  });

  it("keeps one observation per reflex, the first one, in order", () => {
    const merged = mergeObservations([note("E1", 1)], [note("E1", 2), note("E6", 2), note("E6", 2)]);
    expect(merged).toEqual([note("E1", 1), note("E6", 2)]);
    expect(mergeObservations([], [])).toEqual([]);
  });
});
