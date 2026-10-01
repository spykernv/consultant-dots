import { z } from "zod";
import { CaseOrAssumptionSchema, listOf } from "./common";

export const CONSTRAINT_TYPES = [
  "regulatory",
  "data_sensitivity",
  "legacy",
  "availability",
  "budget",
  "timeline",
  "skills",
  "organizational",
  "dependencies",
  "contractual",
  "geographic",
  "other",
] as const;
export const ConstraintTypeSchema = z.enum(CONSTRAINT_TYPES);
export type ConstraintType = z.infer<typeof ConstraintTypeSchema>;

export const FactSchema = z.object({
  id: z.string().describe("F1, F2, …"),
  text: z.string().describe("The fact, rephrased in one short line"),
  evidence: z
    .string()
    .describe("Verbatim excerpt of the case (max 12 words) that states this fact, copied exactly"),
});

export const AssumptionSchema = z.object({
  id: z.string().describe("A1, A2, …"),
  text: z.string().describe("What we believe is likely but the case does not state"),
  basis: z.string().describe("Why we believe it, in a few words"),
});

export const ProblemMappingSchema = z.object({
  reformulation: z.string().describe("The client's problem in one sentence, in business terms"),
  businessObjectives: listOf(
    z.object({ text: z.string(), source: CaseOrAssumptionSchema }),
    "2-4 business objectives (cost, speed, productivity, quality, risk, customer experience, new capability…). Never a technology. source=case if stated or directly implied, else assumption",
  ),
  painPoints: listOf(z.string(), "2-5 explicit problems from the case, rephrased briefly"),
  constraints: listOf(
    z.object({ text: z.string(), type: ConstraintTypeSchema, source: CaseOrAssumptionSchema }),
    "1-5 constraints (regulation, sensitive data, legacy, availability, budget, timeline, skills, organization, dependencies, contracts, geography)",
  ),
  stakeholders: listOf(
    z.object({
      name: z.string().describe("Actor, e.g. 'DSI groupe', 'Filiales', 'DPO'"),
      role: z.string().describe("Their stake: decides, owns data, uses, is impacted, contributes…"),
      source: CaseOrAssumptionSchema,
    }),
    "2-6 stakeholders present or clearly implied by the case. Do not invent unnecessary actors",
  ),
  facts: listOf(FactSchema, "3-8 facts explicitly stated in the case"),
  assumptions: listOf(
    AssumptionSchema,
    "2-5 assumptions: plausible but not stated. Never repeat a fact",
  ),
  premiseChallenge: z
    .string()
    .nullable()
    .describe(
      "If the case frames a technology or a solution as the goal, one sentence reframing it (e.g. the cloud migration is a means, not the objective); otherwise null",
    ),
});

export type ProblemMapping = z.infer<typeof ProblemMappingSchema>;
