import type { OptionsAnalysis } from "@/lib/schemas/options";
import { escapeLabel } from "./to-mermaid";

const STYLES = {
  question: "fill:#f1f5f9,stroke:#64748b,color:#0f172a",
  assumed: "fill:#eef2ff,stroke:#4f46e5,color:#1e1b4b",
  other: "fill:#ffffff,stroke:#94a3b8,stroke-dasharray:4 3,color:#334155",
  reco: "fill:#e0e7ff,stroke:#4f46e5,stroke-width:3px,color:#1e1b4b",
  alternative: "fill:#ffffff,stroke:#475569,stroke-width:2px,color:#0f172a",
  adapted: "fill:#fffbeb,stroke:#d97706,stroke-dasharray:5 4,color:#78350f",
} as const;

type PivotInput = Pick<OptionsAnalysis, "options"> & {
  recommendation: Pick<OptionsAnalysis["recommendation"], "optionId"> & {
    pivots?: OptionsAnalysis["recommendation"]["pivots"];
  };
};

/**
 * "What would change my recommendation", drawn as a decision tree: each uncertain point splits into the answer
 * we assume today, which leads to the recommendation, and the other answer, which leads elsewhere.
 * Answers are nodes rather than edge labels so that nothing overlaps where the branches converge.
 */
export function pivotsToMermaid(analysis: PivotInput): string | null {
  const pivots = analysis.recommendation.pivots ?? [];
  if (pivots.length === 0) return null;

  const names = new Map(analysis.options.map((o) => [o.id, o.name]));
  const recoId = analysis.recommendation.optionId;
  const recoName = recoId ? names.get(recoId) : undefined;
  const recoLabel = recoId && recoName ? `★ ${recoId} · ${recoName}` : "★ Recommandation actuelle";

  const lines = ["flowchart LR", `  reco(["${escapeLabel(recoLabel, 56)}"])`];
  const classes: Record<keyof typeof STYLES, string[]> = {
    question: [],
    assumed: [],
    other: [],
    reco: ["reco"],
    alternative: [],
    adapted: [],
  };
  const alternatives = new Map<string, string>();
  const edges: { line: string; main: boolean }[] = [];

  pivots.forEach((pivot, i) => {
    const q = `p${i + 1}`;
    const yes = `${q}a`;
    const no = `${q}b`;
    lines.push(`  ${q}("${escapeLabel(pivot.basis ? `${pivot.basis} · ${pivot.question}` : pivot.question, 60, "?")}")`);
    lines.push(`  ${yes}["${escapeLabel(pivot.assumed, 48, "Hypothèse actuelle")}"]`);
    lines.push(`  ${no}["${escapeLabel(pivot.ifInstead, 48, "Autre réponse")}"]`);
    classes.question.push(q);
    classes.assumed.push(yes);
    classes.other.push(no);

    let target: string;
    const altName = pivot.thenOptionId ? names.get(pivot.thenOptionId) : undefined;
    if (pivot.thenOptionId && altName) {
      target = alternatives.get(pivot.thenOptionId) ?? `o${alternatives.size + 1}`;
      if (!alternatives.has(pivot.thenOptionId)) {
        alternatives.set(pivot.thenOptionId, target);
        lines.push(`  ${target}["${escapeLabel(`${pivot.thenOptionId} · ${altName}`, 56)}"]`);
        classes.alternative.push(target);
      }
    } else {
      target = `x${i + 1}`;
      lines.push(`  ${target}["${escapeLabel(`${recoId ?? "Recommandation"} adaptée`, 56)}"]`);
      classes.adapted.push(target);
    }

    edges.push(
      { line: `${q} ==> ${yes}`, main: true },
      { line: `${q} -.-> ${no}`, main: false },
      { line: `${yes} ==> reco`, main: true },
      { line: `${no} -.-> ${target}`, main: false },
    );
  });

  for (const edge of edges) lines.push(`  ${edge.line}`);
  for (const [name, style] of Object.entries(STYLES)) lines.push(`  classDef c_${name} ${style}`);
  for (const [name, ids] of Object.entries(classes)) if (ids.length) lines.push(`  class ${ids.join(",")} c_${name}`);
  const main = edges.flatMap((edge, index) => (edge.main ? [index] : []));
  lines.push(`  linkStyle ${main.join(",")} stroke:#4f46e5`);
  return lines.join("\n");
}
