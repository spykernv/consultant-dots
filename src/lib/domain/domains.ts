import type { Domain } from "@/lib/schemas/common";

export const DOMAINS: Record<Domain, { label: string; description: string }> = {
  data_platform: {
    label: "Data Platform",
    description:
      "Data fragmented across entities or systems that must be brought together for shared reporting, analytics or cross-entity use cases (inconsistent KPIs, manual consolidation, hard-to-cross datasets). Its playbook already covers the governance, common definitions and ownership this requires, whatever the target: central, federated or hybrid",
  },
  data_management: {
    label: "Data Management",
    description:
      "Governance, ownership, quality, master data or catalog as the core problem in itself, when the need is not to bring data together across entities",
  },
  genai_ai: {
    label: "GenAI / IA",
    description: "Designing and deploying specific AI or GenAI use cases",
  },
  caio_advisory: {
    label: "Stratégie & gouvernance IA (CAIO)",
    description: "Executive-level AI strategy, governance and operating model (Chief AI Officer)",
  },
  si_transformation: {
    label: "Transformation SI",
    description: "Overhaul of the information system or application landscape (ERP, legacy modernization)",
  },
  cloud_transformation: {
    label: "Transformation Cloud",
    description: "Moving applications or infrastructure to the cloud",
  },
  cloud_industrialization: {
    label: "Industrialisation Cloud",
    description: "Making cloud delivery repeatable and secure: landing zone, IaC, CI/CD, FinOps, platform engineering",
  },
  enterprise_architecture: {
    label: "Architecture d'entreprise",
    description: "Aligning business capabilities and the IT landscape; rationalization; target architecture",
  },
  agile_pm: {
    label: "Agile / Gestion de projet",
    description: "Delivery organization, agile at scale, PMO, recovering a project in difficulty",
  },
  ma_it: {
    label: "M&A IT",
    description: "IT in acquisitions, mergers, carve-outs and divestitures (Day 1, TSA, integration or separation)",
  },
  gpec_skills: {
    label: "GPEC / Compétences",
    description: "Future skills and workforce planning for technology and AI",
  },
  data_ai_strategy: {
    label: "Stratégie Data & IA",
    description: "Enterprise data and AI ambition, use-case portfolio and roadmap",
  },
  other: {
    label: "Autre",
    description: "None of the above",
  },
};

export function domainLabel(domain: Domain | undefined | null): string {
  return domain ? (DOMAINS[domain]?.label ?? domain) : "";
}
