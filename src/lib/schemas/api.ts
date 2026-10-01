import { z } from "zod";
import { ClassificationSchema } from "./classify";
import { ProblemMappingSchema } from "./frame";
import { QuestionSetSchema } from "./questions";
import { DiagnosticSchema } from "./diagnose";
import { CurrentStateSchema } from "./diagram";
import { OptionsAnalysisSchema } from "./options";
import { TargetStateSchema } from "./target";
import { RoadmapSchema } from "./roadmap";
import type { StageId } from "./index";

export const MAX_CASE_CHARS = 12000;
export const MAX_NOTES_CHARS = 4000;
export const MIN_CHALLENGE_CHARS = 40;
export const MAX_CHALLENGE_CHARS = 6000;
export const MAX_STEER_CHARS = 500;

export const ClarificationSchema = z.object({
  questionId: z.string(),
  answer: z.string().max(2000),
  status: z.enum(["open", "answered", "assumed"]),
});
export type Clarification = z.infer<typeof ClarificationSchema>;

const BaseInputsSchema = z.object({
  caseText: z.string().trim().min(20).max(MAX_CASE_CHARS),
});
const ClassifiedInputsSchema = BaseInputsSchema.extend({ classification: ClassificationSchema });

export const BriefInputsSchema = ClassifiedInputsSchema.extend({
  mapping: ProblemMappingSchema,
  questions: QuestionSetSchema,
  clarifications: z.array(ClarificationSchema),
  clientNotes: z.string().max(MAX_NOTES_CHARS),
});
export type BriefInputs = z.infer<typeof BriefInputsSchema>;

/** Set when the user picked another pilot than the one suggested at the options step. */
export const PilotOverrideSchema = z.object({ chosen: z.string(), suggested: z.string().nullable() }).nullable();
export type PilotOverride = z.infer<typeof PilotOverrideSchema>;

/** What the user decided in the matrix, that a new Options version keeps: their pilot and the initiatives they added. */
export const MatrixChoicesSchema = z.object({ pilot: PilotOverrideSchema, added: z.array(z.string()) }).nullable();
export type MatrixChoices = z.infer<typeof MatrixChoicesSchema>;

export const STAGE_INPUT_SCHEMAS = {
  classify: BaseInputsSchema,
  frame: ClassifiedInputsSchema,
  questions: ClassifiedInputsSchema,
  diagnose: BriefInputsSchema,
  currentState: BriefInputsSchema,
  options: BriefInputsSchema.extend({ diagnostic: DiagnosticSchema, currentState: CurrentStateSchema }),
  target: BriefInputsSchema.extend({
    diagnostic: DiagnosticSchema,
    currentState: CurrentStateSchema,
    options: OptionsAnalysisSchema,
    pilotOverride: PilotOverrideSchema,
  }),
  roadmap: BriefInputsSchema.extend({
    diagnostic: DiagnosticSchema,
    options: OptionsAnalysisSchema,
    pilotOverride: PilotOverrideSchema,
  }),
  oral: BriefInputsSchema.extend({
    diagnostic: DiagnosticSchema,
    options: OptionsAnalysisSchema,
    target: TargetStateSchema,
    roadmap: RoadmapSchema,
    pilotOverride: PilotOverrideSchema,
  }),
  challenge: BaseInputsSchema.extend({
    answer: z.string().trim().min(MIN_CHALLENGE_CHARS).max(MAX_CHALLENGE_CHARS),
    classification: ClassificationSchema.nullable(),
    mapping: ProblemMappingSchema.nullable(),
    diagnostic: DiagnosticSchema.nullable(),
    options: OptionsAnalysisSchema.nullable(),
    roadmap: RoadmapSchema.nullable(),
    // What the client answered; optional so that requests from a tab opened before these fields still parse.
    questions: QuestionSetSchema.nullable().optional(),
    clarifications: z.array(ClarificationSchema).optional(),
    clientNotes: z.string().max(MAX_NOTES_CHARS).optional(),
  }),
} satisfies Record<StageId, z.ZodType>;

export type StageInputs = { [K in StageId]: z.infer<(typeof STAGE_INPUT_SCHEMAS)[K]> };

export const StageRequestSchema = z.object({
  runId: z.string().min(1).max(100),
  mock: z.boolean(),
  caseId: z
    .string()
    .regex(/^[a-z0-9-]{1,40}$/)
    .nullable(),
  inputs: z.unknown(),
  /** Regeneration only: the user's instruction and the output being replaced. */
  steer: z.string().trim().max(MAX_STEER_CHARS).nullable().default(null),
  previous: z.unknown().nullable().default(null),
  /** Options regeneration only; null when the user made no choice of their own in the matrix. */
  choices: MatrixChoicesSchema.default(null),
});
export type StageRequest = z.infer<typeof StageRequestSchema>;

export type EngineErrorCode =
  | "claude_not_found"
  | "not_logged_in"
  | "usage_limit"
  | "overloaded"
  | "timeout"
  | "invalid_output"
  | "aborted"
  | "engine_error"
  | "bad_request";

export type DoneMeta = {
  ms: number;
  model: string | null;
  costUsd: number | null;
  notes: string[];
};

export type StageEvent =
  | { type: "status"; phase: "starting" | "thinking" | "writing" }
  | { type: "delta"; text: string }
  | { type: "done"; data: unknown; meta: DoneMeta }
  | { type: "error"; code: EngineErrorCode; message: string };
