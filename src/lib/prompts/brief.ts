import type { BriefInputs } from "@/lib/schemas/api";
import type { Classification } from "@/lib/schemas/classify";
import type { ConstraintType } from "@/lib/schemas/frame";
import type { Source } from "@/lib/schemas/common";
import { domainLabel } from "@/lib/domain/domains";
import { CONSTRAINT_LABELS } from "@/lib/domain/labels";

export type BriefClarification = {
  id: string;
  question: string;
  answer: string;
  source: "client" | "assumption";
};

export type CaseBrief = {
  caseText: string;
  classification: Classification;
  reformulation: string;
  premiseChallenge: string | null;
  objectives: { text: string; source: "case" | "assumption" }[];
  painPoints: string[];
  constraints: { text: string; type: ConstraintType; source: "case" | "assumption" }[];
  stakeholders: { name: string; role: string; source: "case" | "assumption" }[];
  facts: { id: string; text: string }[];
  assumptions: { id: string; text: string; basis: string }[];
  clarifications: BriefClarification[];
  clientNotes: { id: string; text: string }[];
};

export function splitClientNotes(notes: string): { id: string; text: string }[] {
  return notes
    .split(/\r?\n+/)
    .map((line) => line.replace(/^[-•*]\s*/, "").trim())
    .filter(Boolean)
    .map((text, i) => ({ id: `C${i + 1}`, text }));
}

export function buildCaseBrief(inputs: BriefInputs): CaseBrief {
  const { caseText, classification, mapping, questions, clarifications, clientNotes } = inputs;
  const byQuestion = new Map(clarifications.map((c) => [c.questionId, c]));

  return {
    caseText,
    classification,
    reformulation: mapping.reformulation,
    premiseChallenge: mapping.premiseChallenge,
    objectives: mapping.businessObjectives,
    painPoints: mapping.painPoints,
    constraints: mapping.constraints,
    stakeholders: mapping.stakeholders,
    facts: mapping.facts.map(({ id, text }) => ({ id, text })),
    assumptions: mapping.assumptions,
    clarifications: questions.questions.map((q) => {
      const c = byQuestion.get(q.id);
      const answer = c?.status === "answered" ? c.answer.trim() : "";
      return answer
        ? { id: q.id, question: q.question, answer, source: "client" as const }
        : { id: q.id, question: q.question, answer: q.defaultAssumption, source: "assumption" as const };
    }),
    clientNotes: splitClientNotes(clientNotes),
  };
}

export function knownIds(brief: Pick<CaseBrief, "facts" | "assumptions" | "clarifications" | "clientNotes">) {
  return new Set([
    ...brief.facts.map((f) => f.id),
    ...brief.assumptions.map((a) => a.id),
    ...brief.clarifications.map((c) => c.id),
    ...brief.clientNotes.map((n) => n.id),
  ]);
}

/** A claim is only as solid as its weakest basis: any assumption makes it an assumption. */
export function sourceOfBasis(
  basis: readonly string[],
  brief: Pick<CaseBrief, "clarifications">,
): Source {
  if (basis.length === 0) return "assumption";
  let client = false;
  for (const id of basis) {
    if (id.startsWith("A")) return "assumption";
    if (id.startsWith("Q")) {
      const clarification = brief.clarifications.find((c) => c.id === id);
      if (!clarification || clarification.source === "assumption") return "assumption";
      client = true;
    }
    if (id.startsWith("C")) client = true;
  }
  return client ? "client" : "case";
}

export function describeId(
  id: string,
  brief: Pick<CaseBrief, "facts" | "assumptions" | "clarifications" | "clientNotes">,
): string | null {
  const fact = brief.facts.find((f) => f.id === id);
  if (fact) return fact.text;
  const assumption = brief.assumptions.find((a) => a.id === id);
  if (assumption) return assumption.text;
  const clarification = brief.clarifications.find((c) => c.id === id);
  if (clarification) return `${clarification.question} → ${clarification.answer}`;
  const note = brief.clientNotes.find((n) => n.id === id);
  return note ? note.text : null;
}

// A sign or comparator before a number changes its meaning ("-12 %", "< 3 ans"); a dash not glued to the number is a hyphen, a bullet or an aside.
const MATCH_TOKEN = /\p{L}[\p{L}\p{M}]*|\p{N}+|[\p{Sc}%]|(?<![\p{L}\p{N}])-(?=\p{N})|(?<![-=<>])[+<>\u2264\u2265](?=\s*-?\p{N})/gu;

/** Words, numbers, currencies, % and signs only: quotes, punctuation, spacing, ligatures and invisible characters no longer matter. */
export function normalizeForMatch(text: string): string {
  const prepared = text
    .normalize("NFKC")
    .replace(/\u00AD\s*|[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[\u02B9-\u02BD\u02CA\u02CB]/g, " ")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/<=|\u2A7D/g, "\u2264")
    .replace(/>=|\u2A7E/g, "\u2265")
    .toLowerCase();
  return (prepared.match(MATCH_TOKEN) ?? []).join(" ");
}

const LINE_END_HYPHEN = /(\p{L})[-\u2010\u2011]\s*\n\s*(?=\p{L})/gu;

function containsInOrder(haystack: string, fragments: string[]): boolean {
  let from = 0;
  for (const fragment of fragments) {
    const at = haystack.indexOf(` ${fragment} `, from);
    if (at < 0) return false;
    from = at + fragment.length + 1;
  }
  return true;
}

/** True when every fragment of the evidence, split on elisions ("…", "[…]", "(...)"), appears in the case as whole words and in order. */
export function caseContains(caseText: string, evidence: string): boolean {
  const fragments = evidence
    .normalize("NFKC")
    .split(/\.{2,}/)
    .map(normalizeForMatch)
    .filter(Boolean);
  if (!fragments.some((f) => f.length >= 3)) return false;
  // A word cut by a hyphen at a line break (PDF copy) may be quoted whole or hyphenated.
  const texts = new Set([caseText, caseText.replace(LINE_END_HYPHEN, "$1")]);
  return [...texts].some((text) => containsInOrder(` ${normalizeForMatch(text)} `, fragments));
}

const sourceTag = (source: "case" | "assumption") => (source === "case" ? "énoncé" : "hypothèse");

export function renderBrief(brief: CaseBrief): string {
  const lines: string[] = [];
  const c = brief.classification;
  lines.push(`Reformulation : ${brief.reformulation}`);
  lines.push(
    `Type de case : ${domainLabel(c.primaryDomain)} (${Math.round(c.confidence)} %)` +
      (c.secondaryDomains.length ? ` ; secondaires : ${c.secondaryDomains.map(domainLabel).join(", ")}` : ""),
  );
  if (brief.premiseChallenge) lines.push(`Recadrage : ${brief.premiseChallenge}`);
  lines.push("", "Objectifs business :", ...brief.objectives.map((o) => `- ${o.text} [${sourceTag(o.source)}]`));
  lines.push("", "Pain points (énoncé) :", ...brief.painPoints.map((p) => `- ${p}`));
  lines.push(
    "",
    "Contraintes :",
    ...brief.constraints.map((k) => `- [${CONSTRAINT_LABELS[k.type]}] ${k.text} [${sourceTag(k.source)}]`),
  );
  lines.push(
    "",
    "Parties prenantes :",
    ...brief.stakeholders.map((s) => `- ${s.name} — ${s.role} [${sourceTag(s.source)}]`),
  );
  lines.push("", "Faits (énoncé) :", ...brief.facts.map((f) => `- ${f.id} : ${f.text}`));
  lines.push("", "Hypothèses :", ...brief.assumptions.map((a) => `- ${a.id} : ${a.text} (base : ${a.basis})`));
  lines.push(
    "",
    "Clarifications :",
    ...brief.clarifications.map((q) =>
      q.source === "client"
        ? `- ${q.id} — ${q.question} → Réponse du client : ${q.answer}`
        : `- ${q.id} — ${q.question} → Hypothèse de travail, NON confirmée : ${q.answer}`,
    ),
  );
  if (brief.clientNotes.length) {
    lines.push("", "Informations complémentaires du client :", ...brief.clientNotes.map((n) => `- ${n.id} : ${n.text}`));
  }
  return lines.join("\n");
}
