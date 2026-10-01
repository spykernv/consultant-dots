import type { Playbook } from "./types";

export const agile: Playbook = {
  id: "agile",
  label: "Agile / Project Management",
  sequence: ["Outcome", "Product backlog", "Prioritization", "Delivery", "Feedback", "Measurement"],
  coreQuestions: [
    "What business outcome should the delivery produce?",
    "What is the product scope and who decides priorities?",
    "How are teams structured, and where are the dependencies?",
    "Where are the delivery bottlenecks today?",
    "How and how often do stakeholders give feedback?",
  ],
  analysisStructure:
    "Backlog quality → prioritization → roles → governance → cycle time → dependencies → stakeholder feedback → release process",
  solutionDimensions: [
    "Product Owner",
    "Scrum Master",
    "squads",
    "sprint planning",
    "reviews",
    "retrospectives",
    "dependency management",
    "product KPIs",
  ],
  optionTypology: [
    "Fix the existing process (roles, backlog, rituals)",
    "Reorganize into product teams / squads",
    "Scaled framework for multi-team dependencies",
  ],
  principles: [
    "Do not reduce Agile to Scrum ceremonies.",
    "Start from business outcome, product scope, team structure, dependencies, decision-making and delivery bottlenecks.",
  ],
  pilotPattern: "One product team → one outcome → 3 sprints → measured lead time and stakeholder satisfaction",
  kpis: ["lead time", "cycle time", "release frequency", "predictability", "business outcomes", "defect rate"],
  relevantReflexes: ["E4", "E5", "E6"],
};
