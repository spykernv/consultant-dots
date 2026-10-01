import type { ReflexId } from "@/lib/schemas/common";

export const PLAYBOOK_IDS = [
  "universal",
  "data_platform",
  "genai",
  "si_cloud",
  "caio",
  "enterprise_architecture",
  "agile",
  "ma_it",
  "cloud_industrialization",
  "gpec",
  "data_management_ai",
] as const;
export type PlaybookId = (typeof PLAYBOOK_IDS)[number];

export type Playbook = {
  id: PlaybookId;
  label: string;
  sequence: string[];
  coreQuestions: string[];
  analysisStructure: string;
  solutionDimensions: string[];
  optionTypology: string[];
  principles: string[];
  resolution?: string[];
  pilotPattern: string;
  examples?: string[];
  kpis: string[];
  relevantReflexes: ReflexId[];
};
