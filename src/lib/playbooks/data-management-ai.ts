import type { Playbook } from "./types";

export const dataManagementAi: Playbook = {
  id: "data_management_ai",
  label: "Data Management & AI",
  sequence: [
    "Business use case",
    "Required data",
    "Data owner",
    "Quality",
    "Availability",
    "Governance",
    "Platform",
    "AI / analytics use",
  ],
  coreQuestions: [
    "Which business use cases need better data or AI?",
    "Which data do they require, and who owns it?",
    "Is the data available, documented and of sufficient quality?",
    "Which access, security or regulatory rules apply?",
    "How data-literate are the users?",
  ],
  analysisStructure:
    "Business use case → required data → data owner → quality → availability → governance → platform → AI / analytics use",
  solutionDimensions: [
    "ownership",
    "governance",
    "quality",
    "catalog",
    "lineage",
    "access",
    "security",
    "MDM",
    "architecture",
    "data literacy",
    "AI readiness",
  ],
  optionTypology: [
    "Use-case-led governance (domain by domain)",
    "Central data office with federated data owners",
    "Data mesh style (domains own data products)",
  ],
  principles: [
    "Start from business use cases, then assess AI/data readiness.",
    "Do not build governance for governance's sake: tie governance to use cases.",
  ],
  pilotPattern: "1 use case → its critical data → named owner → quality rules → measured quality and usage",
  kpis: [
    "quality score of critical data",
    "share of critical data with a named owner",
    "catalog coverage",
    "time to access data",
    "use cases enabled",
  ],
  relevantReflexes: ["E1", "E4", "E6", "E8"],
};
