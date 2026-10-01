import { z } from "zod";
import { listOf } from "./common";

export const RoadmapPhaseSchema = z.object({
  name: z.string().describe("e.g. 'Phase 1 — Cadrage & diagnostic'"),
  timing: z.string().describe("e.g. '0–1 mois'"),
  objective: z.string().describe("One line"),
  actions: listOf(z.string(), "2-4 actions"),
  deliverables: listOf(z.string(), "2-3 deliverables"),
  decisions: listOf(z.string(), "1-3 decisions to take"),
  dependencies: listOf(z.string(), "1-3 dependencies"),
  kpis: listOf(z.string(), "1-3 KPIs for this phase"),
});
export type RoadmapPhase = z.infer<typeof RoadmapPhaseSchema>;

export const KPI_TYPES = ["business", "adoption", "technical", "risk"] as const;

export const RoadmapSchema = z.object({
  phases: listOf(
    RoadmapPhaseSchema,
    "3-4 phases with realistic timing that sequence the target building blocks",
  ),
  pilot: z.object({
    initiative: z.string().describe("Name of the pilot initiative chosen at the options step"),
    scope: z.string().describe("One complete vertical slice, e.g. '2 filiales → 1 dataset → 1 définition → 1 pipeline → 1 dashboard'"),
    why: z.string().describe("Representative, manageable dependencies, learning, reusable foundations"),
    successCriteria: listOf(z.string(), "2-3 measurable success criteria"),
    reusableFoundations: listOf(z.string(), "2-3 foundations the pilot leaves behind"),
  }),
  kpis: listOf(
    z.object({
      name: z.string(),
      type: z.enum(KPI_TYPES),
      baseline: z.string().describe("From the case when available, else 'à mesurer au cadrage'"),
      target: z.string(),
    }),
    "4-6 KPIs mixing business, adoption, technical and risk",
  ),
  risks: listOf(
    z.object({
      risk: z.string().describe("One line"),
      impact: z.string().describe("One line"),
      mitigation: z.string().describe("One line"),
    }),
    "The 3-5 risks most specific to this case, no generic filler",
  ),
});

export type Roadmap = z.infer<typeof RoadmapSchema>;
