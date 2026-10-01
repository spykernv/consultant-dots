import { z } from "zod";
import type { StageOutputs } from "@/lib/schemas";

/**
 * Client interview mode: the candidate faces a simulated client for a limited number of rounds. The analysis
 * stays a fixed graph; only this conversation is agentic, because its path depends on what the candidate says.
 */

/** Candidate messages allowed before the interview ends; the code ends it, never the model alone. */
export const INTERVIEW_MAX_ROUNDS = 8;
export const MAX_CANDIDATE_CHARS = 1200;

export const INTERVIEW_ACTIONS = ["clarify", "probe", "challenge", "redirect", "wrap_up"] as const;
export type InterviewAction = (typeof INTERVIEW_ACTIONS)[number];

/** What the model returns for one interviewer turn (also the shape of the strict JSON Schema it must fill). */
export const InterviewTurnOutputSchema = z.object({
  reply: z
    .string()
    .describe("What the client says now, in French, addressing the candidate as \"vous\": 1-4 short sentences, at most one question"),
  action: z
    .enum(INTERVIEW_ACTIONS)
    .describe(
      "clarify: answer the candidate's question from the client fact sheet; probe: ask for precision or numbers; challenge: push back on a weak move; redirect: bring the candidate back to the business problem; wrap_up: close the interview",
    ),
  reveal: z
    .array(z.string())
    .describe("Ids (Q1, Q2…) of the client answers given in this reply, empty when none"),
  done: z.boolean().describe("true only when the candidate has delivered a recommendation and the client closes the interview"),
});
export type InterviewTurnOutput = z.infer<typeof InterviewTurnOutputSchema>;

export const InterviewMessageSchema = z.object({
  role: z.enum(["candidate", "interviewer"]),
  text: z.string().trim().min(1).max(MAX_CANDIDATE_CHARS * 2),
});
export type InterviewMessage = z.infer<typeof InterviewMessageSchema> & {
  /** Interviewer messages only: the client answers this reply gave, and the move the model chose. */
  reveal?: string[];
  action?: InterviewAction;
};

/** What the simulated client knows. Built by the code from the frame and questions stages; never the recommendation. */
export const FactSheetSchema = z.object({
  facts: z.array(z.object({ id: z.string(), text: z.string() })).max(20),
  clientAnswers: z.array(z.object({ id: z.string(), question: z.string(), answer: z.string() })).max(8),
});
export type FactSheet = z.infer<typeof FactSheetSchema>;

export const InterviewTurnInputSchema = z.object({
  caseText: z.string().trim().min(20).max(12000),
  factSheet: FactSheetSchema,
  transcript: z.array(InterviewMessageSchema).min(1).max(INTERVIEW_MAX_ROUNDS * 2 + 2),
  /** Candidate messages so far, the last one included (1-based). */
  round: z.number().int().min(1).max(INTERVIEW_MAX_ROUNDS),
  maxRounds: z.number().int().min(1).max(INTERVIEW_MAX_ROUNDS),
  revealed: z.array(z.string()).max(8),
});
export type InterviewTurnInput = z.infer<typeof InterviewTurnInputSchema>;

export const InterviewRequestSchema = z.object({
  runId: z.string().min(1).max(100),
  mock: z.boolean(),
  caseId: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .nullable()
    .default(null),
  inputs: InterviewTurnInputSchema,
});
export type InterviewRequest = z.infer<typeof InterviewRequestSchema>;

export type InterviewStatus =
  /** The fact sheet is being built (classify, frame and questions run as usual). */
  | "preparing"
  /** Waiting for the candidate's next message. */
  | "ready"
  /** An interviewer turn is running. */
  | "waiting"
  /** The debrief (challenge stage on the candidate's messages) is running. */
  | "debriefing"
  | "done"
  | "error";

export type InterviewState = {
  status: InterviewStatus;
  maxRounds: number;
  messages: InterviewMessage[];
  /** Client answers (Q ids) given so far, in order. */
  revealed: string[];
  debrief: StageOutputs["challenge"] | null;
  /** Guardrail notes from the server (unknown ids dropped, unsourced numbers…), shown discreetly. */
  notes: string[];
  error: string | null;
  /** true once the user leaves the interview for the full analysis (the regular workspace). */
  closed: boolean;
};
