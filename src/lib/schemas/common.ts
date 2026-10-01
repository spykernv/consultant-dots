import { z } from "zod";

export const SourceSchema = z.enum(["case", "client", "assumption"]);
export type Source = z.infer<typeof SourceSchema>;

export const CaseOrAssumptionSchema = z.enum(["case", "assumption"]);

export const BACKBONE_STAGES = ["cadrage", "diagnostic", "options", "cible", "pilote", "scale"] as const;
export const BackboneStageSchema = z.enum(BACKBONE_STAGES);
export type BackboneStage = z.infer<typeof BackboneStageSchema>;

export const DOMAIN_IDS = [
  "data_platform",
  "data_management",
  "genai_ai",
  "caio_advisory",
  "si_transformation",
  "cloud_transformation",
  "cloud_industrialization",
  "enterprise_architecture",
  "agile_pm",
  "ma_it",
  "gpec_skills",
  "data_ai_strategy",
  "other",
] as const;
export const DomainSchema = z.enum(DOMAIN_IDS);
export type Domain = z.infer<typeof DomainSchema>;

export const REFLEX_IDS = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"] as const;
export const ReflexIdSchema = z.enum(REFLEX_IDS);
export type ReflexId = z.infer<typeof ReflexIdSchema>;

export const ScoreSchema = z.literal([1, 2, 3, 4, 5]);
export type Score = z.infer<typeof ScoreSchema>;

export const listOf = <T extends z.ZodType>(item: T, description: string) =>
  z.array(item).describe(description);
