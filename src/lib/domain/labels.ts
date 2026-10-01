import type { BackboneStage, Source } from "@/lib/schemas/common";
import type { ConstraintType } from "@/lib/schemas/frame";
import type { NodeKind } from "@/lib/schemas/diagram";
import type { Fit, Verdict } from "@/lib/schemas/options";
import type { StageId } from "@/lib/schemas";
import type { ChallengeLevel, Severity } from "@/lib/schemas/challenge";

export const SOURCE_LABELS: Record<Source, string> = {
  case: "Fait",
  client: "Client",
  assumption: "Hypothèse",
};

export const BACKBONE_LABELS: Record<BackboneStage, string> = {
  cadrage: "Cadrage",
  diagnostic: "Diagnostic",
  options: "Options",
  cible: "Cible",
  pilote: "Pilote",
  scale: "Mesure / scale",
};

export const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  regulatory: "Réglementaire",
  data_sensitivity: "Données sensibles",
  legacy: "Legacy",
  availability: "Disponibilité",
  budget: "Budget",
  timeline: "Délai",
  skills: "Compétences",
  organizational: "Organisation",
  dependencies: "Dépendances",
  contractual: "Contrats",
  geographic: "Géographie",
  other: "Autre",
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  pilot: "Pilote",
  next: "Ensuite",
  later: "Plus tard",
  avoid: "À éviter",
};

export const FIT_LABELS: Record<Fit, string> = {
  pass: "Respectée",
  partial: "Sous condition",
  fail: "Bloquante",
};

export const KPI_TYPE_LABELS = {
  business: "Business",
  adoption: "Adoption",
  technical: "Technique",
  risk: "Risque",
} as const;

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  actor: "Acteur",
  system: "Système",
  data: "Données",
  process: "Processus",
  pain_point: "Irritant",
  constraint: "Contrainte",
  control: "Gouvernance / contrôle",
  output: "Résultat",
};

export const STAGE_LABELS: Record<StageId, string> = {
  classify: "Type de case",
  frame: "Cartographie",
  questions: "Questions",
  diagnose: "Diagnostic",
  currentState: "Schéma existant",
  options: "Options",
  target: "Cible",
  roadmap: "Roadmap",
  oral: "Restitution orale",
  challenge: "Challenge",
};

export const CHALLENGE_LEVEL_LABELS: Record<ChallengeLevel, string> = {
  a_retravailler: "À retravailler",
  correct: "Correct",
  solide: "Solide",
  impressionnant: "Impressionnant",
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  high: "Bloquant",
  medium: "Important",
  low: "Mineur",
};

export const CRITERION_LABELS = {
  value: "Valeur",
  feasibility: "Faisab.",
  risk: "Risque",
  timeToValue: "Délai",
  reuse: "Réutil.",
} as const;

export const CRITERION_FULL_LABELS = {
  value: "Valeur",
  feasibility: "Faisabilité",
  risk: "Risque",
  timeToValue: "Délai de valeur",
  reuse: "Réutilisation",
} as const;
