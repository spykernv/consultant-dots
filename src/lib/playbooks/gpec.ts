import type { Playbook } from "./types";

export const gpec: Playbook = {
  id: "gpec",
  label: "GPEC / Skills Transformation",
  sequence: [
    "Future capabilities",
    "Required roles",
    "Required skills",
    "Current workforce",
    "Skill gap",
    "Build / Buy / Borrow / Move / Automate",
    "Workforce roadmap",
  ],
  coreQuestions: [
    "Which capabilities will the strategy require in 2-3 years?",
    "Which roles and skills do those capabilities need?",
    "What are the current roles and skills of the workforce?",
    "Where is the skill gap most critical?",
    "What is the appetite for training, recruiting or external support?",
  ],
  analysisStructure:
    "Future capabilities → required roles → required skills vs current workforce → current roles → current skills = SKILL GAP",
  solutionDimensions: ["skill gap", "training", "recruiting", "external expertise", "internal mobility", "automation"],
  optionTypology: [
    "Build: train employees",
    "Buy: recruit",
    "Borrow: external expertise / consultants",
    "Move: internal mobility",
    "Automate: technology / AI",
  ],
  principles: [
    "GPEC = Gestion Prévisionnelle des Emplois et des Compétences.",
    "Start from future strategic needs, not from the current org chart.",
  ],
  pilotPattern: "One critical job family → gap measured → mixed build/buy plan → coverage tracked",
  kpis: [
    "critical skill coverage",
    "training completion",
    "internal mobility",
    "recruiting lead time",
    "external dependency",
    "employee adoption",
  ],
  relevantReflexes: ["E4", "E5", "E6"],
};
