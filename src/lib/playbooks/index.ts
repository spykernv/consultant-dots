import type { Domain } from "@/lib/schemas/common";
import type { Classification } from "@/lib/schemas/classify";
import type { Playbook, PlaybookId } from "./types";
import { universal } from "./universal";
import { dataPlatform } from "./data-platform";
import { genai } from "./genai";
import { siCloud } from "./si-cloud";
import { caio } from "./caio";
import { enterpriseArchitecture } from "./enterprise-architecture";
import { agile } from "./agile";
import { maIt } from "./ma-it";
import { cloudIndustrialization } from "./cloud-industrialization";
import { gpec } from "./gpec";
import { dataManagementAi } from "./data-management-ai";

export type { Playbook, PlaybookId } from "./types";

export const PLAYBOOKS: Record<PlaybookId, Playbook> = {
  universal,
  data_platform: dataPlatform,
  genai,
  si_cloud: siCloud,
  caio,
  enterprise_architecture: enterpriseArchitecture,
  agile,
  ma_it: maIt,
  cloud_industrialization: cloudIndustrialization,
  gpec,
  data_management_ai: dataManagementAi,
};

export const DOMAIN_TO_PLAYBOOK: Record<Domain, PlaybookId> = {
  data_platform: "data_platform",
  data_management: "data_management_ai",
  genai_ai: "genai",
  caio_advisory: "caio",
  si_transformation: "si_cloud",
  cloud_transformation: "si_cloud",
  cloud_industrialization: "cloud_industrialization",
  enterprise_architecture: "enterprise_architecture",
  agile_pm: "agile",
  ma_it: "ma_it",
  gpec_skills: "gpec",
  data_ai_strategy: "data_management_ai",
  other: "universal",
};

export function selectPlaybooks(classification: Pick<Classification, "primaryDomain" | "secondaryDomains">) {
  const primary = PLAYBOOKS[DOMAIN_TO_PLAYBOOK[classification.primaryDomain]];
  const secondary: Playbook[] = [];
  for (const domain of classification.secondaryDomains) {
    const playbook = PLAYBOOKS[DOMAIN_TO_PLAYBOOK[domain]];
    if (playbook.id === primary.id || playbook.id === "universal") continue;
    if (secondary.some((p) => p.id === playbook.id)) continue;
    secondary.push(playbook);
    if (secondary.length === 2) break;
  }
  return { primary, secondary };
}

const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

export function renderPlaybook(playbook: Playbook, mode: "full" | "condensed"): string {
  if (mode === "condensed") {
    return [
      `## Secondary playbook: ${playbook.label}`,
      `Principles:\n${bullets(playbook.principles)}`,
      `Solution dimensions: ${playbook.solutionDimensions.join(", ")}`,
    ].join("\n");
  }
  return [
    `## Primary playbook: ${playbook.label}`,
    `Sequence: ${playbook.sequence.join(" → ")}`,
    `Core questions:\n${bullets(playbook.coreQuestions)}`,
    `Analysis grid: ${playbook.analysisStructure}`,
    `Solution dimensions: ${playbook.solutionDimensions.join(", ")}`,
    `Option typology:\n${bullets(playbook.optionTypology)}`,
    `Principles:\n${bullets(playbook.principles)}`,
    playbook.resolution ? `Typical resolution:\n${bullets(playbook.resolution)}` : "",
    `Pilot pattern: ${playbook.pilotPattern}`,
    playbook.examples ? `Examples:\n${bullets(playbook.examples)}` : "",
    `Typical KPIs: ${playbook.kpis.join("; ")}`,
    `Reflexes to watch: ${playbook.relevantReflexes.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderPlaybooksFor(classification: Pick<Classification, "primaryDomain" | "secondaryDomains">) {
  const { primary, secondary } = selectPlaybooks(classification);
  return [renderPlaybook(primary, "full"), ...secondary.map((p) => renderPlaybook(p, "condensed"))].join("\n\n");
}
