import { z } from "zod";
import { REFLEXES } from "@/lib/domain/reflexes";
import { caseContains, normalizeForMatch } from "@/lib/prompts/brief";
import { SEVERITIES } from "@/lib/schemas/challenge";
import { REFLEX_IDS, ReflexIdSchema } from "@/lib/schemas/common";
import { TOOL_LIMIT_TEXT, type EngineTool, type EngineToolResult, type EngineToolSet } from "@/lib/engine/types";
import { MAX_REVEAL_PER_TURN } from "./normalize";
import {
  INTERVIEW_TOOL_NAMES,
  type InterviewObservation,
  type InterviewToolName,
  type InterviewTurnInput,
  type ToolTrace,
} from "./schema";

/**
 * The interviewer's tools, implemented once for both live engines (the API loop calls them in process, the CLI
 * reaches them through a local MCP server) and for the replay engine. The model decides when to call them; the
 * code decides what a call may do: which answers exist, how many a reply may give, which quotes are real.
 */

export const INTERVIEW_TOOL_SERVER = "interview";
/** Model round trips with tool calls per reply: most replies need none or one. */
export const MAX_TOOL_ITERATIONS = 4;
/** Calls per reply, whatever their kind; past it every call is refused and the model must answer. */
export const MAX_TOOL_CALLS_PER_TURN = 8;
/** Observations one reply may record; a reflex is noted at most once per interview. */
export const MAX_OBSERVATIONS_PER_TURN = 2;
export const MAX_QUOTE_CHARS = 300;
export const MAX_NOTE_CHARS = 300;

const reflexList = REFLEX_IDS.map((id) => `${id} ${REFLEXES[id].name}`).join("; ");

/** Static, in a fixed order: the tool list opens the cached prompt prefix on the API engine. */
export const INTERVIEW_TOOLS: EngineTool[] = [
  {
    name: "get_client_answer",
    description:
      "Look up in your notes your answer to one of the consultant's questions listed in <client_fact_sheet> (Q1, Q2…). " +
      "Call it before you give that answer, then say it in your own words: never give an answer you have not looked up. " +
      "Calling it counts the answer as given to the candidate, so call it only for an answer you are about to give, " +
      "at most two new answers per reply.",
    inputSchema: {
      type: "object",
      properties: { question_id: { type: "string", description: "The question id, for example Q2." } },
      required: ["question_id"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_fact",
    description:
      "Read one fact of the case (F1, F2…) as <client_fact_sheet> records it, with its exact figures. Use it before you " +
      "repeat a figure you are not sure of. Facts are already in the case: never present one as a new answer.",
    inputSchema: {
      type: "object",
      properties: { fact_id: { type: "string", description: "The fact id, for example F3." } },
      required: ["fact_id"],
      additionalProperties: false,
    },
  },
  {
    name: "check_quote",
    description:
      "Check that some words are the candidate's own, verbatim, before you quote them back to them. " +
      "Tells in which round they wrote them, or that they did not.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "The words to check, copied as you would quote them." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "record_observation",
    description:
      "Privately note a weakness in the candidate's approach, for the debrief that follows the interview. " +
      "One note per weakness for the whole interview. The candidate never sees these notes: never mention them.",
    inputSchema: {
      type: "object",
      properties: {
        reflex: { type: "string", enum: [...REFLEX_IDS], description: `The weakness: ${reflexList}.` },
        severity: {
          type: "string",
          enum: [...SEVERITIES],
          description: "high: an interviewer would not let it pass; medium: it weakens the approach; low: a detail.",
        },
        quote: {
          type: "string",
          description: "The candidate's exact words that show it: a short excerpt copied verbatim from one of their messages.",
        },
        note: { type: "string", description: "What you noticed, in one sentence, in French." },
      },
      required: ["reflex", "severity", "quote", "note"],
      additionalProperties: false,
    },
  },
];

export type InterviewToolSession = EngineToolSet & {
  /** New client answers (Q ids) that get_client_answer gave in this turn, in call order: the turn's reveal. */
  revealed(): string[];
  /** Observations accepted in this turn, stamped with the turn's round. */
  observations(): InterviewObservation[];
  /** Every call of the turn, refused ones included, in order. */
  trace(): ToolTrace[];
  /** Guardrail notes in French, shown discreetly in the interview like normalizeTurn's. */
  notes(): string[];
  /** Counts in the same spirit as the stage checks (booleans as 0 / 1). */
  checks(): Record<string, number>;
};

/** Trace targets stay short: the transcript shows them beside the reply. */
const TARGET_CHARS = 40;

const toolId = z.string().trim().min(1);

/** The tools' input schemas as Zod: the same properties, all required, nothing else. */
const TOOL_INPUTS = {
  get_client_answer: z.strictObject({ question_id: toolId }),
  lookup_fact: z.strictObject({ fact_id: toolId }),
  check_quote: z.strictObject({ text: z.string().trim().min(1) }),
  record_observation: z.strictObject({
    reflex: ReflexIdSchema,
    severity: z.enum(SEVERITIES),
    // An empty quote or note passes here: the tool refuses it with a reason the model can act on.
    quote: z.string().trim(),
    note: z.string().trim(),
  }),
} satisfies Record<InterviewToolName, z.ZodType>;

/** The input property a call's trace shows. */
const TARGET_FIELD: Record<InterviewToolName, string> = {
  get_client_answer: "question_id",
  lookup_fact: "fact_id",
  check_quote: "text",
  record_observation: "reflex",
};

const ANSWER_GUIDANCE =
  "Say it in your own words, giving only what the candidate asked. Leave out any choice that is the consultant's to make.";
const ALREADY_GIVEN =
  "Already given in an earlier reply: recall it in one sentence, without repeating it word for word. It is not a new answer.";
const NOT_VERBATIM =
  "Not verbatim: these words are not in the candidate's messages. Do not attribute them to the candidate.";
const TOO_SHORT = "Too short to check: quote a few more words.";

/** traceOk: false when the call worked but found nothing, so that the trace never shows a failed check as passed. */
type Outcome = { result: EngineToolResult; target: string; traceOk?: boolean };

const ok = (text: string): EngineToolResult => ({ text, isError: false });
const refused = (text: string): EngineToolResult => ({ text, isError: true });

/** Cuts at a word with "…", the ellipsis within the cap; a cut quote still matches, "…" reading as an elision. */
function capAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const atWord = /\s/.test(text[max - 1]) ? head : head.replace(/\s+\S*$/, "");
  return `${(atWord || head).replace(/[\s,;:]+$/, "")}…`;
}

const shortTarget = (text: string) => capAtWord(text.trim().replace(/\s+/g, " "), TARGET_CHARS);

/**
 * caseContains matches nothing without a fragment of 3 characters or more, so such words cannot be checked: the
 * candidate may well have written them. Same split on elisions and same normalization as caseContains.
 */
function tooShortToCheck(words: string): boolean {
  return !words
    .normalize("NFKC")
    .split(/\.{2,}/)
    .map(normalizeForMatch)
    .some((fragment) => fragment.length >= 3);
}

/** The target of a call whose input did not validate: the property as given when it is a string. */
function rawTarget(tool: InterviewToolName, input: unknown): string {
  const value = input && typeof input === "object" ? (input as Record<string, unknown>)[TARGET_FIELD[tool]] : undefined;
  return typeof value === "string" ? shortTarget(value) : "";
}

const describeInputIssues = (issues: { path: PropertyKey[]; message: string }[]) =>
  issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "input"}: ${i.message}`)
    .join("; ");

const plural = (count: number, one: string, many: string) => (count > 1 ? many : one);

/**
 * The tools of one interviewer turn, bound to that turn's inputs. Rules the code enforces:
 * - get_client_answer: the id must be one of the fact sheet's answers (case-insensitive); an answer already given in
 *   an earlier turn is returned again but is not new; at most MAX_REVEAL_PER_TURN new answers per turn.
 * - lookup_fact: the id must be one of the fact sheet's facts.
 * - check_quote: matches with caseContains against each candidate message, and says which round; words too short
 *   for caseContains to match are answered as such, never as not verbatim.
 * - record_observation: the quote must be found with caseContains in one of the candidate's messages (one too short
 *   to check is refused for that reason); a reflex in inputs.notedReflexes or already noted this turn is refused; at
 *   most MAX_OBSERVATIONS_PER_TURN per turn; quote and note are trimmed and capped (MAX_QUOTE_CHARS, MAX_NOTE_CHARS).
 * - Every input is validated (Zod) before it runs; past MAX_TOOL_CALLS_PER_TURN calls, every call is refused.
 * call() never throws, and an unknown tool name is an error result.
 */
export function createInterviewTools(inputs: InterviewTurnInput): InterviewToolSession {
  const { clientAnswers, facts } = inputs.factSheet;
  const answersById = new Map(clientAnswers.map((a) => [a.id.toUpperCase(), a]));
  const factsById = new Map(facts.map((f) => [f.id.toUpperCase(), f]));
  const givenBefore = new Set(inputs.revealed.map((id) => id.toUpperCase()));
  const notedBefore = new Set(inputs.notedReflexes ?? []);
  const candidateMessages = inputs.transcript.filter((m) => m.role === "candidate").map((m) => m.text);

  // The turn's state. call() changes it synchronously, before it returns: calls that arrive together through the
  // MCP server run one after the other and each sees the previous ones.
  const fresh: string[] = [];
  /** Canonical ids of the answers returned this turn, new or recalled: asking again costs nothing. */
  const given = new Set<string>();
  const observations: InterviewObservation[] = [];
  const trace: ToolTrace[] = [];
  /** Upper-cased id → the id as asked, for the notes. */
  const unknownAsked = new Map<string, string>();
  const keptForLater = new Set<string>();
  const checks = {
    toolCalls: 0,
    toolErrors: 0,
    toolBudgetHit: 0,
    revealUnknownCall: 0,
    revealCappedCall: 0,
    revealRepeated: 0,
    factUnknown: 0,
    quoteChecks: 0,
    quoteNotFound: 0,
    quoteTooShort: 0,
    observationsRecorded: 0,
    observationsRejected: 0,
    invalidInput: 0,
  };

  /** The first round (1-based) whose candidate message holds these words, as caseContains matches them. */
  function roundOf(words: string): number | null {
    const index = candidateMessages.findIndex((text) => caseContains(text, words));
    return index < 0 ? null : index + 1;
  }

  function getClientAnswer(questionId: string): Outcome {
    const key = questionId.toUpperCase();
    const answer = answersById.get(key);
    if (!answer) {
      checks.revealUnknownCall++;
      const target = shortTarget(questionId);
      if (!unknownAsked.has(key)) unknownAsked.set(key, target);
      const reason = factsById.has(key)
        ? `${target} is a fact of the case, not one of your answers: read it with lookup_fact.`
        : clientAnswers.length
          ? `No client answer "${target}". Your answers are ${clientAnswers.map((a) => a.id).join(", ")}: one id per call.`
          : `No client answer "${target}": your notes hold none. Say that you do not have it at hand.`;
      return { result: refused(reason), target };
    }
    const text = `${answer.id} — ${answer.question}\nYour answer: ${answer.answer}\n${ANSWER_GUIDANCE}`;
    if (givenBefore.has(key)) {
      if (!given.has(answer.id)) checks.revealRepeated++;
      given.add(answer.id);
      return { result: ok(`${ALREADY_GIVEN}\n${text}`), target: answer.id };
    }
    if (!given.has(answer.id)) {
      // Same cap as normalizeTurn: one catch-all question cannot collect the whole coverage score.
      if (fresh.length >= MAX_REVEAL_PER_TURN) {
        checks.revealCappedCall++;
        keptForLater.add(answer.id);
        return {
          result: refused(
            `You already gave ${MAX_REVEAL_PER_TURN} new answers in this reply: keep ${answer.id} for a later question.`,
          ),
          target: answer.id,
        };
      }
      given.add(answer.id);
      fresh.push(answer.id);
    }
    return { result: ok(text), target: answer.id };
  }

  function lookupFact(factId: string): Outcome {
    const key = factId.toUpperCase();
    const fact = factsById.get(key);
    if (fact) return { result: ok(`${fact.id}: ${fact.text}`), target: fact.id };
    checks.factUnknown++;
    const target = shortTarget(factId);
    // Pointing at get_client_answer would invite a reveal: the model is only told what that call means.
    const reason = answersById.has(key)
      ? `${target} is not a fact but one of your answers: get_client_answer reads it and counts it as given.`
      : facts.length
        ? `No fact "${target}". The facts of the case are ${facts.map((f) => f.id).join(", ")}: one id per call.`
        : `No fact "${target}": the case lists none.`;
    return { result: refused(reason), target };
  }

  function checkQuote(text: string): Outcome {
    checks.quoteChecks++;
    // "Not verbatim" would call the candidate's own short words invented; it is no passed check either.
    if (tooShortToCheck(text)) {
      checks.quoteTooShort++;
      return { result: ok(TOO_SHORT), target: shortTarget(text), traceOk: false };
    }
    const round = roundOf(text);
    if (round === null) checks.quoteNotFound++;
    // Not found is still a successful check: the model learns the words are not the candidate's.
    const verdict = round === null ? NOT_VERBATIM : `Verbatim: the candidate wrote this in round ${round}.`;
    return { result: ok(verdict), target: shortTarget(text), traceOk: round !== null };
  }

  function recordObservation(input: z.output<typeof TOOL_INPUTS.record_observation>): Outcome {
    const { reflex, severity } = input;
    const reject = (reason: string): Outcome => {
      checks.observationsRejected++;
      return { result: refused(reason), target: reflex };
    };
    if (observations.length >= MAX_OBSERVATIONS_PER_TURN) {
      return reject(
        `You already noted ${MAX_OBSERVATIONS_PER_TURN} weaknesses in this reply: note this one later if it still matters.`,
      );
    }
    if (notedBefore.has(reflex)) return reject(`${reflex} is already noted for this interview: one note per weakness.`);
    if (observations.some((o) => o.reflex === reflex)) {
      return reject(`${reflex} is already noted in this reply: one note per weakness.`);
    }
    if (!input.note) return reject("The note is empty: say in one sentence, in French, what you noticed.");
    // The kept excerpt is the one checked, so a stored quote is always the candidate's own words.
    const quote = capAtWord(input.quote, MAX_QUOTE_CHARS);
    if (!quote) return reject("The quote is empty: copy a short excerpt, verbatim, from one of the candidate's messages.");
    if (tooShortToCheck(quote)) return reject(TOO_SHORT);
    if (roundOf(quote) === null) {
      return reject(
        "The quote is not in the candidate's messages: copy a short excerpt, verbatim, from one of their messages.",
      );
    }
    observations.push({ reflex, severity, quote, note: capAtWord(input.note, MAX_NOTE_CHARS), round: inputs.round });
    checks.observationsRecorded++;
    return { result: ok(`Noted (${reflex}).`), target: reflex };
  }

  /** Runs the tool on its validated input; an input the tool's schema refuses never reaches it. */
  function validated<S extends z.ZodType>(
    tool: InterviewToolName,
    schema: S,
    input: unknown,
    handle: (data: z.output<S>) => Outcome,
  ): Outcome {
    const parsed = schema.safeParse(input);
    if (parsed.success) return handle(parsed.data);
    checks.invalidInput++;
    return {
      result: refused(`Invalid input for ${tool}: ${describeInputIssues(parsed.error.issues)}.`),
      target: rawTarget(tool, input),
    };
  }

  function runTool(tool: InterviewToolName, input: unknown): Outcome {
    switch (tool) {
      case "get_client_answer":
        return validated(tool, TOOL_INPUTS.get_client_answer, input, (i) => getClientAnswer(i.question_id));
      case "lookup_fact":
        return validated(tool, TOOL_INPUTS.lookup_fact, input, (i) => lookupFact(i.fact_id));
      case "check_quote":
        return validated(tool, TOOL_INPUTS.check_quote, input, (i) => checkQuote(i.text));
      case "record_observation":
        return validated(tool, TOOL_INPUTS.record_observation, input, recordObservation);
    }
  }

  function run(name: string, input: unknown): EngineToolResult {
    checks.toolCalls++;
    const tool = INTERVIEW_TOOL_NAMES.find((n) => n === name);
    let outcome: Outcome;
    if (checks.toolCalls > MAX_TOOL_CALLS_PER_TURN) {
      checks.toolBudgetHit = 1;
      outcome = { result: refused(TOOL_LIMIT_TEXT), target: tool ? rawTarget(tool, input) : "" };
    } else if (!tool) {
      outcome = {
        result: refused(`Unknown tool "${shortTarget(String(name))}". Your tools: ${INTERVIEW_TOOL_NAMES.join(", ")}.`),
        target: "",
      };
    } else {
      outcome = runTool(tool, input);
    }
    if (outcome.result.isError) checks.toolErrors++;
    // A name outside the four has no place in the trace schema: only the counts keep it.
    if (tool) trace.push({ name: tool, target: outcome.target, ok: !outcome.result.isError && outcome.traceOk !== false });
    return outcome.result;
  }

  return {
    serverName: INTERVIEW_TOOL_SERVER,
    tools: INTERVIEW_TOOLS,
    maxIterations: MAX_TOOL_ITERATIONS,
    call(name, input) {
      try {
        return Promise.resolve(run(name, input));
      } catch (error) {
        // Only an input built to throw (a getter, a proxy) gets here: still a result, never a rejection.
        checks.toolErrors++;
        const tool = INTERVIEW_TOOL_NAMES.find((n) => n === name);
        if (tool) trace.push({ name: tool, target: "", ok: false });
        return Promise.resolve(refused(`The call failed: ${error instanceof Error ? error.message : "unknown error"}.`));
      }
    },
    revealed: () => [...fresh],
    observations: () => observations.map((o) => ({ ...o })),
    trace: () => trace.map((t) => ({ ...t })),
    notes() {
      // Only what the candidate may see: never the observations, never the quote checks.
      const notes: string[] = [];
      if (unknownAsked.size) {
        const ids = [...unknownAsked.values()];
        const asked = plural(ids.length, "Réponse client inconnue demandée", "Réponses client inconnues demandées");
        notes.push(`${asked} : ${ids.join(", ")}.`);
      }
      if (keptForLater.size) {
        const ids = [...keptForLater];
        const kept = plural(ids.length, "gardée", "gardées");
        notes.push(`Plus de ${MAX_REVEAL_PER_TURN} réponses client en un tour : ${ids.join(", ")} ${kept} pour plus tard.`);
      }
      return notes;
    },
    checks: () => ({ ...checks }),
  };
}
