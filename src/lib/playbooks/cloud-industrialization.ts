import type { Playbook } from "./types";

export const cloudIndustrialization: Playbook = {
  id: "cloud_industrialization",
  label: "Cloud Industrialization",
  sequence: [
    "Landing Zone",
    "Infrastructure as Code",
    "CI/CD",
    "Security guardrails",
    "Observability",
    "FinOps",
    "Platform engineering",
  ],
  coreQuestions: [
    "How long does it take today to get a new environment or deploy a change?",
    "How are cloud accounts, network and identity organized?",
    "Which security controls are manual today?",
    "Who pays for what, and is cloud spend visible?",
    "How mature are the teams on cloud and automation?",
  ],
  analysisStructure:
    "Cloud accounts/subscriptions, network, identity, security, CI/CD, IaC, monitoring, FinOps, developer experience, operating model",
  solutionDimensions: [
    "landing zone",
    "infrastructure as code",
    "CI/CD",
    "security guardrails",
    "observability",
    "FinOps",
    "platform engineering",
  ],
  optionTypology: [
    "Minimal landing zone + templates",
    "Internal platform team with golden paths",
    "Managed services / partner-run platform",
  ],
  principles: [
    "Different from simple cloud migration: how do we make cloud delivery repeatable, secure and scalable?",
    "Avoid over-engineering if the organization is immature.",
  ],
  pilotPattern: "One product team onboarded on the landing zone with IaC + CI/CD templates, time-to-environment measured",
  kpis: [
    "time to provision an environment",
    "deployment frequency",
    "share of infrastructure in IaC",
    "security findings",
    "cloud cost visibility",
  ],
  relevantReflexes: ["E1", "E5", "E6", "E7"],
};
