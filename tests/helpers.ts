import { readFileSync } from "node:fs";
import path from "node:path";
import type { BriefInputs } from "@/lib/schemas/api";
import type { StageId, StageOutputs } from "@/lib/schemas";
import { buildInputs, hashInputsOf, initialSession, type Session } from "@/lib/store/machine";
import { SAMPLE_CASES } from "@/lib/samples";

export const CASE_TEXT =
  "Un groupe industriel a 3 filiales (France, Allemagne, Espagne). Chaque filiale a ses propres KPIs et le reporting groupe se fait à la main sous Excel en 10 jours par mois.";

export const fixture = <K extends StageId>(stage: K, caseId = "data-platform") =>
  JSON.parse(readFileSync(path.join(process.cwd(), "fixtures", "mock", caseId, `${stage}.json`), "utf8")) as StageOutputs[K];

/** A session where `done` stages hold the recorded demo outputs, hashed as the app would have hashed them. */
export function sessionWith(done: StageId[], patch: Partial<Session> = {}): Session {
  const base: Session = { ...initialSession(), started: true, caseText: SAMPLE_CASES[0].text, ...patch };
  const stages = { ...base.stages };
  for (const stage of done) stages[stage] = { ...stages[stage], status: "done", data: fixture(stage) as never } as never;
  const s = { ...base, stages };
  for (const stage of done) {
    s.stages[stage] = { ...s.stages[stage], inputHash: hashInputsOf(stage, buildInputs(s, stage)) } as never;
  }
  return s;
}

export function makeBriefInputs(overrides: Partial<BriefInputs> = {}): BriefInputs {
  return {
    caseText: CASE_TEXT,
    classification: {
      primaryDomain: "data_platform",
      secondaryDomains: ["data_management"],
      confidence: 90,
      rationale: "Consolidation multi-filiales.",
    },
    mapping: {
      reformulation: "Donner à la DG une vision consolidée fiable.",
      businessObjectives: [{ text: "Réduire le temps de reporting", source: "case" }],
      painPoints: ["Reporting manuel"],
      constraints: [{ text: "RGPD", type: "regulatory", source: "assumption" }],
      stakeholders: [{ name: "DG", role: "Sponsor", source: "case" }],
      facts: [{ id: "F1", text: "3 filiales", evidence: "3 filiales" }],
      assumptions: [{ id: "A1", text: "ERP différents", basis: "Filiales autonomes" }],
      premiseChallenge: null,
    },
    questions: {
      questions: [
        {
          id: "Q1",
          question: "Quels usages ?",
          whyItMatters: "Priorise",
          decisionImpact: "Périmètre",
          defaultAssumption: "Le reporting mensuel",
        },
        {
          id: "Q2",
          question: "Données locales ?",
          whyItMatters: "Architecture",
          decisionImpact: "centralisé vs fédéré",
          defaultAssumption: "Les données RH restent en Allemagne",
        },
      ],
    },
    clarifications: [
      { questionId: "Q1", answer: "Le reporting DG", status: "answered" },
      { questionId: "Q2", answer: "", status: "assumed" },
    ],
    clientNotes: "Budget serré",
    ...overrides,
  };
}
