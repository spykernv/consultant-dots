import type { Playbook } from "./types";

export const genai: Playbook = {
  id: "genai",
  label: "GenAI / AI",
  sequence: [
    "Business pain",
    "Tasks",
    "AI opportunities",
    "Prioritization",
    "Solution",
    "Guardrails",
    "Pilot",
    "Evaluation",
    "Scale",
  ],
  coreQuestions: [
    "Which tasks consume the most time today?",
    "Which outputs can have contractual or regulatory consequences?",
    "What knowledge sources do users rely on today?",
    "What data may be used, and under which confidentiality rules?",
    "Who stays in control of the final answer?",
  ],
  analysisStructure:
    "Business pain → tasks → AI opportunities → value × feasibility × risk → solution → guardrails → evaluation",
  solutionDimensions: [
    "knowledge sources",
    "model choice",
    "grounding / RAG",
    "permissions",
    "data confidentiality",
    "human-in-the-loop",
    "traceability",
    "evaluation",
    "hallucination rate",
    "adoption",
  ],
  optionTypology: [
    "Internal assistant (the employee stays in control)",
    "Assisted drafting / response suggestion with human validation",
    "Automation of low-risk tasks (classification, summarization, extraction)",
    "Autonomous customer-facing answers (highest risk)",
  ],
  principles: [
    "DO NOT design the AI architecture before selecting the use case.",
    "Prioritize use cases on BUSINESS VALUE × FEASIBILITY × RISK.",
    "Risk includes hallucination, contractual consequences, privacy, security, compliance, bias and lack of traceability.",
    "Prefer a first use case where the human stays in control and impact can be measured quickly.",
  ],
  pilotPattern:
    "1 team → 1 use case with the human in control → 1 curated knowledge base → evaluation set → measured before/after",
  examples: [
    "Customer service use cases: internal knowledge assistant, response suggestion, email classification, call summarization, CRM enrichment, document extraction.",
    "Insurance advisors spend too much time finding information → first use case: internal knowledge assistant, because it directly addresses search time, the advisor remains in control, it is lower risk than autonomous customer responses, and impact can be measured quickly.",
  ],
  kpis: [
    "business: handling time, search time, customer satisfaction, productivity",
    "AI: factual accuracy, retrieval quality, error rate, hallucination rate, user acceptance",
  ],
  relevantReflexes: ["E1", "E5", "E6", "E9"],
};
