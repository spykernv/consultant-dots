import type { Session } from "@/lib/store/machine";
import { effectiveOptions } from "@/lib/store/machine";
import type { Roadmap } from "@/lib/schemas/roadmap";

export type SynthesisLine = { label: string; text: string };

/** The F#/A#/Q#/C# references matter in the analysis, not in a summary read by someone else. */
const stripIds = (text: string) => text.replace(/\s*\((?:\s*[FAQC]\d+\s*,?)+\)/g, "");

const sentence = (text: string) => {
  const t = stripIds(text).replace(/\s+/g, " ").trim();
  return t && !/[.!?…]$/.test(t) ? `${t}.` : t;
};

/** One business KPI and one adoption KPI say "it works" best; otherwise the first two by that order. */
function headlineKpis(kpis: Roadmap["kpis"]) {
  const business = kpis.find((k) => k.type === "business");
  const adoption = kpis.find((k) => k.type === "adoption");
  if (business && adoption) return [business, adoption];
  const rank = { business: 0, adoption: 1, technical: 2, risk: 3 } as const;
  return [...kpis].sort((a, b) => rank[a.type] - rank[b.type]).slice(0, 2);
}

/**
 * The five lines a consultant would put on top of the deck: the problem, what the diagnostic says, the
 * recommendation, where to start, how success is measured. Built from the validated analysis, no model call.
 * The pilot is the user's choice in the matrix, even when the roadmap was written for another one.
 */
export function buildSynthesis(s: Session): SynthesisLine[] {
  const mapping = s.stages.frame.data;
  const diagnostic = s.stages.diagnose.data;
  const options = effectiveOptions(s);
  const roadmap = s.stages.roadmap.data;
  const lines: SynthesisLine[] = [];

  if (mapping?.reformulation) lines.push({ label: "Enjeu", text: sentence(mapping.reformulation) });
  if (diagnostic?.keyInsight) lines.push({ label: "Diagnostic", text: sentence(diagnostic.keyInsight) });
  if (options?.recommendation.statement) lines.push({ label: "Recommandation", text: sentence(options.recommendation.statement) });

  const pilot = options?.initiatives.find((i) => i.verdict === "pilot")?.name ?? roadmap?.pilot.initiative ?? null;
  if (pilot) {
    const scope = roadmap && roadmap.pilot.initiative === pilot ? roadmap.pilot.scope : null;
    lines.push({ label: "Pilote", text: sentence(scope ? `${pilot} : ${scope}` : pilot) });
  }

  const kpis = roadmap ? headlineKpis(roadmap.kpis) : [];
  if (kpis.length) {
    lines.push({
      label: "Succès mesuré par",
      text: sentence(kpis.map((k) => `${k.name} : ${k.baseline} → ${k.target}`).join(" ; ")),
    });
  }
  return lines;
}
