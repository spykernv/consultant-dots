import { describe, expect, it } from "vitest";
import { buildCaseBrief, caseContains, normalizeForMatch, sourceOfBasis, splitClientNotes } from "@/lib/prompts/brief";
import { makeBriefInputs } from "./helpers";

describe("caseContains (evidence check)", () => {
  const text = "Le groupe a 3 filiales. Le reporting mensuel prend 10 jours et se fait sous Excel. L’entreprise veut « une vision consolidée ».";
  const [FI, SHY, ZWSP, ZWJ, BOM, NBSP, NNBSP, ACUTE, ACUTE_APOS, MODIFIER_APOS, MINUS] = [
    0xfb01, 0xad, 0x200b, 0x200d, 0xfeff, 0xa0, 0x202f, 0x301, 0xb4, 0x2bc, 0x2212,
  ].map((code) => String.fromCodePoint(code));

  it("matches verbatim excerpts regardless of case, whitespace and apostrophe style", () => {
    expect(caseContains(text, "le reporting  mensuel prend 10 jours")).toBe(true);
    expect(caseContains(text, "L'entreprise veut")).toBe(true);
    expect(caseContains(text, '"une vision consolidée"')).toBe(true);
  });

  it("accepts excerpts elided with an ellipsis when every fragment is present", () => {
    expect(caseContains(text, "Le reporting mensuel … sous Excel")).toBe(true);
    expect(caseContains(text, "Le reporting mensuel … sous SAP")).toBe(false);
  });

  it("accepts the usual French elision marks", () => {
    for (const mark of ["…", "...", "[…]", "[...]", "(…)", "(...)"]) {
      expect(caseContains(text, `Le reporting mensuel ${mark} sous Excel`), mark).toBe(true);
    }
    expect(caseContains(text, "Le reporting mensuel[…]sous Excel")).toBe(true);
  });

  it("requires every elided fragment, in order and as whole words", () => {
    expect(caseContains(text, "sous Excel […] Le reporting mensuel")).toBe(false);
    expect(caseContains(text, "Le reporting mensuel […] zz")).toBe(false);
    expect(caseContains(text, "Le report")).toBe(false);
    expect(caseContains(text, "porting mensuel")).toBe(false);
    expect(caseContains(text, "Le […] a")).toBe(false);
  });

  it("ignores how quotes and guillemets are typed and spaced", () => {
    const quoted = `La DG envisage de «${NNBSP}créer une data platform groupe${NNBSP}».`;
    for (const evidence of [
      "envisage de « créer une data platform groupe »",
      "envisage de «créer une data platform groupe»",
      'envisage de "créer une data platform groupe"',
      "envisage de “créer une data platform groupe”",
    ]) {
      expect(caseContains(quoted, evidence), evidence).toBe(true);
    }
    expect(caseContains('Le DSI souhaite "tout migrer dans le cloud".', "Le DSI souhaite « tout migrer dans le cloud »")).toBe(true);
    expect(caseContains(quoted, 'envisage de "créer un data lake groupe"')).toBe(false);
  });

  it("tolerates text pasted from a PDF or a web page", () => {
    expect(caseContains(`Le groupe a 3 ${FI}liales.`, "a 3 filiales")).toBe(true);
    for (const invisible of [SHY, ZWSP, ZWJ, BOM]) {
      expect(caseContains(`Le groupe a 3 fi${invisible}liales.`, "a 3 filiales")).toBe(true);
    }
    expect(caseContains("Le groupe a 3 fi-\nliales.", "a 3 filiales")).toBe(true);
    expect(caseContains(`Le groupe a 3 fi${SHY}\nliales.`, "a 3 filiales")).toBe(true);
    expect(caseContains("Une data-\nplatform groupe.", "une data-platform groupe")).toBe(true);
    expect(caseContains(`Les coûts${NNBSP}:${NBSP}3${NBSP}M€ par an.`, "Les coûts: 3M€ par an")).toBe(true);
    expect(caseContains(`Une vision consolide${ACUTE}e.`, "une vision consolidée")).toBe(true);
  });

  it("accepts an apostrophe typed as an acute accent or a modifier letter", () => {
    const pasted = `L${ACUTE_APOS}entreprise veut une vision consolidée.`;
    expect(normalizeForMatch(pasted)).toBe("l entreprise veut une vision consolidée");
    expect(caseContains(pasted, "L'entreprise veut une vision")).toBe(true);
    expect(caseContains(pasted, "L’entreprise veut une vision")).toBe(true);
    expect(caseContains(text, `L${ACUTE_APOS}entreprise veut`)).toBe(true);
    expect(caseContains(text, `L${MODIFIER_APOS}entreprise veut`)).toBe(true);
    const answer = `Je propose qu${ACUTE_APOS}on lance un pilote d${ACUTE_APOS}abord sur l${ACUTE_APOS}entité France.`;
    expect(caseContains(answer, "qu'on lance un pilote")).toBe(true);
    expect(caseContains(answer, "d’abord sur l’entité France")).toBe(true);
    expect(caseContains(answer, "qu'on lance un pilote d'abord sur l'entité Allemagne")).toBe(false);
  });

  it("keeps the sign of a number and the comparator before it", () => {
    const figures = "Le chiffre d'affaires a évolué de -12 % en 2024. Le budget doit rester < 1 M€.";
    expect(caseContains(figures, "a évolué de +12 % en 2024")).toBe(false);
    expect(caseContains(figures, "Le budget doit rester > 1 M€")).toBe(false);
    expect(caseContains(figures, "Le budget doit rester ≥ 1 M€")).toBe(false);
    expect(caseContains(`Une baisse de ${MINUS}12 % du CA.`, "Une baisse de +12 % du CA")).toBe(false);
    for (const evidence of [`a évolué de ${MINUS}12 % en 2024`, "a évolué de –12 % en 2024", "Le budget doit rester <1 M€"]) {
      expect(caseContains(figures, evidence), evidence).toBe(true);
    }
    expect(caseContains("Un délai ⩽ 3 mois.", "Un délai <= 3 mois")).toBe(true);
    expect(normalizeForMatch(`de ${MINUS}12 % à +5 %, < 1 M€`)).toBe("de - 12 % à + 5 % < 1 m €");
  });

  it("ignores dashes and brackets that are not a sign", () => {
    expect(normalizeForMatch("Une data-platform 2023-2025, J-30")).toBe("une data platform 2023 2025 j 30");
    expect(caseContains("Périmètre :\n- 3 filiales\n- 2 400 salariés", "Périmètre : 3 filiales")).toBe(true);
    expect(caseContains("La DG – 3 filiales – veut agir.", "La DG, 3 filiales, veut agir")).toBe(true);
    expect(caseContains("Le DSI veut << tout migrer >> d'ici 2 ans.", "Le DSI veut « tout migrer » d'ici 2 ans")).toBe(true);
    expect(caseContains("Objectif -> 30 % de gain.", "Objectif → 30 % de gain")).toBe(true);
  });

  it("keeps œ and the amounts that carry meaning", () => {
    expect(normalizeForMatch("Le CŒUR de métier")).toBe("le cœur de métier");
    expect(caseContains("Un budget de 3 M€ et 25 % de turnover.", "un budget de 3 M$")).toBe(false);
    expect(caseContains("Un budget de 3 M€ et 25 % de turnover.", "et 25 de turnover")).toBe(false);
  });

  it("rejects paraphrases and empty evidence", () => {
    expect(caseContains(text, "le reporting prend deux semaines")).toBe(false);
    expect(caseContains(text, "…")).toBe(false);
  });
});

describe("buildCaseBrief", () => {
  it("uses the client answer when given and the default assumption otherwise", () => {
    const brief = buildCaseBrief(makeBriefInputs());
    expect(brief.clarifications).toEqual([
      { id: "Q1", question: "Quels usages ?", answer: "Le reporting DG", source: "client" },
      { id: "Q2", question: "Données locales ?", answer: "Les données RH restent en Allemagne", source: "assumption" },
    ]);
    expect(brief.clientNotes).toEqual([{ id: "C1", text: "Budget serré" }]);
  });

  it("splits client notes into one id per line", () => {
    expect(splitClientNotes("- a\n\n• b\nc")).toEqual([
      { id: "C1", text: "a" },
      { id: "C2", text: "b" },
      { id: "C3", text: "c" },
    ]);
  });
});

describe("sourceOfBasis", () => {
  const brief = buildCaseBrief(makeBriefInputs());

  it("is only as solid as its weakest basis", () => {
    expect(sourceOfBasis(["F1"], brief)).toBe("case");
    expect(sourceOfBasis(["F1", "Q1"], brief)).toBe("client");
    expect(sourceOfBasis(["F1", "Q2"], brief)).toBe("assumption");
    expect(sourceOfBasis(["F1", "A1"], brief)).toBe("assumption");
    expect(sourceOfBasis([], brief)).toBe("assumption");
  });
});
