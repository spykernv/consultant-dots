import type { Initiative } from "@/lib/schemas/options";

export const CRITERIA = ["value", "feasibility", "risk", "timeToValue", "reuse"] as const;
export type Criterion = (typeof CRITERIA)[number];
export type Weights = Record<Criterion, number>;

export const DEFAULT_WEIGHTS: Weights = { value: 2, feasibility: 1, risk: 1, timeToValue: 1, reuse: 1 };
export const MAX_WEIGHT = 3;

type Scores = Pick<Initiative, Criterion>;

/** Risk is the only criterion where a higher score is worse, so it is subtracted. */
export function weightedScore(i: Scores, w: Weights = DEFAULT_WEIGHTS): number {
  return w.value * i.value + w.feasibility * i.feasibility + w.timeToValue * i.timeToValue + w.reuse * i.reuse - w.risk * i.risk;
}

export const priorityScore = (i: Scores) => weightedScore(i, DEFAULT_WEIGHTS);

export function formulaLabel(w: Weights): string {
  const term = (weight: number, label: string) => (weight === 0 ? null : weight === 1 ? label : `${weight}×${label}`);
  const plus = [
    term(w.value, "valeur"),
    term(w.feasibility, "faisabilité"),
    term(w.timeToValue, "délai"),
    term(w.reuse, "réutilisation"),
  ].filter(Boolean);
  const minus = term(w.risk, "risque");
  return `Score = ${plus.join(" + ") || "0"}${minus ? ` − ${minus}` : ""}`;
}
