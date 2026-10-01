import { z } from "zod";
import { ClassificationSchema } from "./classify";
import { ProblemMappingSchema } from "./frame";
import { QuestionSetSchema } from "./questions";
import { DiagnosticSchema } from "./diagnose";
import { CurrentStateSchema } from "./diagram";
import { OptionsAnalysisSchema } from "./options";
import { TargetStateSchema } from "./target";
import { RoadmapSchema } from "./roadmap";
import { OralRestitutionSchema } from "./oral";
import { ChallengeSchema } from "./challenge";

/** Stages the orchestrator chains automatically. */
export const PIPELINE_STAGE_IDS = [
  "classify",
  "frame",
  "questions",
  "diagnose",
  "currentState",
  "options",
  "target",
  "roadmap",
  "oral",
] as const;
export type PipelineStageId = (typeof PIPELINE_STAGE_IDS)[number];

/** Pipeline stages plus the ones only the user triggers. */
export const STAGE_IDS = [...PIPELINE_STAGE_IDS, "challenge"] as const;
export type StageId = (typeof STAGE_IDS)[number];

export const PRE_GATE_STAGES = ["classify", "frame", "questions"] as const satisfies readonly StageId[];
export const POST_GATE_STAGES = [
  "diagnose",
  "currentState",
  "options",
  "target",
  "roadmap",
  "oral",
] as const satisfies readonly StageId[];

export const STAGE_SCHEMAS = {
  classify: ClassificationSchema,
  frame: ProblemMappingSchema,
  questions: QuestionSetSchema,
  diagnose: DiagnosticSchema,
  currentState: CurrentStateSchema,
  options: OptionsAnalysisSchema,
  target: TargetStateSchema,
  roadmap: RoadmapSchema,
  oral: OralRestitutionSchema,
  challenge: ChallengeSchema,
} satisfies Record<StageId, z.ZodType>;

export type StageOutputs = { [K in StageId]: z.infer<(typeof STAGE_SCHEMAS)[K]> };

export function isStageId(value: string): value is StageId {
  return (STAGE_IDS as readonly string[]).includes(value);
}

export * from "./common";
export * from "./classify";
export * from "./frame";
export * from "./questions";
export * from "./diagnose";
export * from "./diagram";
export * from "./options";
export * from "./target";
export * from "./roadmap";
export * from "./oral";
export * from "./challenge";
