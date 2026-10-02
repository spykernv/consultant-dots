import { z } from "zod";
import type { StageOutputs } from "@/lib/schemas";
import { SEVERITIES } from "@/lib/schemas/challenge";
import { ReflexIdSchema } from "@/lib/schemas/common";

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

/**
 * Tool mode (the default): the client looks its answers up with tools, and the code derives "reveal" from the
 * get_client_answer calls that succeeded. The model only returns what it says, its move and whether it closes.
 */
export const InterviewReplySchema = InterviewTurnOutputSchema.omit({ reveal: true });
export type InterviewReply = z.infer<typeof InterviewReplySchema>;

export const INTERVIEW_TOOL_NAMES = ["get_client_answer", "lookup_fact", "check_quote", "record_observation"] as const;
export type InterviewToolName = (typeof INTERVIEW_TOOL_NAMES)[number];

/** A weakness the client noted during the interview, its quote checked against the candidate's own messages. */
export const InterviewObservationSchema = z.object({
  reflex: ReflexIdSchema,
  severity: z.enum(SEVERITIES),
  /** The candidate's words, found verbatim (as caseContains matches) in one of their messages. */
  quote: z.string(),
  /** What the client noticed, in French, one sentence. */
  note: z.string(),
  /** The round whose turn recorded it. */
  round: z.number().int().min(1),
});
export type InterviewObservation = z.infer<typeof InterviewObservationSchema>;

/** One tool call of a turn, as the transcript and the eval show it. */
export const ToolTraceSchema = z.object({
  name: z.enum(INTERVIEW_TOOL_NAMES),
  /** What the call targeted, short: a Q or F id, a reflex id, or the first words of a quote. */
  target: z.string(),
  /** The call gave what it asked for: false when refused, and for a quote check that did not find the words. */
  ok: z.boolean(),
});
export type ToolTrace = z.infer<typeof ToolTraceSchema>;

/** What /api/interview sends back in its done event. The defaults keep the structured mode's turns parseable. */
export const InterviewTurnResultSchema = InterviewTurnOutputSchema.extend({
  observations: z.array(InterviewObservationSchema).default([]),
  toolCalls: z.array(ToolTraceSchema).default([]),
});
export type InterviewTurnResult = z.infer<typeof InterviewTurnResultSchema>;

export const InterviewMessageSchema = z.object({
  role: z.enum(["candidate", "interviewer"]),
  text: z.string().trim().min(1).max(MAX_CANDIDATE_CHARS * 2),
});
export type InterviewMessage = z.infer<typeof InterviewMessageSchema> & {
  /** Interviewer messages only: the client answers this reply gave, and the move the model chose. */
  reveal?: string[];
  action?: InterviewAction;
  /** Interviewer messages only, tool mode: the calls behind this reply. */
  tools?: ToolTrace[];
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
  /** Reflexes the client already noted in earlier turns: one observation per reflex and per interview. */
  notedReflexes: z.array(ReflexIdSchema).max(10).optional(),
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
  /** Tool mode: what the client noted during the interview. Absent from interviews saved before it. */
  observations?: InterviewObservation[];
  /** Guardrail notes from the server (unknown ids dropped, unsourced numbers…), shown discreetly. */
  notes: string[];
  error: string | null;
  /** true once the user leaves the interview for the full analysis (the regular workspace). */
  closed: boolean;
};
