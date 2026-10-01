import type { Playbook } from "./types";

export const maIt: Playbook = {
  id: "ma_it",
  label: "M&A IT",
  sequence: [
    "Pre-close assessment",
    "Day 1 readiness",
    "Stabilization",
    "Integration / separation",
    "Optimization",
  ],
  coreQuestions: [
    "What is the transaction type: acquisition, merger, carve-out or divestiture?",
    "What must work on Day 1 (payroll, finance, access, customer operations)?",
    "Which systems, contracts and licenses are shared or entangled?",
    "What TSA services are needed, and for how long?",
    "What is the long-term target IT operating model?",
  ],
  analysisStructure:
    "Applications, infrastructure, data, cybersecurity, vendors, contracts, licenses, IT organization, costs, dependencies",
  solutionDimensions: [
    "TSA",
    "system separation",
    "integration",
    "application rationalization",
    "identity / access",
    "data migration",
    "cybersecurity",
    "vendor contracts",
    "IT operating model",
  ],
  optionTypology: [
    "Absorb (migrate onto the acquirer's systems)",
    "Coexist (keep both, connect them)",
    "Best of breed (choose per domain)",
    "Carve-out: TSA then stand-alone or clone",
  ],
  principles: [
    "First identify the transaction type.",
    "Distinguish DAY 1 REQUIREMENTS from the LONG-TERM TARGET.",
  ],
  pilotPattern: "One function (e.g. finance) made Day-1 ready end to end, then used as the template",
  kpis: ["Day 1 readiness checklist", "TSA exit date and cost", "synergies realized", "incidents during transition"],
  relevantReflexes: ["E1", "E4", "E7"],
};
