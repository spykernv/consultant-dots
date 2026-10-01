"use client";

import { Allow, parse } from "partial-json";
import type { StageId, StageOutputs } from "@/lib/schemas";
import type { StageEvent } from "@/lib/schemas/api";
import type { Criterion } from "@/lib/domain/scoring";
import type { OptionsAnalysis, Verdict } from "@/lib/schemas/options";
import {
  addInitiative,
  buildInputs,
  canRun,
  cycleScore,
  cycleVerdict,
  effectiveOptions,
  hashInputsOf,
  initialSession,
  markInterrupted,
  matrixChoicesOf,
  passGate,
  removeInitiative,
  resetMatrix,
  resetStale,
  resumeStopped,
  retryStage,
  runnableStages,
  setVerdict,
  setWeight,
  sortByScore,
  type Session,
  type StageRun,
  type TimerState,
  type ZoneKey,
} from "./machine";
import { carryMatrix, withoutMatrixNotices } from "./matrix-carry";
import { useLive, useSession, type LivePhase } from "./session-store";

const controllers = new Map<StageId, AbortController>();
const buffers = new Map<StageId, string>();
const partialTimers = new Map<StageId, ReturnType<typeof setTimeout>>();

const get = () => useSession.getState();

function updateRun<K extends StageId>(stage: K, patch: Partial<StageRun<StageOutputs[K]>>) {
  useSession.setState((s) => ({ stages: { ...s.stages, [stage]: { ...s.stages[stage], ...patch } } }));
}

function setLivePhase(stage: StageId, phase: LivePhase) {
  useLive.setState((l) => ({ phase: { ...l.phase, [stage]: phase } }));
}

function flushPartial(stage: StageId) {
  const text = buffers.get(stage);
  if (!text) return;
  try {
    // Numbers stay hidden until complete so a score of 5 never flashes as a truncated digit.
    const value = parse(text, Allow.ALL & ~Allow.NUM);
    useLive.setState((l) => ({ partial: { ...l.partial, [stage]: value } }));
  } catch {
    // Not parseable yet: wait for the next delta.
  }
}

function schedulePartial(stage: StageId) {
  if (partialTimers.has(stage)) return;
  partialTimers.set(
    stage,
    setTimeout(() => {
      partialTimers.delete(stage);
      flushPartial(stage);
    }, 90),
  );
}

function clearLive(stage: StageId) {
  buffers.delete(stage);
  clearTimeout(partialTimers.get(stage));
  partialTimers.delete(stage);
  useLive.setState((l) => {
    const partial = { ...l.partial };
    const phase = { ...l.phase };
    const startedAt = { ...l.startedAt };
    delete partial[stage];
    delete phase[stage];
    delete startedAt[stage];
    return { partial, phase, startedAt };
  });
}

type Revision = { steer: string | null; previous: unknown };

async function runStage(stage: StageId, revision: Revision | null = null) {
  const state = get();
  if (state.stages[stage].status === "running" || !canRun(state, stage)) return;

  const inputs = buildInputs(state, stage);
  const runId = crypto.randomUUID();
  const epoch = state.epoch;
  // New questions void the answers typed for the previous ones; they come back if no new questions arrive.
  const replacedAnswers =
    stage === "questions" && state.stages.questions.data !== null && !state.gatePassed ? state.answers : null;
  updateRun(stage, {
    status: "running",
    runId,
    inputHash: hashInputsOf(stage, inputs),
    error: null,
    steer: revision?.steer ?? null,
  });
  if (replacedAnswers) useSession.setState({ answers: {} });
  const restoreAnswers = () => {
    if (replacedAnswers) useSession.setState({ answers: replacedAnswers });
  };
  buffers.set(stage, "");
  useLive.setState((l) => ({
    partial: { ...l.partial, [stage]: undefined },
    phase: { ...l.phase, [stage]: "starting" },
    startedAt: { ...l.startedAt, [stage]: Date.now() },
  }));

  const controller = new AbortController();
  controllers.set(stage, controller);
  const isCurrent = () => {
    const s = get();
    return s.epoch === epoch && s.stages[stage].runId === runId;
  };
  let settled = false;

  const handle = (event: StageEvent) => {
    if (!isCurrent()) return;
    switch (event.type) {
      case "status":
        setLivePhase(stage, event.phase);
        // A new StructuredOutput attempt restarts the JSON from scratch.
        if (event.phase === "writing") buffers.set(stage, "");
        break;
      case "delta":
        buffers.set(stage, (buffers.get(stage) ?? "") + event.text);
        schedulePartial(stage);
        break;
      case "done": {
        settled = true;
        const carried =
          stage === "options" ? carryMatrixOf(event.data as OptionsAnalysis, Boolean(revision?.steer)) : null;
        updateRun(stage, {
          status: "done",
          data: event.data as StageOutputs[typeof stage],
          ms: event.meta.ms,
          model: event.meta.model,
          costUsd: event.meta.costUsd,
          notes: carried ? [...event.meta.notes, ...carried.notes] : event.meta.notes,
          error: null,
        });
        if (carried) useSession.setState((s) => ({ matrix: { ...s.matrix, initiatives: carried.initiatives } }));
        clearLive(stage);
        break;
      }
      case "error":
        settled = true;
        updateRun(stage, {
          status: event.code === "aborted" ? "interrupted" : "error",
          error: { code: event.code, message: event.message },
        });
        restoreAnswers();
        clearLive(stage);
        break;
    }
  };

  try {
    const response = await fetch(`/api/stage/${stage}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        mock: state.mock,
        caseId: state.caseId,
        inputs,
        steer: revision?.steer ?? null,
        previous: revision?.previous ?? null,
        // On every Options run, stale refreshes included, so the model can keep the user's pilot and names.
        choices: stage === "options" ? matrixChoicesOf(state) : null,
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      handle({ type: "error", code: "engine_error", message: body?.error ?? `Erreur HTTP ${response.status}` });
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) handle(JSON.parse(line) as StageEvent);
      }
    }
    if (!settled) handle({ type: "error", code: "engine_error", message: "Le flux s'est interrompu avant la fin." });
  } catch (err) {
    if (controller.signal.aborted) {
      if (isCurrent()) {
        updateRun(stage, { status: "interrupted" });
        restoreAnswers();
        clearLive(stage);
      }
    } else {
      handle({ type: "error", code: "engine_error", message: err instanceof Error ? err.message : String(err) });
    }
  } finally {
    if (controllers.get(stage) === controller) controllers.delete(stage);
    pump();
  }
}

/** Fresh options replace the matrix edits built on the previous ones, except the choices that still apply. */
function carryMatrixOf(next: OptionsAnalysis, steered: boolean) {
  const s = get();
  return carryMatrix(s.matrix.initiatives, s.stages.options.data?.initiatives ?? [], next.initiatives, steered);
}

/** The challenge is never pumped: it runs again here, or drops its error once its answer can no longer be sent. */
function rerunChallenge() {
  if (canRun(get(), "challenge")) void runStage("challenge");
  else updateRun("challenge", { status: "idle", error: null });
}

export function pump() {
  const s = get();
  if (!s.autoRun) return;
  for (const stage of runnableStages(s)) void runStage(stage);
}

function abortAll() {
  for (const controller of controllers.values()) controller.abort();
  controllers.clear();
}

export function timerRemaining(timer: TimerState, now = Date.now()) {
  if (timer.startedAt) return Math.max(0, timer.durationSec - (now - timer.startedAt) / 1000);
  return timer.remainingAtPause ?? timer.durationSec;
}

const startedTimer = (timer: TimerState): TimerState => ({
  ...timer,
  startedAt: Date.now() - (timer.durationSec - (timer.remainingAtPause ?? timer.durationSec)) * 1000,
  remainingAtPause: null,
});

/** What the last Options run said about the matrix stops applying once the user edits its initiatives. */
const editMatrix = (update: (s: Session) => Session) =>
  useSession.setState((s) => {
    const next = update(s);
    const { options } = next.stages;
    const notes = withoutMatrixNotices(options.notes);
    if (next.matrix.initiatives === s.matrix.initiatives || notes.length === options.notes.length) return next;
    return { ...next, stages: { ...next.stages, options: { ...options, notes } } };
  });

export const actions = {
  loadCase(caseText: string, caseId: string | null) {
    useSession.setState({ caseText, caseId });
  },
  setCaseText(caseText: string) {
    useSession.setState({ caseText, caseId: null });
  },
  analyse(options: { mock: boolean; startTimer: boolean }) {
    const s = get();
    if (s.caseText.trim().length < 20) return;
    useSession.setState({
      started: true,
      mock: options.mock,
      autoRun: true,
      timer: options.startTimer && !s.timer.startedAt ? startedTimer(s.timer) : s.timer,
    });
    pump();
  },
  setAnswer(questionId: string, answer: string) {
    useSession.setState((s) => ({ answers: { ...s.answers, [questionId]: answer } }));
  },
  setClientNotes(clientNotes: string) {
    useSession.setState({ clientNotes });
  },
  continueAfterQuestions() {
    useSession.setState((s) => passGate(s));
    pump();
  },
  refreshStale() {
    useSession.setState((s) => resetStale(s));
    pump();
  },
  regenerate(stage: StageId, steer: string) {
    const s = get();
    const run = s.stages[stage];
    if (run.status === "running") return;
    useSession.setState({ autoRun: true });
    // Options are revised from what the user sees: their pilot and the initiatives they added.
    const previous = stage === "options" ? effectiveOptions(s) : run.data;
    void runStage(stage, { steer: steer.trim() || null, previous });
  },
  setChallengeAnswer(challengeAnswer: string) {
    useSession.setState({ challengeAnswer });
  },
  runChallenge() {
    void runStage("challenge");
  },
  setNote(zone: ZoneKey, text: string) {
    useSession.setState((s) => ({ notes: { ...s.notes, [zone]: text } }));
  },
  matrix: {
    cycleScore: (index: number, criterion: Criterion, direction: 1 | -1) =>
      editMatrix((s) => cycleScore(s, index, criterion, direction)),
    cycleVerdict: (index: number) => editMatrix((s) => cycleVerdict(s, index)),
    setVerdict: (index: number, verdict: Verdict) => editMatrix((s) => setVerdict(s, index, verdict)),
    add: (name: string) => editMatrix((s) => addInitiative(s, name)),
    remove: (index: number) => editMatrix((s) => removeInitiative(s, index)),
    setWeight: (criterion: Criterion, weight: number) => editMatrix((s) => setWeight(s, criterion, weight)),
    sort: () => editMatrix(sortByScore),
    reset: () => editMatrix(resetMatrix),
  },
  retry(stage: StageId) {
    if (stage === "challenge") return rerunChallenge();
    useSession.setState((s) => retryStage(s, stage));
    pump();
  },
  resume() {
    const challenge = get().stages.challenge.status;
    useSession.setState((s) => resumeStopped(s));
    pump();
    if (challenge === "interrupted" || challenge === "error") rerunChallenge();
  },
  stop() {
    useSession.setState({ autoRun: false });
    abortAll();
  },
  /** Replaces the tab's session with a case saved on disk; runs cut short by a closed tab stay "interrompue". */
  openSaved(saved: Session, savedId: string) {
    abortAll();
    for (const stage of [...buffers.keys()]) clearLive(stage);
    const epoch = get().epoch + 1;
    useSession.setState(markInterrupted({ ...initialSession(epoch), ...saved, epoch, savedId, autoRun: false }), true);
    useLive.setState({ partial: {}, phase: {}, startedAt: {} }, true);
  },
  clear() {
    abortAll();
    for (const stage of [...buffers.keys()]) clearLive(stage);
    useSession.setState(initialSession(get().epoch + 1), true);
    useLive.setState({ partial: {}, phase: {}, startedAt: {} }, true);
  },
  startTimer() {
    useSession.setState((s) => ({ timer: startedTimer(s.timer) }));
  },
  pauseTimer() {
    useSession.setState((s) => ({ timer: { ...s.timer, startedAt: null, remainingAtPause: timerRemaining(s.timer) } }));
  },
  resetTimer() {
    useSession.setState((s) => ({ timer: { ...s.timer, startedAt: null, remainingAtPause: null } }));
  },
};
