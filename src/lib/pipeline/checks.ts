import type { StageId, StageOutputs } from "@/lib/schemas";
import type { StageInputs } from "@/lib/schemas/api";
import { buildCaseBrief, caseContains, knownIds } from "@/lib/prompts/brief";

/**
 * What the code-side guardrails caught on one stage run, as counts: the raw model output against what the
 * normalizer kept. These are the code-graded signals the eval aggregates (booleans are 0 / 1 so they average into rates).
 */
export type StageChecks = Record<string, number>;

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/** Distinct ids the model cited that do not exist in the brief: the model invented a source. */
const unknownIds = (ids: string[], known: Set<string>) => [...new Set(ids)].filter((id) => !known.has(id)).length;

export function stageChecks<K extends StageId>(
  stage: K,
  raw: StageOutputs[K],
  normalized: StageOutputs[K],
  inputs: StageInputs[K],
): StageChecks {
  switch (stage) {
    case "frame": {
      const d = raw as StageOutputs["frame"];
      const proposed = d.facts.slice(0, 10);
      const verified = proposed.filter((f) => caseContains(inputs.caseText, f.evidence)).length;
      return { factsProposed: proposed.length, factsVerified: verified, factsDemoted: proposed.length - verified };
    }
    case "diagnose": {
      const d = raw as StageOutputs["diagnose"];
      const known = knownIds(buildCaseBrief(inputs as StageInputs["diagnose"]));
      const findings = d.findings.slice(0, 8);
      return {
        findings: findings.length,
        citations: findings.reduce((n, f) => n + new Set(f.basis).size, 0),
        citationsDropped: findings.reduce((n, f) => n + unknownIds(f.basis, known), 0),
        // An empty basis is allowed ("pure inference"); a finding whose every citation is invented is not.
        findingsInferred: findings.filter((f) => f.basis.length === 0).length,
        findingsUncited: findings.filter((f) => f.basis.length > 0 && f.basis.every((id) => !known.has(id))).length,
      };
    }
    case "options": {
      const d = raw as StageOutputs["options"];
      const kept = normalized as StageOutputs["options"];
      const known = knownIds(buildCaseBrief(inputs as StageInputs["options"]));
      const refs = [
        ...d.comparison.constraints.flatMap((c) => c.basis),
        ...d.recommendation.dependsOn,
        ...d.recommendation.pivots.map((p) => p.basis).filter(Boolean),
      ];
      // The same rule as the normalizer's note: the kept recommendation fails a kept constraint.
      const recommended = kept.recommendation.optionId;
      const failsConstraint = kept.comparison.constraints.some((c) => c.fits.some((f) => f.optionId === recommended && f.fit === "fail"));
      return {
        citations: new Set(refs).size,
        citationsDropped: unknownIds(refs, known),
        recommendationUnknown: d.recommendation.optionId && !recommended ? 1 : 0,
        recommendationFailsConstraint: recommended && failsConstraint ? 1 : 0,
        pilotFixed: d.initiatives.slice(0, 6).filter((i) => i.verdict === "pilot").length === 1 ? 0 : 1,
      };
    }
    case "challenge": {
      const d = raw as StageOutputs["challenge"];
      const answer = (inputs as StageInputs["challenge"]).answer;
      // The flags the normalizer keeps: most severe first, at most 6.
      const flags = [...d.flags].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, 6);
      const quoted = flags.filter((f) => f.quote.trim());
      return {
        flags: flags.length,
        quotesProposed: quoted.length,
        quotesRemoved: quoted.filter((f) => !caseContains(answer, f.quote)).length,
      };
    }
    default:
      return {};
  }
}
