import type { DoneMeta, EngineErrorCode } from "@/lib/schemas/api";
import type { InterviewMessage, InterviewObservation, InterviewTurnResult } from "@/lib/interview/schema";
import type { InterviewScore } from "@/lib/interview/score";
import type { AnswerKind } from "./metrics";
import type { ChallengeRun } from "./run-case";

/**
 * The interview eval: a simulated candidate talks to the real interviewer, then the real debrief and score run.
 * Each persona follows one of the two labelled answers of a sample case (src/lib/samples.ts flawedAnswer,
 * evals/challenge-labels.json control.answer), so the debrief can be scored against the same labels.
 */
export type CandidatePersona = AnswerKind;

export type EngineFailure = { code: EngineErrorCode; message: string };

/** One message of the simulated candidate. */
export type CandidateTurn = {
  message: string;
  /** The code cut the final message to MAX_CANDIDATE_CHARS. */
  truncated: boolean;
  /** Length of the model's first message, before any shortening; 0 on error. */
  originalChars: number;
  /** The candidate was asked once to shorten an over-cap message. */
  retried: boolean;
  /** With costUsd, adds up both calls when the message was retried. */
  ms: number;
  model: string | null;
  costUsd: number | null;
  error: EngineFailure | null;
};

/** One reply of the interviewer, as /api/interview would have streamed it. */
export type InterviewerTurn = {
  ok: boolean;
  ms: number;
  data: InterviewTurnResult | null;
  meta: DoneMeta | null;
  error: EngineFailure | null;
};

export type InterviewTurnRecord = { round: number; candidate: CandidateTurn; interviewer: InterviewerTurn | null };

export type InterviewRun = {
  caseId: string;
  persona: CandidatePersona;
  /** 1-based index among the interviews of this case and persona. */
  sample: number;
  /** Whether the interviewer ran in tool mode (CONSULTANT_DOTS_INTERVIEW_TOOLS). */
  tools: boolean;
  turns: InterviewTurnRecord[];
  /** The whole conversation, opening included, as the app stores it. */
  messages: InterviewMessage[];
  revealed: string[];
  observations: InterviewObservation[];
  /** client: the interviewer closed; max_rounds: the code closed at the last round; error: a call failed. */
  endedBy: "client" | "max_rounds" | "error";
  debrief: ChallengeRun | null;
  score: InterviewScore | null;
  /** Ids of the case's clarification questions, the denominator of the coverage. */
  questionIds: string[];
  wallMs: number;
};

/**
 * What a leak would look like: the recommended option and the pilot of a full pipeline run of the same case, and
 * the words of their names that appear neither in the case nor in the fact sheet (the client may say those).
 */
export type SolutionTerms = { option: string; pilot: string; terms: string[] };
