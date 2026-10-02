"use client";

import type { StageOutputs } from "@/lib/schemas";
import type { DoneMeta, StageEvent, StageRequest } from "@/lib/schemas/api";
import { passGate } from "@/lib/store/machine";
import { actions, pump } from "@/lib/store/orchestrator";
import { useSession } from "@/lib/store/session-store";
import {
  INTERVIEW_MAX_ROUNDS,
  InterviewTurnResultSchema,
  MAX_CANDIDATE_CHARS,
  type InterviewMessage,
  type InterviewRequest,
  type InterviewState,
  type InterviewStatus,
} from "./schema";
import { buildFactSheet, candidateTexts, debriefInputs, INTERVIEW_OPENING, mergeObservations } from "./debrief";

// The eval runs the same interview in node: what it shares with this page lives in debrief.ts, away from the store.
export { buildFactSheet, INTERVIEW_OPENING };

/**
 * The step that failed is told by the error text, saved with the session: a failed turn and a debrief started from
 * it (end() after the failure) both end on the candidate's message, and only the text survives a reload.
 */
const TURN_FAILED = "Le client n'a pas pu répondre : ";
const DEBRIEF_FAILED = "Le débrief n'a pas pu être généré : ";
const DEBRIEF_INTERRUPTED = "Le débrief a été interrompu. Relance-le.";

const debriefFailed = (interview: InterviewState) =>
  interview.error === DEBRIEF_INTERRUPTED || Boolean(interview.error?.startsWith(DEBRIEF_FAILED));

const PREPARATION_STAGES = ["classify", "frame", "questions"] as const;

const get = () => useSession.getState();

/** Interviews saved before the client could take notes have no observations field. */
const observationsOf = (interview: InterviewState) => interview.observations ?? [];

function patchInterview(patch: Partial<InterviewState>) {
  useSession.setState((s) => (s.interview ? { interview: { ...s.interview, ...patch } } : s));
}

// ── Requests ────────────────────────────────────────────────────────────────

type Outcome = { type: "done"; data: unknown; meta: DoneMeta } | { type: "error"; message: string };

/** The request this page waits for. After a reload there is none, whatever status the saved interview shows. */
let inFlight: { runId: string; controller: AbortController } | null = null;

function abortInFlight() {
  inFlight?.controller.abort();
  inFlight = null;
}

/** Reads the route's NDJSON stream down to its final event, as the orchestrator does for the stages. */
async function postStream(url: string, body: unknown, signal: AbortSignal): Promise<Outcome> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    return { type: "error", message: payload?.error ?? `Erreur HTTP ${response.status}` };
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
      if (!line) continue;
      const event = JSON.parse(line) as StageEvent;
      if (event.type === "done") return event;
      if (event.type === "error") return { type: "error", message: event.message };
    }
  }
  return { type: "error", message: "Le flux s'est interrompu avant la fin." };
}

/**
 * Sends one request for the interview as it stands. The outcome is dropped (null) when the session moved on
 * meanwhile: another case, a cleared session, a restarted or closed interview, or a newer request.
 */
async function exchange(url: string, body: { runId: string }, expected: InterviewStatus): Promise<Outcome | null> {
  abortInFlight();
  const { runId } = body;
  const controller = new AbortController();
  const start = get();
  const epoch = start.epoch;
  const sent = start.interview?.messages.length ?? 0;
  inFlight = { runId, controller };
  const isCurrent = () => {
    const s = get();
    return (
      inFlight?.runId === runId &&
      s.epoch === epoch &&
      s.interview !== null &&
      !s.interview.closed &&
      s.interview.status === expected &&
      s.interview.messages.length === sent
    );
  };

  let outcome: Outcome;
  try {
    outcome = await postStream(url, body, controller.signal);
  } catch (err) {
    outcome = { type: "error", message: `La requête a échoué : ${err instanceof Error ? err.message : String(err)}` };
  }
  const current = isCurrent();
  if (inFlight?.runId === runId) inFlight = null;
  return current ? outcome : null;
}

// ── Interviewer turn ────────────────────────────────────────────────────────

async function runTurn() {
  const s = get();
  const interview = s.interview;
  const factSheet = buildFactSheet(s);
  if (!interview || interview.status !== "waiting" || !factSheet) return;

  const round = candidateTexts(interview).length;
  const request: InterviewRequest = {
    runId: crypto.randomUUID(),
    mock: s.mock,
    caseId: s.caseId,
    inputs: {
      caseText: s.caseText,
      factSheet,
      transcript: interview.messages
        .map(({ role, text }) => ({ role, text: text.slice(0, MAX_CANDIDATE_CHARS * 2) }))
        .filter((m) => m.text.trim()),
      round,
      maxRounds: interview.maxRounds,
      revealed: interview.revealed,
      // Tool mode: the server refuses a second note on these, so the debrief lists each weakness once.
      notedReflexes: [...new Set(observationsOf(interview).map((o) => o.reflex))],
    },
  };

  const outcome = await exchange("/api/interview", request, "waiting");
  if (!outcome) return;
  if (outcome.type === "error") return patchInterview({ status: "error", error: TURN_FAILED + outcome.message });
  // Its defaults read a structured-mode turn too, which has neither observations nor tool calls.
  const parsed = InterviewTurnResultSchema.safeParse(outcome.data);
  if (!parsed.success || !parsed.data.reply.trim()) {
    return patchInterview({ status: "error", error: "La réponse du client est illisible. Relance pour la redemander." });
  }

  const turn = parsed.data;
  // Only the fact sheet's answers count as revealed, so the score and the debrief never credit an invented id.
  const known = new Set(factSheet.clientAnswers.map((a) => a.id));
  const reveal = [...new Set(turn.reveal.filter((id) => known.has(id)))];
  // The code ends the interview, the model only asks: at the last round it closes whatever the model said.
  const finished = turn.done || round >= interview.maxRounds;
  const reply: InterviewMessage = {
    role: "interviewer",
    text: turn.reply.trim(),
    reveal,
    action: turn.action,
    ...(turn.toolCalls.length > 0 ? { tools: turn.toolCalls } : {}),
  };
  useSession.setState((now) =>
    now.interview
      ? {
          interview: {
            ...now.interview,
            messages: [...now.interview.messages, reply],
            revealed: [...now.interview.revealed, ...reveal.filter((id) => !now.interview!.revealed.includes(id))],
            observations: mergeObservations(observationsOf(now.interview), turn.observations),
            notes: [...now.interview.notes, ...outcome.meta.notes],
            status: finished ? "debriefing" : "ready",
            error: null,
          },
        }
      : now,
  );
  if (finished) void runDebrief();
}

// ── Debrief ─────────────────────────────────────────────────────────────────

async function runDebrief() {
  const s = get();
  const interview = s.interview;
  if (!interview || interview.status !== "debriefing") return;

  // stages.challenge and challengeAnswer stay the user's own written answer: the debrief lives in the interview.
  const request: StageRequest = {
    runId: crypto.randomUUID(),
    mock: s.mock,
    // Live, the case id only serves to record fixtures: this debrief would overwrite the sample's challenge
    // fixture, recorded on a written answer, that the regular demo replays.
    caseId: s.mock ? s.caseId : null,
    inputs: debriefInputs(s, interview),
    steer: null,
    previous: null,
    choices: null,
  };
  const outcome = await exchange("/api/stage/challenge", request, "debriefing");
  if (!outcome) return;
  if (outcome.type === "error") return patchInterview({ status: "error", error: DEBRIEF_FAILED + outcome.message });
  useSession.setState((now) =>
    now.interview
      ? {
          interview: {
            ...now.interview,
            debrief: outcome.data as StageOutputs["challenge"],
            // The demo replays a debrief recorded on another answer: its notes would only list quotes missing here.
            notes: s.mock ? now.interview.notes : [...now.interview.notes, ...outcome.meta.notes],
            status: "done",
            error: null,
          },
        }
      : now,
  );
}

// ── Preparation and recovery ────────────────────────────────────────────────

/** While the fact sheet is built: the client speaks first once it is ready; a failed or stopped stage is an error. */
function syncPreparation() {
  const s = get();
  const interview = s.interview;
  if (!interview || interview.closed) return;
  // An error before the opening is a stopped preparation, which the top bar's « Reprendre » can restart too.
  const stopped = interview.status === "error" && interview.messages.length === 0;
  if (interview.status !== "preparing" && !stopped) return;
  if (buildFactSheet(s)) {
    const opening: InterviewMessage = { role: "interviewer", text: INTERVIEW_OPENING };
    patchInterview({ status: "ready", error: null, messages: interview.messages.length ? interview.messages : [opening] });
    return;
  }
  const failed = PREPARATION_STAGES.map((id) => s.stages[id]).find(
    (run) => run.status === "error" || run.status === "interrupted",
  );
  if (!failed) {
    if (stopped) patchInterview({ status: "preparing", error: null });
    return;
  }
  if (stopped) return;
  patchInterview({
    status: "error",
    error:
      failed.status === "error"
        ? `La préparation de l'entretien a échoué : ${failed.error?.message ?? "erreur inconnue"}`
        : "La préparation de l'entretien a été interrompue. Relance-la.",
  });
}

/** A request cut short by a reload or by opening a case leaves a status nothing will finish: it becomes retryable. */
function recover() {
  const interview = get().interview;
  if (!interview || interview.closed) return;
  if (interview.status === "preparing") return syncPreparation();
  if (inFlight) return;
  if (interview.status === "waiting") {
    patchInterview({ status: "error", error: "La réponse du client a été interrompue. Relance pour la redemander." });
  } else if (interview.status === "debriefing") {
    patchInterview({ status: "error", error: DEBRIEF_INTERRUPTED });
  }
}

let watching = false;

/** Follows the pipeline while the fact sheet is built, and drops the request of a session that was replaced. */
function watch() {
  if (watching) return;
  watching = true;
  useSession.subscribe((s, prev) => {
    if (s.epoch !== prev.epoch) {
      abortInFlight();
      recover();
    } else if (s.stages !== prev.stages || s.interview !== prev.interview) {
      syncPreparation();
    }
  });
}

// ── Actions ─────────────────────────────────────────────────────────────────

export const interviewActions = {
  /** Starts the case as an interview: the pipeline builds the fact sheet and stops at the clarification gate. */
  start(options: { mock: boolean; startTimer: boolean }) {
    // The interview comes before the analysis: once the gate is passed, the client would have nothing left to tell.
    if (get().gatePassed) return;
    watch();
    abortInFlight();
    actions.analyse(options);
    if (!get().started) return;
    useSession.setState({
      interview: {
        status: "preparing",
        maxRounds: INTERVIEW_MAX_ROUNDS,
        messages: [],
        revealed: [],
        debrief: null,
        observations: [],
        notes: [],
        error: null,
        closed: false,
      },
    });
    syncPreparation();
  },

  send(text: string) {
    watch();
    const interview = get().interview;
    const message = text.trim().slice(0, MAX_CANDIDATE_CHARS).trim();
    if (!interview || interview.closed || interview.status !== "ready" || !message) return;
    if (candidateTexts(interview).length >= interview.maxRounds) return;
    patchInterview({
      messages: [...interview.messages, { role: "candidate", text: message }],
      status: "waiting",
      error: null,
    });
    void runTurn();
  },

  /** Ends the conversation and runs the debrief; also the way out of a turn that keeps failing. */
  end() {
    watch();
    const interview = get().interview;
    if (!interview || interview.closed || candidateTexts(interview).length === 0) return;
    if (interview.status !== "ready" && interview.status !== "error") return;
    patchInterview({ status: "debriefing", error: null });
    void runDebrief();
  },

  retry() {
    watch();
    const s = get();
    const interview = s.interview;
    if (!interview || interview.closed || interview.status !== "error") return;
    if (interview.messages.length === 0) {
      // The fact sheet never got built: the orchestrator reruns the stages that stopped.
      for (const id of PREPARATION_STAGES) {
        const status = s.stages[id].status;
        if (status === "error" || status === "interrupted") actions.retry(id);
      }
      patchInterview({ status: "preparing", error: null });
      syncPreparation();
      return;
    }
    // A candidate message left without answer is the turn that failed, unless the debrief started after it failed too.
    const turnFailed = interview.messages.at(-1)?.role === "candidate" && !debriefFailed(interview);
    if (turnFailed) {
      patchInterview({ status: "waiting", error: null });
      void runTurn();
    } else {
      patchInterview({ status: "debriefing", error: null });
      void runDebrief();
    }
  },

  /** Leaves the interview for the regular workspace, its analysis built on what the client actually said. */
  showFullAnalysis() {
    const s = get();
    const interview = s.interview;
    if (!interview || interview.closed) return;
    abortInFlight();
    const told = Object.fromEntries(
      (buildFactSheet(s)?.clientAnswers ?? []).filter((a) => interview.revealed.includes(a.id)).map((a) => [a.id, a.answer]),
    );
    const cutShort = interview.status === "waiting" || interview.status === "debriefing";
    useSession.setState((now) =>
      passGate({
        ...now,
        answers: { ...now.answers, ...told },
        interview: now.interview && {
          ...now.interview,
          closed: true,
          ...(cutShort ? { status: "error" as const, error: "Entretien quitté avant la fin." } : {}),
        },
      }),
    );
    pump();
  },

  /** Called by the interview view on mount: picks the interview up where the page left it. */
  resume() {
    watch();
    recover();
  },
};
