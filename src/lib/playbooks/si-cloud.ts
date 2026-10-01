import type { Playbook } from "./types";

export const siCloud: Playbook = {
  id: "si_cloud",
  label: "SI / Cloud Transformation",
  sequence: [
    "Application portfolio",
    "Dependencies / constraints",
    "Migration options",
    "Target architecture",
    "Migration waves",
    "Pilot",
    "Scale",
  ],
  coreQuestions: [
    "Which applications are critical to production?",
    "What are the main dependencies between applications?",
    "Are there regulatory or technical constraints preventing some workloads from leaving on-premise?",
    "What is the business value, cost and obsolescence of each application?",
    "What should happen to each application, and why?",
  ],
  analysisStructure:
    "Per application: business value, operational criticality, maintenance cost, obsolescence, technical complexity, dependencies, data sensitivity, availability requirements, regulatory constraints, migration complexity",
  solutionDimensions: [
    "application portfolio assessment",
    "migration strategy per application",
    "migration waves",
    "hybrid integration",
    "target architecture",
    "cloud foundations reused across waves",
  ],
  optionTypology: ["Retain on-premise", "Rehost", "Replatform", "Refactor", "Replace", "Retire"],
  principles: [
    "Not every application should necessarily move to cloud: start with an application portfolio assessment.",
    "The key consulting question: what should happen to each application, and why?",
    "Migration ≠ modernization: moving a legacy application to a VM in the cloud does not fix its maintainability.",
    "The target may be on-premise + cloud + hybrid integration.",
    "Waves: wave 1 low-risk / high-learning, wave 2 moderate dependencies, wave 3 critical applications.",
  ],
  pilotPattern:
    "One representative application with manageable dependencies that creates reusable cloud capabilities and helps teams learn",
  kpis: [
    "infrastructure run cost",
    "deployment lead time / frequency",
    "availability and incidents",
    "share of the portfolio treated per wave",
    "maintenance effort per application",
  ],
  relevantReflexes: ["E2", "E3", "E7", "E10"],
};
