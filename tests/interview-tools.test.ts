import { describe, expect, it } from "vitest";
import { TOOL_LIMIT_TEXT } from "@/lib/engine/types";
import { caseContains } from "@/lib/prompts/brief";
import { MAX_REVEAL_PER_TURN } from "@/lib/interview/normalize";
import {
  INTERVIEW_TOOL_NAMES,
  InterviewObservationSchema,
  InterviewTurnInputSchema,
  ToolTraceSchema,
  type FactSheet,
  type InterviewMessage,
  type InterviewTurnInput,
} from "@/lib/interview/schema";
import {
  createInterviewTools,
  INTERVIEW_TOOL_SERVER,
  INTERVIEW_TOOLS,
  MAX_NOTE_CHARS,
  MAX_OBSERVATIONS_PER_TURN,
  MAX_QUOTE_CHARS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_ITERATIONS,
  type InterviewToolSession,
} from "@/lib/interview/tools";
import { SEVERITIES } from "@/lib/schemas/challenge";
import { REFLEX_IDS } from "@/lib/schemas/common";
import { SAMPLE_CASES } from "@/lib/samples";
import { fixture } from "./helpers";

/** The sheet the demo client knows: the frame facts (F1-F8), and the question defaults as its answers (Q1-Q5). */
const factSheet: FactSheet = {
  facts: fixture("frame").facts.map(({ id, text }) => ({ id, text })),
  clientAnswers: fixture("questions").questions.map((q) => ({ id: q.id, question: q.question, answer: q.defaultAssumption })),
};

const OPENING = "Bonjour, je vous écoute : par où voulez-vous commencer ?";

/** The candidate's messages, rounds 1 to 4: typographic apostrophes, guillemets, and one message past the quote cap. */
const CANDIDATE = [
  "Bonjour. Quelles décisions la DG veut-elle prendre avec ces chiffres consolidés ?",
  "Je propose de migrer tout de suite vers un data lake dans le cloud : c’est la solution la plus moderne.",
  "Qui tranche les définitions de KPI, et comment la DG fera-t-elle adopter « un référentiel commun » aux filiales ?",
  "Pour résumer ma démarche : je commence par cadrer les besoins de la DG et des contrôleurs de gestion, puis je recense " +
    "les ERP de chaque filiale et leurs interfaces, je fixe avec le DAF des définitions communes pour la marge, le taux " +
    "de service et l’OTD, je vérifie ce qui doit rester en Allemagne, et seulement ensuite je choisis une architecture, " +
    "en commençant par un pilote sur une filiale pour mesurer le gain sur les dix jours de consolidation avant de " +
    "généraliser au groupe.",
];

function turnInputs(patch: Partial<InterviewTurnInput> = {}): InterviewTurnInput {
  const transcript: InterviewMessage[] = [{ role: "interviewer", text: OPENING }];
  CANDIDATE.forEach((text, i) => {
    if (i > 0) transcript.push({ role: "interviewer", text: "Je vois. Continuez." });
    transcript.push({ role: "candidate", text });
  });
  return {
    caseText: SAMPLE_CASES[0].text,
    factSheet,
    transcript,
    round: CANDIDATE.length,
    maxRounds: 8,
    revealed: [],
    ...patch,
  };
}

const answer = (id: string) => factSheet.clientAnswers.find((a) => a.id === id) as FactSheet["clientAnswers"][number];
const answerText = (id: string) =>
  `${id} — ${answer(id).question}\nYour answer: ${answer(id).answer}\n` +
  "Say it in your own words, giving only what the candidate asked. Leave out any choice that is the consultant's to make.";

const ask = (session: InterviewToolSession, id: string) => session.call("get_client_answer", { question_id: id });
const observe = (session: InterviewToolSession, patch: Record<string, unknown> = {}) =>
  session.call("record_observation", {
    reflex: "E1",
    severity: "high",
    quote: "migrer tout de suite vers un data lake",
    note: "Il propose une architecture avant d'avoir compris le besoin.",
    ...patch,
  });

/** What a quote too short for caseContains gets, from check_quote and record_observation alike. */
const TOO_SHORT = "Too short to check: quote a few more words.";

const CHECK_KEYS = [
  "toolCalls",
  "toolErrors",
  "toolBudgetHit",
  "revealUnknownCall",
  "revealCappedCall",
  "revealRepeated",
  "factUnknown",
  "quoteChecks",
  "quoteNotFound",
  "quoteTooShort",
  "observationsRecorded",
  "observationsRejected",
  "invalidInput",
];

describe("interview tools: the contract", () => {
  it("uses inputs a real turn could send", () => {
    expect(InterviewTurnInputSchema.parse(turnInputs())).toBeTruthy();
    expect(CANDIDATE[3].length).toBeGreaterThan(MAX_QUOTE_CHARS);
  });

  it("lists the four tools in the schema's order, under the interview server", () => {
    expect(INTERVIEW_TOOLS.map((t) => t.name)).toEqual([...INTERVIEW_TOOL_NAMES]);
    const session = createInterviewTools(turnInputs());
    expect(session.serverName).toBe(INTERVIEW_TOOL_SERVER);
    expect(INTERVIEW_TOOL_SERVER).toBe("interview");
    expect(session.tools).toBe(INTERVIEW_TOOLS);
    expect(session.maxIterations).toBe(MAX_TOOL_ITERATIONS);
  });

  it("declares strict input schemas: objects, every property a described string and required, nothing else", () => {
    for (const tool of INTERVIEW_TOOLS) {
      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, { type: string; description?: string }>;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.type, tool.name).toBe("object");
      expect(schema.additionalProperties, tool.name).toBe(false);
      expect([...schema.required].sort(), tool.name).toEqual(Object.keys(schema.properties).sort());
      for (const [key, property] of Object.entries(schema.properties)) {
        expect(property.type, `${tool.name}.${key}`).toBe("string");
        expect(property.description, `${tool.name}.${key}`).toBeTruthy();
      }
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
    }
    const observation = INTERVIEW_TOOLS[3].inputSchema as { properties: Record<string, { enum?: string[] }> };
    expect(observation.properties.reflex.enum).toEqual([...REFLEX_IDS]);
    expect(observation.properties.severity.enum).toEqual([...SEVERITIES]);
  });

  it("starts every turn with all the counts at zero", () => {
    const checks = createInterviewTools(turnInputs()).checks();
    expect(Object.keys(checks).sort()).toEqual([...CHECK_KEYS].sort());
    expect(Object.values(checks).every((n) => n === 0)).toBe(true);
  });
});

describe("get_client_answer", () => {
  it("gives an answer by its id, matched case-insensitively, under the fact sheet's id", async () => {
    const session = createInterviewTools(turnInputs());
    const result = await ask(session, " q2 ");
    expect(result).toEqual({ text: answerText("Q2"), isError: false });
    expect(session.revealed()).toEqual(["Q2"]);
    expect(session.trace()).toEqual([{ name: "get_client_answer", target: "Q2", ok: true }]);
    expect(session.notes()).toEqual([]);
  });

  it("keeps the fact sheet's spelling of an id", async () => {
    const sheet: FactSheet = { ...factSheet, clientAnswers: [{ id: "q7", question: "Quel budget ?", answer: "Deux millions." }] };
    const session = createInterviewTools(turnInputs({ factSheet: sheet }));
    expect((await ask(session, "Q7")).isError).toBe(false);
    expect(session.revealed()).toEqual(["q7"]);
  });

  it("refuses an unknown id, lists the known ones, and notes it for the candidate", async () => {
    const session = createInterviewTools(turnInputs());
    const result = await ask(session, "Q9");
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"Q9"');
    expect(result.text).toContain("Q1, Q2, Q3, Q4, Q5");
    expect(session.revealed()).toEqual([]);
    expect(session.notes()).toEqual(["Réponse client inconnue demandée : Q9."]);
    expect(session.trace()).toEqual([{ name: "get_client_answer", target: "Q9", ok: false }]);
    expect(session.checks()).toMatchObject({ revealUnknownCall: 1, toolErrors: 1, toolCalls: 1 });

    // Each unknown id once in the notes, however often it is asked; every call is counted.
    await ask(session, "q9");
    await ask(session, "Q12");
    expect(session.notes()).toEqual(["Réponses client inconnues demandées : Q9, Q12."]);
    expect(session.checks().revealUnknownCall).toBe(3);
  });

  it("sends a fact id back to lookup_fact without revealing anything", async () => {
    const session = createInterviewTools(turnInputs());
    const result = await ask(session, "F3");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("lookup_fact");
    expect(session.revealed()).toEqual([]);
    expect(session.checks().revealUnknownCall).toBe(1);
  });

  it("says when the sheet holds no answers at all", async () => {
    const session = createInterviewTools(turnInputs({ factSheet: { ...factSheet, clientAnswers: [] } }));
    const result = await ask(session, "Q1");
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/do not have it at hand/);
  });

  it("returns an answer given in an earlier turn as a reminder, not as a new answer", async () => {
    const session = createInterviewTools(turnInputs({ revealed: ["Q1", "Q2"] }));
    const result = await ask(session, "q1");
    expect(result.isError).toBe(false);
    const [first, ...rest] = result.text.split("\n");
    expect(first).toMatch(/earlier reply.*one sentence.*not a new answer/i);
    expect(rest.join("\n")).toBe(answerText("Q1"));
    expect(session.revealed()).toEqual([]);
    expect(session.checks().revealRepeated).toBe(1);

    // Recalling costs nothing: two new answers still fit in the turn, and a repeat is counted once.
    await ask(session, "Q1");
    await ask(session, "Q2");
    expect((await ask(session, "Q3")).isError).toBe(false);
    expect((await ask(session, "Q4")).isError).toBe(false);
    expect(session.revealed()).toEqual(["Q3", "Q4"]);
    expect(session.checks()).toMatchObject({ revealRepeated: 2, revealCappedCall: 0 });
  });

  it("answers the same id twice in a turn with the same text, counted once", async () => {
    const session = createInterviewTools(turnInputs());
    const first = await ask(session, "Q2");
    const second = await ask(session, "q2");
    expect(second).toEqual(first);
    expect(session.revealed()).toEqual(["Q2"]);
    expect(session.trace()).toHaveLength(2);
    // The repeat does not use the cap.
    expect((await ask(session, "Q3")).isError).toBe(false);
    expect(session.revealed()).toEqual(["Q2", "Q3"]);
  });

  it(`gives at most ${MAX_REVEAL_PER_TURN} new answers per turn and notes the ones kept for later`, async () => {
    expect(MAX_REVEAL_PER_TURN).toBe(2);
    const session = createInterviewTools(turnInputs());
    await ask(session, "Q1");
    await ask(session, "Q2");
    const capped = await ask(session, "Q3");
    expect(capped.isError).toBe(true);
    expect(capped.text).toMatch(/2 new answers.*keep Q3 for a later question/);
    expect(session.revealed()).toEqual(["Q1", "Q2"]);
    expect(session.notes()).toEqual(["Plus de 2 réponses client en un tour : Q3 gardée pour plus tard."]);

    // An answer of this turn may still be repeated; every other new one is refused.
    expect((await ask(session, "Q1")).isError).toBe(false);
    expect((await ask(session, "q3")).isError).toBe(true);
    expect((await ask(session, "Q4")).isError).toBe(true);
    expect(session.revealed()).toEqual(["Q1", "Q2"]);
    expect(session.notes()).toEqual(["Plus de 2 réponses client en un tour : Q3, Q4 gardées pour plus tard."]);
    expect(session.checks()).toMatchObject({ revealCappedCall: 3, toolErrors: 3 });
    expect(session.trace().map((t) => `${t.target}:${t.ok}`)).toEqual([
      "Q1:true",
      "Q2:true",
      "Q3:false",
      "Q1:true",
      "Q3:false",
      "Q4:false",
    ]);
  });

  it("caps answers given together, as the MCP server may deliver the calls at once", async () => {
    const session = createInterviewTools(turnInputs());
    const results = await Promise.all(["Q1", "Q2", "Q3", "Q4"].map((id) => ask(session, id)));
    expect(results.map((r) => r.isError)).toEqual([false, false, true, true]);
    expect(session.revealed()).toEqual(["Q1", "Q2"]);
  });

  it("changes the state before the call's promise settles", async () => {
    const session = createInterviewTools(turnInputs());
    const pending = ask(session, "Q5");
    expect(session.revealed()).toEqual(["Q5"]);
    expect(session.checks().toolCalls).toBe(1);
    await pending;
  });
});

describe("lookup_fact", () => {
  it("reads a fact by its id, case-insensitively, and never reveals it", async () => {
    const session = createInterviewTools(turnInputs());
    const result = await session.call("lookup_fact", { fact_id: " f3 " });
    expect(result).toEqual({ text: "F3: Les définitions des KPIs varient selon la filiale", isError: false });
    expect(session.revealed()).toEqual([]);
    expect(session.trace()).toEqual([{ name: "lookup_fact", target: "F3", ok: true }]);
  });

  it("refuses an unknown fact, lists the known ones, and keeps it out of the candidate's notes", async () => {
    const session = createInterviewTools(turnInputs());
    const result = await session.call("lookup_fact", { fact_id: "F99" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("F1, F2, F3, F4, F5, F6, F7, F8");
    expect(session.checks().factUnknown).toBe(1);
    expect(session.trace()).toEqual([{ name: "lookup_fact", target: "F99", ok: false }]);
    expect(session.notes()).toEqual([]);
  });

  it("refuses a client answer's id, saying what reading it would mean", async () => {
    const session = createInterviewTools(turnInputs());
    const result = await session.call("lookup_fact", { fact_id: "Q1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/get_client_answer.*counts it as given/);
    expect(result.text).not.toContain(answer("Q1").answer);
    expect(session.revealed()).toEqual([]);
  });

  it("says when the case lists no facts", async () => {
    const session = createInterviewTools(turnInputs({ factSheet: { ...factSheet, facts: [] } }));
    const result = await session.call("lookup_fact", { fact_id: "F1" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/lists none/);
  });
});

describe("check_quote", () => {
  const check = async (text: string, session = createInterviewTools(turnInputs())) =>
    (await session.call("check_quote", { text })).text;
  const inRound = (round: number) => `Verbatim: the candidate wrote this in round ${round}.`;
  const NOT_VERBATIM =
    "Not verbatim: these words are not in the candidate's messages. Do not attribute them to the candidate.";

  it("finds the candidate's words whatever the case, spacing, apostrophes, guillemets or accent encoding", async () => {
    expect(await check("je propose de migrer tout de suite")).toBe(inRound(2));
    expect(await check("C'EST LA SOLUTION LA PLUS MODERNE")).toBe(inRound(2));
    expect(await check("migrer  tout de suite\nvers un   data lake")).toBe(inRound(2));
    expect(await check('adopter "un référentiel commun"')).toBe(inRound(3));
    expect(await check("adopter « un référentiel commun »")).toBe(inRound(3));
    expect(await check("le taux de service et l'OTD")).toBe(inRound(4));
  });

  it("accepts a quote elided with an ellipsis when every fragment is there, in order", async () => {
    expect(await check("Je propose de migrer ... dans le cloud")).toBe(inRound(2));
    expect(await check("Je propose de migrer […] la plus moderne")).toBe(inRound(2));
    expect(await check("dans le cloud … Je propose de migrer")).toBe(NOT_VERBATIM);
  });

  it("names the first round that holds the words, counting only the candidate's messages", async () => {
    expect(await check("la DG")).toBe(inRound(1));
    expect(await check("Qui tranche les définitions de KPI")).toBe(inRound(3));
  });

  it("answers a check that fails as a result, not an error, and counts it", async () => {
    const session = createInterviewTools(turnInputs());
    const paraphrase = await session.call("check_quote", { text: "Je veux tout mettre dans le cloud" });
    expect(paraphrase).toEqual({ text: NOT_VERBATIM, isError: false });
    // The client's own words are not the candidate's.
    expect(await check("je vous écoute", session)).toBe(NOT_VERBATIM);
    expect(await check("la DG", session)).toBe(inRound(1));
    expect(session.checks()).toMatchObject({ quoteChecks: 3, quoteNotFound: 2, toolErrors: 0 });
    // The transcript shows a passed check as « citation vérifiée »: a quote not found is not one.
    expect(session.trace().map((t) => t.ok)).toEqual([false, false, true]);
    expect(session.notes()).toEqual([]);
  });

  it("says words too short to match are too short to check, not that the candidate never wrote them", async () => {
    // "DG" is the candidate's (round 1), but caseContains needs a fragment of 3 characters.
    expect(CANDIDATE[0]).toContain("DG");
    expect(caseContains(CANDIDATE[0], "DG")).toBe(false);
    const session = createInterviewTools(turnInputs());
    expect(await session.call("check_quote", { text: "DG" })).toEqual({ text: TOO_SHORT, isError: false });
    // Every fragment counts after the same normalization: guillemets, elision and case do not lengthen it.
    expect(await check("« la » … dg !", session)).toBe(TOO_SHORT);
    expect(await check("...", session)).toBe(TOO_SHORT);
    // One fragment long enough and the words are checked as usual.
    expect(await check("la DG", session)).toBe(inRound(1));
    expect(await check("la … DG veut", session)).toBe(inRound(1));
    expect(await check("ok … la cible", session)).toBe(NOT_VERBATIM);
    expect(session.checks()).toMatchObject({ quoteChecks: 6, quoteTooShort: 3, quoteNotFound: 1, toolErrors: 0 });
    // Not a passed check: the transcript does not show it as « citation vérifiée ».
    expect(session.trace().map((t) => t.ok)).toEqual([false, false, false, true, true, false]);
    expect(session.trace()[0]).toEqual({ name: "check_quote", target: "DG", ok: false });
  });

  it("traces the first words of the quote, cut at a word", async () => {
    const session = createInterviewTools(turnInputs());
    await session.call("check_quote", { text: `  ${CANDIDATE[3]}  ` });
    await session.call("check_quote", { text: "la DG" });
    const [long, short] = session.trace();
    expect(long.target.length).toBeLessThanOrEqual(40);
    expect(long.target).toBe("Pour résumer ma démarche : je commence…");
    expect(CANDIDATE[3].startsWith(long.target.slice(0, -1))).toBe(true);
    expect(short).toEqual({ name: "check_quote", target: "la DG", ok: true });
  });
});

describe("record_observation", () => {
  it("keeps an observation whose quote is the candidate's, stamped with the round", async () => {
    const session = createInterviewTools(turnInputs({ round: 4 }));
    const result = await observe(session, {
      quote: "  migrer tout de suite vers un data lake  ",
      note: "  Il propose une architecture avant d'avoir compris le besoin.  ",
    });
    expect(result).toEqual({ text: "Noted (E1).", isError: false });
    const observations = session.observations();
    expect(observations).toEqual([
      {
        reflex: "E1",
        severity: "high",
        quote: "migrer tout de suite vers un data lake",
        note: "Il propose une architecture avant d'avoir compris le besoin.",
        round: 4,
      },
    ]);
    expect(InterviewObservationSchema.parse(observations[0])).toEqual(observations[0]);
    expect(session.trace()).toEqual([{ name: "record_observation", target: "E1", ok: true }]);
    expect(session.checks()).toMatchObject({ observationsRecorded: 1, observationsRejected: 0 });
  });

  it("accepts a quote as caseContains reads it, and stores it as the model wrote it", async () => {
    const session = createInterviewTools(turnInputs());
    expect((await observe(session, { quote: "c'est la solution ... moderne" })).isError).toBe(false);
    expect(session.observations()[0].quote).toBe("c'est la solution ... moderne");
  });

  it("refuses a quote that is not the candidate's", async () => {
    const session = createInterviewTools(turnInputs());
    const invented = await observe(session, { quote: "le cloud règle tout" });
    expect(invented.isError).toBe(true);
    expect(invented.text).toMatch(/not in the candidate's messages/);
    const clientWords = await observe(session, { quote: "par où voulez-vous commencer" });
    expect(clientWords.isError).toBe(true);
    const empty = await observe(session, { quote: "   " });
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/quote is empty/);
    expect(session.observations()).toEqual([]);
    expect(session.checks()).toMatchObject({ observationsRecorded: 0, observationsRejected: 3, invalidInput: 0 });
    expect(session.trace().map((t) => t.ok)).toEqual([false, false, false]);
  });

  it("refuses a quote too short to check, saying so rather than calling it invented", async () => {
    const session = createInterviewTools(turnInputs());
    for (const quote of ["DG", "« la » ... DG"]) {
      expect(await observe(session, { quote })).toEqual({ text: TOO_SHORT, isError: true });
    }
    expect(session.observations()).toEqual([]);
    expect(session.checks()).toMatchObject({ observationsRejected: 2, quoteTooShort: 0, invalidInput: 0 });
    expect(session.trace()).toEqual([
      { name: "record_observation", target: "E1", ok: false },
      { name: "record_observation", target: "E1", ok: false },
    ]);
    // A few more words of the same message are the candidate's, and pass.
    expect((await observe(session, { quote: "la DG veut-elle" })).isError).toBe(false);
  });

  it("notes a weakness once: not twice in a turn, not again after an earlier turn", async () => {
    const session = createInterviewTools(turnInputs({ notedReflexes: ["E4"] }));
    expect((await observe(session)).isError).toBe(false);
    const again = await observe(session, { severity: "low", quote: "data lake" });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/E1 is already noted in this reply/);
    const earlier = await observe(session, { reflex: "E4", quote: "Qui tranche les définitions de KPI" });
    expect(earlier.isError).toBe(true);
    expect(earlier.text).toMatch(/E4 is already noted for this interview/);
    expect(session.observations().map((o) => o.reflex)).toEqual(["E1"]);
    expect(session.checks().observationsRejected).toBe(2);
  });

  it(`records at most ${MAX_OBSERVATIONS_PER_TURN} observations per turn`, async () => {
    expect(MAX_OBSERVATIONS_PER_TURN).toBe(2);
    const session = createInterviewTools(turnInputs());
    expect((await observe(session)).isError).toBe(false);
    expect((await observe(session, { reflex: "E3", severity: "medium", quote: "data lake dans le cloud" })).isError).toBe(false);
    const third = await observe(session, { reflex: "E5", severity: "low", quote: "comment la DG fera-t-elle adopter" });
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/already noted 2 weaknesses in this reply/);
    expect(session.observations().map((o) => o.reflex)).toEqual(["E1", "E3"]);
    expect(session.checks()).toMatchObject({ observationsRecorded: 2, observationsRejected: 1 });
  });

  it("refuses an empty note", async () => {
    const session = createInterviewTools(turnInputs());
    const result = await observe(session, { note: "  \n " });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/note is empty/);
    expect(session.observations()).toEqual([]);
  });

  it("caps a long quote and a long note at a word, and the kept quote is still the candidate's", async () => {
    const session = createInterviewTools(turnInputs());
    const longNote = "Une remarque trop longue. ".repeat(30);
    const result = await observe(session, { reflex: "E7", quote: CANDIDATE[3], note: longNote });
    expect(result.isError).toBe(false);
    const [{ quote, note }] = session.observations();
    expect(quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(quote.endsWith("…")).toBe(true);
    expect(CANDIDATE[3].startsWith(quote.slice(0, -1))).toBe(true);
    // Cut between two words, never inside one.
    expect(CANDIDATE[3][quote.length - 1]).toMatch(/[\s,]/);
    expect(caseContains(CANDIDATE[3], quote)).toBe(true);
    expect(note.length).toBeLessThanOrEqual(MAX_NOTE_CHARS);
    expect(note.endsWith("…")).toBe(true);
    expect(longNote.startsWith(note.slice(0, -1))).toBe(true);
    expect(longNote[note.length - 1]).toBe(" ");
  });

  it("never shows the observations or the quote checks in the candidate's notes", async () => {
    const session = createInterviewTools(turnInputs({ notedReflexes: ["E2"] }));
    await observe(session);
    await observe(session, { reflex: "E2" });
    await observe(session, { reflex: "E3", quote: "une phrase inventée de toutes pièces" });
    await observe(session, { reflex: "E42" });
    await session.call("check_quote", { text: "une phrase inventée de toutes pièces" });
    await session.call("lookup_fact", { fact_id: "F99" });
    expect(session.notes()).toEqual([]);

    await ask(session, "Q9");
    expect(session.notes()).toEqual(["Réponse client inconnue demandée : Q9."]);
  });
});

describe("every call", () => {
  const VALID: Record<string, Record<string, string>> = {
    get_client_answer: { question_id: "Q1" },
    lookup_fact: { fact_id: "F1" },
    check_quote: { text: "la DG" },
    record_observation: { reflex: "E1", severity: "high", quote: "data lake", note: "Solution d'abord." },
  };

  it("validates its input against the tool's schema, without running the tool", async () => {
    for (const tool of INTERVIEW_TOOLS) {
      const valid = VALID[tool.name];
      expect((await createInterviewTools(turnInputs()).call(tool.name, valid)).isError, tool.name).toBe(false);

      const required = (tool.inputSchema as { required: string[] }).required;
      for (const key of required) {
        const session = createInterviewTools(turnInputs());
        const missing = Object.fromEntries(Object.entries(valid).filter(([k]) => k !== key));
        const result = await session.call(tool.name, missing);
        expect(result.isError, `${tool.name} without ${key}`).toBe(true);
        expect(result.text, `${tool.name} without ${key}`).toContain(`Invalid input for ${tool.name}: ${key}:`);
        expect(session.checks()).toMatchObject({ invalidInput: 1, toolErrors: 1 });
      }

      const extra = createInterviewTools(turnInputs());
      expect((await extra.call(tool.name, { ...valid, extra: "x" })).text, tool.name).toMatch(/Unrecognized key/);
      for (const notAnObject of ["Q1", null, undefined, 42, ["Q1"]]) {
        const result = await extra.call(tool.name, notAnObject);
        expect(result.isError, `${tool.name} ${JSON.stringify(notAnObject)}`).toBe(true);
        expect(result.text).toMatch(/expected object/);
      }
      expect(extra.checks().invalidInput).toBe(6);
      expect(extra.revealed()).toEqual([]);
      expect(extra.observations()).toEqual([]);
    }
  });

  it("refuses wrong enums, wrong types and blank ids, tracing what was given", async () => {
    const session = createInterviewTools(turnInputs());
    const reflex = await observe(session, { reflex: "E42" });
    expect(reflex.text).toMatch(/^Invalid input for record_observation: reflex:/);
    const severity = await observe(session, { severity: "critical" });
    expect(severity.text).toMatch(/severity:/);
    expect((await ask(session, "   ")).text).toMatch(/question_id:/);
    expect((await session.call("lookup_fact", { fact_id: 3 })).text).toMatch(/fact_id:.*expected string/);
    expect((await session.call("check_quote", { text: "" })).isError).toBe(true);
    expect(session.checks()).toMatchObject({ invalidInput: 5, toolErrors: 5, observationsRejected: 0, revealUnknownCall: 0 });
    expect(session.trace()).toEqual([
      { name: "record_observation", target: "E42", ok: false },
      { name: "record_observation", target: "E1", ok: false },
      { name: "get_client_answer", target: "", ok: false },
      { name: "lookup_fact", target: "", ok: false },
      { name: "check_quote", target: "", ok: false },
    ]);
    expect(session.notes()).toEqual([]);
  });

  it("answers an unknown tool with an error, kept out of the trace", async () => {
    const session = createInterviewTools(turnInputs());
    const result = await session.call("send_email", { to: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"send_email"');
    expect(result.text).toContain(INTERVIEW_TOOL_NAMES.join(", "));
    expect(session.trace()).toEqual([]);
    expect(session.checks()).toMatchObject({ toolCalls: 1, toolErrors: 1, invalidInput: 0 });
  });

  it(`refuses every call past ${MAX_TOOL_CALLS_PER_TURN} in a turn, whatever it asks`, async () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(8);
    const session = createInterviewTools(turnInputs());
    await session.call("nope", {});
    await session.call("lookup_fact", {});
    for (let i = 0; i < 6; i++) expect((await session.call("lookup_fact", { fact_id: "F1" })).isError).toBe(false);
    expect(session.checks().toolBudgetHit).toBe(0);

    const ninth = await ask(session, "Q1");
    expect(ninth).toEqual({ text: TOOL_LIMIT_TEXT, isError: true });
    expect(session.revealed()).toEqual([]);
    expect(await observe(session)).toEqual({ text: TOOL_LIMIT_TEXT, isError: true });
    expect(await session.call("nope", {})).toEqual({ text: TOOL_LIMIT_TEXT, isError: true });
    expect(session.observations()).toEqual([]);
    expect(session.checks()).toMatchObject({ toolCalls: 11, toolErrors: 5, toolBudgetHit: 1, invalidInput: 1 });
    expect(session.trace().slice(-2)).toEqual([
      { name: "get_client_answer", target: "Q1", ok: false },
      { name: "record_observation", target: "E1", ok: false },
    ]);
    expect(session.trace()).toHaveLength(9);
  });

  it("never throws, even on an input built to throw", async () => {
    const session = createInterviewTools(turnInputs());
    const hostile = {
      get question_id(): string {
        throw new Error("boom");
      },
    };
    const result = await session.call("get_client_answer", hostile);
    expect(result.isError).toBe(true);
    expect(session.checks()).toMatchObject({ toolCalls: 1, toolErrors: 1 });
    expect(session.trace()).toEqual([{ name: "get_client_answer", target: "", ok: false }]);
    expect((await ask(session, "Q1")).isError).toBe(false);
    expect(session.revealed()).toEqual(["Q1"]);
  });

  it("keeps each turn's state to itself and hands out copies", async () => {
    const first = createInterviewTools(turnInputs());
    const second = createInterviewTools(turnInputs());
    await ask(first, "Q1");
    await observe(first);
    expect(second.revealed()).toEqual([]);
    expect(second.observations()).toEqual([]);

    first.revealed().push("Q5");
    first.observations()[0].quote = "changé";
    first.trace().pop();
    first.checks().toolCalls = 99;
    expect(first.revealed()).toEqual(["Q1"]);
    expect(first.observations()[0].quote).toBe("migrer tout de suite vers un data lake");
    expect(first.trace()).toHaveLength(2);
    expect(first.checks().toolCalls).toBe(2);
  });

  it("produces traces the transcript schema accepts, and counts every kind of call", async () => {
    const session = createInterviewTools(turnInputs({ revealed: ["Q1"], notedReflexes: ["E2"] }));
    await ask(session, "Q1");
    await ask(session, "Q2");
    await session.call("lookup_fact", { fact_id: "F2" });
    await session.call("check_quote", { text: "la DG" });
    await session.call("check_quote", { text: "une phrase inventée" });
    await observe(session);
    await observe(session, { reflex: "E2" });
    await session.call("lookup_fact", { fact_id: "X" });
    for (const trace of session.trace()) expect(ToolTraceSchema.parse(trace)).toEqual(trace);
    expect(session.checks()).toEqual({
      toolCalls: 8,
      toolErrors: 2,
      toolBudgetHit: 0,
      revealUnknownCall: 0,
      revealCappedCall: 0,
      revealRepeated: 1,
      factUnknown: 1,
      quoteChecks: 2,
      quoteNotFound: 1,
      quoteTooShort: 0,
      observationsRecorded: 1,
      observationsRejected: 1,
      invalidInput: 0,
    });
    expect(session.revealed()).toEqual(["Q2"]);
  });
});
