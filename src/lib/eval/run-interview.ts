import { randomUUID } from "node:crypto";
import type { StageOutputs } from "@/lib/schemas";
import type { StageEvent, StageRequest } from "@/lib/schemas/api";
import { engineEnv } from "@/lib/engine/config";
import { runStage } from "@/lib/pipeline/run-stage";
import { buildFactSheet, debriefInputs, INTERVIEW_OPENING, mergeObservations } from "@/lib/interview/debrief";
import { runInterviewTurn } from "@/lib/interview/run-turn";
import {
  INTERVIEW_MAX_ROUNDS,
  InterviewTurnResultSchema,
  MAX_CANDIDATE_CHARS,
  type InterviewMessage,
  type InterviewObservation,
  type InterviewRequest,
  type InterviewState,
} from "@/lib/interview/schema";
import { interviewScore } from "@/lib/interview/score";
import type { Session } from "@/lib/store/machine";
import { runCandidateTurn } from "./candidate";
import type { CandidatePersona, InterviewerTurn, InterviewRun, InterviewTurnRecord } from "./interview-types";
import type { ChallengeRun } from "./run-case";

/**
 * One interview of the eval, run without the browser the way the interview page runs it: the simulated candidate
 * writes, /api/interview's code answers (the same turn, without the HTTP), then the debrief and the score the page
 * shows. Engine failures are recorded in the run, never thrown: one failed call must not end an eval of many runs.
 */

export type InterviewInput = {
  caseId: string;
  /** From a pipeline run: the frame and questions stages done, so that the client has its fact sheet. */
  session: Session;
  persona: CandidatePersona;
  /** The labelled answer the persona follows. */
  plan: string;
  sample: number;
};

/** Same options as the pipeline runs of the eval: the case id only picks the recorded runs of a mock interview. */
export type InterviewOptions = { mock: boolean; caseId: string | null; signal?: AbortSignal };

/** One interviewer turn, read down to its final event as the page reads the stream. */
async function interviewerTurn(request: InterviewRequest, signal: AbortSignal): Promise<InterviewerTurn> {
  let last: StageEvent | null = null;
  const started = Date.now();
  await runInterviewTurn(request, (event) => {
    if (event.type === "done" || event.type === "error") last = event;
  }, signal);
  const ms = Date.now() - started;
  const event = last as StageEvent | null;
  if (event?.type === "error") return { ok: false, ms, data: null, meta: null, error: { code: event.code, message: event.message } };
  if (event?.type !== "done") return { ok: false, ms, data: null, meta: null, error: { code: "engine_error", message: "Aucun résultat." } };
  // The page's reading: a done event it cannot parse, or an empty reply, is a failed turn.
  const parsed = InterviewTurnResultSchema.safeParse(event.data);
  if (!parsed.success || !parsed.data.reply.trim()) {
    return { ok: false, ms, data: null, meta: event.meta, error: { code: "invalid_output", message: "La réponse du client est illisible." } };
  }
  return { ok: true, ms, data: parsed.data, meta: event.meta, error: null };
}

/** The debrief as the page runs it once the interview ends: the challenge stage on the candidate's messages. */
async function runDebrief(session: Session, interview: InterviewState, options: InterviewOptions, signal: AbortSignal): Promise<ChallengeRun> {
  const request: StageRequest = {
    runId: randomUUID(),
    mock: options.mock,
    // As on the page: live, the case id would only serve to record this debrief over the sample's challenge fixture.
    caseId: options.mock ? options.caseId : null,
    inputs: debriefInputs(session, interview),
    steer: null,
    previous: null,
    choices: null,
  };
  let last: StageEvent | null = null;
  const started = Date.now();
  await runStage("challenge", request, (event) => {
    if (event.type === "done" || event.type === "error") last = event;
  }, signal);
  const ms = Date.now() - started;
  const event = last as StageEvent | null;
  if (event?.type === "done") {
    return { stage: "challenge", ok: true, ms, meta: event.meta, error: null, data: event.data as StageOutputs["challenge"] };
  }
  const error = event?.type === "error" ? { code: event.code, message: event.message } : { code: "engine_error" as const, message: "Aucun résultat." };
  return { stage: "challenge", ok: false, ms, meta: null, error, data: null };
}

/**
 * Plays one interview: up to INTERVIEW_MAX_ROUNDS candidate messages, each answered by the interviewer, the state kept
 * as the page keeps it (revealed answers, one observation per reflex), then the debrief and the score. Throws only
 * when the session cannot host an interview.
 */
export async function runInterview(input: InterviewInput, options: InterviewOptions): Promise<InterviewRun> {
  const { session, persona, plan } = input;
  const factSheet = buildFactSheet(session);
  if (!factSheet) {
    throw new Error(`The session of ${input.caseId} cannot host an interview: its frame and questions stages must be done.`);
  }
  const signal = options.signal ?? new AbortController().signal;
  const tools = engineEnv().interviewTools;
  const maxRounds = INTERVIEW_MAX_ROUNDS;
  const started = Date.now();
  // Only the fact sheet's answers count as revealed, so the score and the debrief never credit an invented id.
  const known = new Set(factSheet.clientAnswers.map((a) => a.id));

  const messages: InterviewMessage[] = [{ role: "interviewer", text: INTERVIEW_OPENING }];
  const turns: InterviewTurnRecord[] = [];
  let revealed: string[] = [];
  let observations: InterviewObservation[] = [];
  const notes: string[] = [];
  let endedBy: InterviewRun["endedBy"] = "max_rounds";

  for (let round = 1; round <= maxRounds; round++) {
    const candidate = await runCandidateTurn(
      { caseText: session.caseText, persona, plan, transcript: messages, round, maxRounds },
      { mock: options.mock, caseId: options.caseId, signal },
    );
    if (candidate.error) {
      turns.push({ round, candidate, interviewer: null });
      endedBy = "error";
      break;
    }
    // Sent before the turn runs, as on the page: a failed turn leaves the candidate's message in the transcript.
    messages.push({ role: "candidate", text: candidate.message });

    const interviewer = await interviewerTurn(
      {
        runId: randomUUID(),
        mock: options.mock,
        caseId: options.caseId,
        inputs: {
          caseText: session.caseText,
          factSheet,
          transcript: messages
            .map(({ role, text }) => ({ role, text: text.slice(0, MAX_CANDIDATE_CHARS * 2) }))
            .filter((m) => m.text.trim()),
          round,
          maxRounds,
          revealed,
          // Tool mode: the server refuses a second note on these, so the debrief lists each weakness once.
          notedReflexes: [...new Set(observations.map((o) => o.reflex))],
        },
      },
      signal,
    );
    turns.push({ round, candidate, interviewer });
    if (!interviewer.data) {
      endedBy = "error";
      break;
    }

    const turn = interviewer.data;
    const reveal = [...new Set(turn.reveal.filter((id) => known.has(id)))];
    messages.push({
      role: "interviewer",
      text: turn.reply.trim(),
      reveal,
      action: turn.action,
      ...(turn.toolCalls.length > 0 ? { tools: turn.toolCalls } : {}),
    });
    revealed = [...revealed, ...reveal.filter((id) => !revealed.includes(id))];
    observations = mergeObservations(observations, turn.observations);
    notes.push(...(interviewer.meta?.notes ?? []));
    // The code ends the interview, the model only asks: at the last round it closes whatever the model said, so a
    // close there is never the client's own decision.
    if (turn.done || round >= maxRounds) {
      endedBy = round >= maxRounds || (interviewer.meta?.checks?.closeForced ?? 0) > 0 ? "max_rounds" : "client";
      break;
    }
  }

  const interview: InterviewState = {
    status: "done",
    maxRounds,
    messages,
    revealed,
    debrief: null,
    observations,
    notes,
    error: null,
    closed: false,
  };
  // As on the page, where « Terminer » debriefs even after a failed turn, as long as the candidate said something.
  const debrief = messages.some((m) => m.role === "candidate") ? await runDebrief(session, interview, options, signal) : null;
  const score = interviewScore({ ...session, interview: { ...interview, debrief: debrief?.data ?? null } });

  return {
    caseId: input.caseId,
    persona,
    sample: input.sample,
    tools,
    turns,
    messages,
    revealed,
    observations,
    endedBy,
    debrief,
    score,
    questionIds: (session.stages.questions.data?.questions ?? []).map((q) => q.id),
    wallMs: Date.now() - started,
  };
}
