import type { Playbook } from "./types";

export const enterpriseArchitecture: Playbook = {
  id: "enterprise_architecture",
  label: "Enterprise Architecture",
  sequence: ["Current state", "Principles", "Target state", "Transition roadmap"],
  coreQuestions: [
    "Which business capabilities matter most for the strategy?",
    "Which applications support each capability, and where are the duplicates?",
    "How do data and integrations flow today (point-to-point, middleware)?",
    "Who owns each application and each data domain?",
    "What does the IT landscape cost, and where?",
  ],
  analysisStructure:
    "Business capabilities → processes → applications → data → integrations → infrastructure",
  solutionDimensions: [
    "capability map",
    "application landscape",
    "dependency map",
    "target architecture",
    "architecture principles",
    "transition roadmap",
  ],
  optionTypology: [
    "Rationalize (consolidate duplicate applications)",
    "Progressive modernization (replace piece by piece)",
    "Replace with a platform or ERP",
  ],
  principles: [
    "Goal: align business strategy and the technology landscape.",
    "Typical problems: duplicate applications, redundant capabilities, fragmented data, point-to-point integrations, legacy systems, unclear ownership, high IT costs.",
    "Go current state → principles → target state → transition roadmap.",
  ],
  pilotPattern: "One business capability → its applications and flows rationalized end to end → cost and complexity measured",
  kpis: [
    "number of applications per capability",
    "IT run cost",
    "number of point-to-point interfaces",
    "time to deliver a change",
  ],
  relevantReflexes: ["E1", "E3", "E4"],
};
