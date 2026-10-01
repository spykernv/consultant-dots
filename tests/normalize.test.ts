import { describe, expect, it } from "vitest";
import { normalizeStage } from "@/lib/pipeline/normalize";
import { priorityScore } from "@/lib/domain/scoring";
import type { StageInputs } from "@/lib/schemas/api";
import type { OptionsAnalysis } from "@/lib/schemas/options";
import { CASE_TEXT, fixture, makeBriefInputs } from "./helpers";

describe("normalizeStage", () => {
  it("demotes facts whose evidence is not in the case and renumbers ids", () => {
    const { data, notes } = normalizeStage(
      "frame",
      {
        ...makeBriefInputs().mapping,
        facts: [
          { id: "F9", text: "3 filiales", evidence: "a 3 filiales" },
          { id: "F9", text: "Budget de 2 M€", evidence: "un budget de 2 M€" },
        ],
        assumptions: [{ id: "A7", text: "ERP différents", basis: "autonomie" }],
      },
      { caseText: CASE_TEXT, classification: makeBriefInputs().classification },
    );
    expect(data.facts).toEqual([{ id: "F1", text: "3 filiales", evidence: "a 3 filiales" }]);
    expect(data.assumptions.map((a) => [a.id, a.text])).toEqual([
      ["A1", "ERP différents"],
      ["A2", "Budget de 2 M€"],
    ]);
    expect(notes).toHaveLength(1);
  });

  it("drops basis ids that do not exist in the brief", () => {
    const { data } = normalizeStage(
      "diagnose",
      {
        framework: [],
        findings: [{ dimension: "Qualité", finding: "Faible", basis: ["F1", "F42", "Q2", "Z1"] }],
        rootCauses: ["Pas de référentiel"],
        keyInsight: "…",
      },
      makeBriefInputs(),
    );
    expect(data.findings[0].basis).toEqual(["F1", "Q2"]);
  });

  it("forces exactly one pilot and a valid recommended option", () => {
    const base = { feasibility: 3, risk: 2, timeToValue: 3, reuse: 3, comment: "" } as const;
    const raw: OptionsAnalysis = {
      options: [
        { id: "O1", name: "Centralisé", description: "", advantages: [], drawbacks: [], conditions: [] },
        { id: "O2", name: "Fédéré", description: "", advantages: [], drawbacks: [], conditions: [] },
      ],
      comparison: { constraints: [], criteria: [] },
      recommendation: { optionId: "O9", statement: "", rationale: "", dependsOn: ["A1", "B2"], pivots: [] },
      targetBlocks: [],
      initiatives: [
        { ...base, name: "Low", value: 2, verdict: "later" },
        { ...base, name: "High", value: 5, verdict: "next" },
      ],
      traps: [
        { reflex: "E8", whyHere: "" },
        { reflex: "E8", whyHere: "doublon" },
      ],
    };
    const inputs = {
      ...makeBriefInputs(),
      diagnostic: { framework: [], findings: [], rootCauses: [], keyInsight: "" },
      currentState: { diagram: { direction: "LR", groups: [], nodes: [], edges: [] }, bottlenecks: [] },
    } satisfies StageInputs["options"];
    const { data } = normalizeStage("options", raw, inputs);
    expect(data.initiatives.filter((i) => i.verdict === "pilot").map((i) => i.name)).toEqual(["High"]);
    expect(data.recommendation.optionId).toBeNull();
    expect(data.recommendation.dependsOn).toEqual(["A1"]);
    expect(data.traps).toHaveLength(1);
  });

  it("aligns the comparison on the options and keeps pivots pointing to another option", () => {
    const option = (id: string) => ({ id, name: id, description: "", advantages: [], drawbacks: [], conditions: [] });
    const raw: OptionsAnalysis = {
      options: [option("O1"), option("O2"), option("O3")],
      comparison: {
        constraints: [
          {
            label: "Données RH restent en Allemagne",
            basis: ["F1", "F99"],
            fits: [
              { optionId: "O3", fit: "pass", note: "agrégats seulement" },
              { optionId: "O1", fit: "fail", note: "tout remonte au centre" },
              { optionId: "O1", fit: "pass", note: "doublon" },
              { optionId: "O7", fit: "pass", note: "option inconnue" },
            ],
          },
          { label: "Sans option connue", basis: [], fits: [{ optionId: "O8", fit: "fail", note: "" }] },
        ],
        criteria: [{ label: "Rapidité", scores: [{ optionId: "O2", score: 3 }, { optionId: "O1", score: 4 }] }],
      },
      recommendation: {
        optionId: "O1",
        statement: "",
        rationale: "",
        dependsOn: [],
        pivots: [
          { basis: "Q2", question: "Données RH dans le périmètre ?", assumed: "Oui", ifInstead: "Non", thenOptionId: "O3", consequence: "" },
          { basis: "Z9", question: "Sponsor DG ?", assumed: "Oui", ifInstead: "Non", thenOptionId: "O1", consequence: "" },
          { basis: "A1", question: "sponsor dg ?", assumed: "Doublon", ifInstead: "", thenOptionId: null, consequence: "" },
        ],
      },
      targetBlocks: [],
      initiatives: [{ name: "Pilote", value: 4, feasibility: 4, risk: 2, timeToValue: 4, reuse: 4, verdict: "pilot", comment: "" }],
      traps: [],
    };
    const inputs = {
      ...makeBriefInputs(),
      diagnostic: { framework: [], findings: [], rootCauses: [], keyInsight: "" },
      currentState: { diagram: { direction: "LR", groups: [], nodes: [], edges: [] }, bottlenecks: [] },
    } satisfies StageInputs["options"];
    const { data, notes } = normalizeStage("options", raw, inputs);

    expect(data.comparison.constraints).toHaveLength(1);
    expect(data.comparison.constraints[0].basis).toEqual(["F1"]);
    expect(data.comparison.constraints[0].fits.map((f) => [f.optionId, f.fit])).toEqual([
      ["O1", "fail"],
      ["O3", "pass"],
    ]);
    expect(data.comparison.criteria[0].scores.map((x) => x.optionId)).toEqual(["O1", "O2"]);
    expect(data.recommendation.pivots.map((p) => [p.basis, p.thenOptionId])).toEqual([
      ["Q2", "O3"],
      ["", null],
    ]);
    expect(notes).toEqual([
      "L'option recommandée ne respecte pas « Données RH restent en Allemagne » dans la comparaison : à justifier ou à revoir.",
    ]);
  });

  it("rounds a 0-1 confidence to a percentage and drops the primary from the secondaries", () => {
    const { data } = normalizeStage(
      "classify",
      { primaryDomain: "genai_ai", secondaryDomains: ["genai_ai", "data_management"], confidence: 0.87, rationale: "" },
      { caseText: CASE_TEXT },
    );
    expect(data.confidence).toBe(87);
    expect(data.secondaryDomains).toEqual(["data_management"]);
  });

  it("sorts challenge flags by severity and drops quotes that are not in the answer", () => {
    const answer = "Je propose de créer un data lake groupe pour centraliser toutes les données.";
    const flag = { interviewerQuestion: "?", issue: "…", fix: "…" };
    const { data, notes } = normalizeStage(
      "challenge",
      {
        level: "a_retravailler",
        verdict: "",
        flags: [
          { ...flag, reflex: "E6", severity: "low", quote: "" },
          { ...flag, reflex: "E1", severity: "high", quote: "créer un data lake groupe" },
          { ...flag, reflex: "E3", severity: "medium", quote: "des API temps réel partout" },
        ],
        strengths: ["a", "b", "c", "d"],
        missing: [],
        nextVersion: [],
      },
      {
        caseText: CASE_TEXT,
        answer,
        classification: null,
        mapping: null,
        diagnostic: null,
        options: null,
        roadmap: null,
      },
    );
    expect(data.flags.map((f) => [f.reflex, f.quote])).toEqual([
      ["E1", "créer un data lake groupe"],
      ["E3", ""],
      ["E6", ""],
    ]);
    expect(data.strengths).toHaveLength(3);
    expect(notes).toHaveLength(1);
  });

  it("names the user's pilot in the roadmap whatever the model wrote", () => {
    const roadmap = fixture("roadmap");
    const inputs = {
      ...makeBriefInputs(),
      diagnostic: fixture("diagnose"),
      options: fixture("options"),
      pilotOverride: { chosen: "Mon pilote", suggested: roadmap.pilot.initiative },
    } satisfies StageInputs["roadmap"];
    expect(normalizeStage("roadmap", roadmap, inputs).data.pilot.initiative).toBe("Mon pilote");
    expect(normalizeStage("roadmap", roadmap, { ...inputs, pilotOverride: null }).data.pilot.initiative).toBe(
      roadmap.pilot.initiative,
    );
  });

  it("scores initiatives with value weighted and risk subtracted", () => {
    expect(priorityScore({ value: 5, feasibility: 4, risk: 2, timeToValue: 5, reuse: 4 })).toBe(21);
  });
});
