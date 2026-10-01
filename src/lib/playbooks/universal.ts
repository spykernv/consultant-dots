import type { Playbook } from "./types";

export const universal: Playbook = {
  id: "universal",
  label: "Universal backbone",
  sequence: [
    "Cadrage",
    "Diagnostic de l'existant",
    "Options / priorisation",
    "Cible + roadmap",
    "Pilote / déploiement",
    "Mesure / scale",
  ],
  coreQuestions: [
    "What business outcome is the client actually trying to achieve?",
    "What exists today (processes, systems, data, organization) and where does it break?",
    "Which constraints (regulation, budget, timeline, skills, dependencies) limit the options?",
    "Who decides, who owns, who uses?",
    "What would a realistic first step look like, and how would we measure it?",
  ],
  analysisStructure: "Objective → current state → pain points → constraints → stakeholders → options → target",
  solutionDimensions: ["business value", "organization and governance", "processes", "technology", "data", "skills", "adoption"],
  optionTypology: ["Incremental improvement", "Targeted transformation", "Broad transformation"],
  principles: [
    "Start from business value.",
    "Clarify before assuming; diagnose before designing; compare options before selecting.",
    "Do not over-engineer; keep recommendations proportional to the information available.",
    "Prefer a realistic pilot to a theoretical large transformation, and build reusable foundations.",
  ],
  pilotPattern: "One team or entity → one process → one measurable improvement → then scale",
  kpis: ["business outcome KPI", "adoption", "time to value", "cost"],
  relevantReflexes: ["E1", "E2", "E4", "E6"],
};
