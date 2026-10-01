import type { StageId, StageOutputs } from "@/lib/schemas";
import type { StageInputs } from "@/lib/schemas/api";
import type { DiagramSpec } from "@/lib/schemas/diagram";
import type { Initiative, OptionComparison, Pivot } from "@/lib/schemas/options";
import { ORAL_SECTION_KINDS } from "@/lib/schemas/oral";
import { buildCaseBrief, caseContains, knownIds } from "@/lib/prompts/brief";
import { priorityScore } from "@/lib/domain/scoring";

export type Normalized<K extends StageId> = { data: StageOutputs[K]; notes: string[] };

const cap = <T>(items: T[], max: number) => items.slice(0, max);
const uniqueBy = <T>(items: T[], key: (item: T) => string) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function sanitizeDiagram(diagram: DiagramSpec): DiagramSpec {
  const nodes = uniqueBy(diagram.nodes, (n) => n.id);
  const groups = uniqueBy(diagram.groups, (g) => g.id);
  const groupIds = new Set(groups.map((g) => g.id));
  const cleanGroups = groups.map((g) => ({
    ...g,
    parentId: g.parentId && groupIds.has(g.parentId) && g.parentId !== g.id ? g.parentId : null,
  }));
  const cleanNodes = nodes.map((n) => ({ ...n, groupId: n.groupId && groupIds.has(n.groupId) ? n.groupId : null }));
  const refs = new Set([...cleanNodes.map((n) => n.id), ...groupIds]);
  const edges = uniqueBy(
    diagram.edges.filter((e) => refs.has(e.from) && refs.has(e.to) && e.from !== e.to),
    (e) => `${e.from}->${e.to}`,
  );
  return { direction: diagram.direction, groups: cleanGroups, nodes: cleanNodes, edges };
}

function normalizeFrame(data: StageOutputs["frame"], caseText: string): Normalized<"frame"> {
  const notes: string[] = [];
  const facts: StageOutputs["frame"]["facts"] = [];
  const assumptions: StageOutputs["frame"]["assumptions"] = [...cap(data.assumptions, 8)];

  for (const fact of cap(data.facts, 10)) {
    if (caseContains(caseText, fact.evidence)) {
      facts.push(fact);
    } else {
      assumptions.push({ id: "", text: fact.text, basis: "Formulation non retrouvée telle quelle dans l'énoncé" });
      notes.push(`Fait requalifié en hypothèse (citation introuvable dans l'énoncé) : « ${fact.text} »`);
    }
  }

  return {
    data: {
      ...data,
      businessObjectives: cap(data.businessObjectives, 5),
      painPoints: cap(data.painPoints, 6),
      constraints: cap(data.constraints, 6),
      stakeholders: cap(data.stakeholders, 7),
      facts: facts.map((f, i) => ({ ...f, id: `F${i + 1}` })),
      assumptions: assumptions.map((a, i) => ({ ...a, id: `A${i + 1}` })),
      premiseChallenge: data.premiseChallenge?.trim() ? data.premiseChallenge : null,
    },
    notes,
  };
}

/** One entry per known option, in the options' order: the comparison table reads column by column. */
function alignToOptions<T extends { optionId: string }>(items: T[], optionIds: string[]): T[] {
  const byOption = new Map<string, T>();
  for (const item of items) {
    if (optionIds.includes(item.optionId) && !byOption.has(item.optionId)) byOption.set(item.optionId, item);
  }
  return optionIds.flatMap((id) => byOption.get(id) ?? []);
}

function normalizeComparison(comparison: OptionComparison, optionIds: string[], ids: Set<string>): OptionComparison {
  return {
    constraints: cap(
      comparison.constraints
        .map((c) => ({
          ...c,
          basis: [...new Set(c.basis)].filter((id) => ids.has(id)),
          fits: alignToOptions(c.fits, optionIds),
        }))
        .filter((c) => c.label.trim() && c.fits.length > 0),
      3,
    ),
    criteria: cap(
      comparison.criteria
        .map((c) => ({ ...c, scores: alignToOptions(c.scores, optionIds) }))
        .filter((c) => c.label.trim() && c.scores.length > 0),
      4,
    ),
  };
}

/** A pivot must lead somewhere else: an unknown or already-recommended option means "adapt the recommendation". */
function normalizePivots(pivots: Pivot[], optionIds: string[], recommended: string | null, ids: Set<string>): Pivot[] {
  return cap(
    uniqueBy(
      pivots.filter((p) => p.question.trim()),
      (p) => p.question.trim().toLowerCase(),
    ),
    3,
  ).map((p) => ({
    ...p,
    basis: ids.has(p.basis) ? p.basis : "",
    thenOptionId: p.thenOptionId && optionIds.includes(p.thenOptionId) && p.thenOptionId !== recommended ? p.thenOptionId : null,
  }));
}

function ensureSinglePilot(initiatives: Initiative[]): Initiative[] {
  const pilots = initiatives.filter((i) => i.verdict === "pilot");
  if (pilots.length === 1) return initiatives;
  const best = (pilots.length ? pilots : initiatives)
    .slice()
    .sort((a, b) => priorityScore(b) - priorityScore(a))[0];
  return initiatives.map((i) =>
    i === best ? { ...i, verdict: "pilot" as const } : i.verdict === "pilot" ? { ...i, verdict: "next" as const } : i,
  );
}

export function normalizeStage<K extends StageId>(
  stage: K,
  raw: StageOutputs[K],
  inputs: StageInputs[K],
): Normalized<K> {
  const out = (data: StageOutputs[K], notes: string[] = []) => ({ data, notes }) as Normalized<K>;

  switch (stage) {
    case "classify": {
      const d = raw as StageOutputs["classify"];
      const confidence = Math.min(100, Math.max(0, Math.round(d.confidence <= 1 ? d.confidence * 100 : d.confidence)));
      const secondaryDomains = cap(
        [...new Set(d.secondaryDomains)].filter((x) => x !== d.primaryDomain),
        2,
      );
      return out({ ...d, confidence, secondaryDomains } as StageOutputs[K]);
    }
    case "frame": {
      const n = normalizeFrame(raw as StageOutputs["frame"], inputs.caseText);
      return out(n.data as StageOutputs[K], n.notes);
    }
    case "questions": {
      const d = raw as StageOutputs["questions"];
      return out({ questions: cap(d.questions, 5).map((q, i) => ({ ...q, id: `Q${i + 1}` })) } as StageOutputs[K]);
    }
    case "diagnose": {
      const d = raw as StageOutputs["diagnose"];
      const ids = knownIds(buildCaseBrief(inputs as StageInputs["diagnose"]));
      return out({
        framework: cap(d.framework, 7).map((f) => ({ ...f, keyQuestions: cap(f.keyQuestions, 3) })),
        findings: cap(d.findings, 8).map((f) => ({ ...f, basis: [...new Set(f.basis)].filter((id) => ids.has(id)) })),
        rootCauses: cap(d.rootCauses, 4),
        keyInsight: d.keyInsight,
      } as StageOutputs[K]);
    }
    case "currentState": {
      const d = raw as StageOutputs["currentState"];
      return out({ diagram: sanitizeDiagram(d.diagram), bottlenecks: cap(d.bottlenecks, 3) } as StageOutputs[K]);
    }
    case "options": {
      const d = raw as StageOutputs["options"];
      const ids = knownIds(buildCaseBrief(inputs as StageInputs["options"]));
      const options = cap(uniqueBy(d.options, (o) => o.id), 3);
      const optionIds = options.map((o) => o.id);
      const optionId =
        d.recommendation.optionId && optionIds.includes(d.recommendation.optionId) ? d.recommendation.optionId : null;
      const comparison = normalizeComparison(d.comparison, optionIds, ids);
      const notes: string[] = [];
      const broken = optionId
        ? comparison.constraints.find((c) => c.fits.some((f) => f.optionId === optionId && f.fit === "fail"))
        : undefined;
      if (broken) {
        notes.push(`L'option recommandée ne respecte pas « ${broken.label} » dans la comparaison : à justifier ou à revoir.`);
      }
      return out(
        {
          options,
          comparison,
          recommendation: {
            ...d.recommendation,
            optionId,
            dependsOn: [...new Set(d.recommendation.dependsOn)].filter((id) => ids.has(id)),
            pivots: normalizePivots(d.recommendation.pivots, optionIds, optionId, ids),
          },
          targetBlocks: cap(d.targetBlocks, 6),
          initiatives: ensureSinglePilot(cap(d.initiatives, 6)),
          traps: cap(uniqueBy(d.traps, (t) => t.reflex), 3),
        } as StageOutputs[K],
        notes,
      );
    }
    case "target": {
      const d = raw as StageOutputs["target"];
      return out({
        principles: cap(d.principles, 5),
        diagram: sanitizeDiagram(d.diagram),
        keyChanges: cap(d.keyChanges, 5),
        operatingModel: cap(d.operatingModel, 4),
      } as StageOutputs[K]);
    }
    case "roadmap": {
      const d = raw as StageOutputs["roadmap"];
      const override = (inputs as StageInputs["roadmap"]).pilotOverride;
      return out({
        phases: cap(d.phases, 4).map((p) => ({
          ...p,
          actions: cap(p.actions, 4),
          deliverables: cap(p.deliverables, 4),
          decisions: cap(p.decisions, 3),
          dependencies: cap(p.dependencies, 3),
          kpis: cap(p.kpis, 3),
        })),
        pilot: {
          ...d.pilot,
          initiative: override ? override.chosen : d.pilot.initiative,
          successCriteria: cap(d.pilot.successCriteria, 3),
          reusableFoundations: cap(d.pilot.reusableFoundations, 3),
        },
        kpis: cap(d.kpis, 6),
        risks: cap(d.risks, 5),
      } as StageOutputs[K]);
    }
    case "challenge": {
      const d = raw as StageOutputs["challenge"];
      const answer = (inputs as StageInputs["challenge"]).answer;
      const notes: string[] = [];
      const rank = { high: 0, medium: 1, low: 2 } as const;
      const flags = cap(
        [...d.flags].sort((a, b) => rank[a.severity] - rank[b.severity]),
        6,
      ).map((flag) => {
        if (!flag.quote.trim() || caseContains(answer, flag.quote)) return flag;
        notes.push(`Citation introuvable dans ta réponse, retirée : « ${flag.quote} »`);
        return { ...flag, quote: "" };
      });
      return out(
        {
          ...d,
          flags,
          strengths: cap(d.strengths, 3),
          missing: cap(d.missing, 4),
          nextVersion: cap(d.nextVersion, 4),
        } as StageOutputs[K],
        notes,
      );
    }
    case "oral": {
      const d = raw as StageOutputs["oral"];
      const order = (kind: string) => ORAL_SECTION_KINDS.indexOf(kind as (typeof ORAL_SECTION_KINDS)[number]);
      return out({
        ...d,
        sections: uniqueBy(d.sections, (s) => s.kind)
          .sort((a, b) => order(a.kind) - order(b.kind))
          .map((s) => ({ ...s, bullets: cap(s.bullets, 4) })),
        differentiators: cap(d.differentiators, 3),
      } as StageOutputs[K]);
    }
    default:
      return out(raw);
  }
}
