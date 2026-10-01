import type { InterviewAction, InterviewTurnInput, InterviewTurnOutput } from "./schema";

/** The client may not end the interview before this round: two exchanges are too few to judge a candidate. */
export const MIN_CLOSE_ROUND = 3;
export const MAX_REPLY_CHARS = 700;
/** New client answers one turn may credit: more would let a single catch-all question collect the whole coverage score. */
export const MAX_REVEAL_PER_TURN = 2;

const FALLBACK_REPLY = "Je vous écoute : poursuivez, s'il vous plaît.";
const CONTINUE_REPLY = "Avant de conclure, j'aimerais aller un peu plus loin avec vous : poursuivez, s'il vous plaît.";
const CLOSING_REPLY = "Nous allons devoir nous arrêter là : merci pour cet échange.";

export type NormalizedTurn = {
  data: InterviewTurnOutput;
  notes: string[];
  /** Same role as the stage checks: what the guardrails caught, as counts (booleans are 0 / 1). */
  checks: Record<string, number>;
};

/** Cuts at the last sentence end inside the cap when that keeps at least half of it, otherwise at a word, with "…". */
function capReply(text: string, max = MAX_REPLY_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  let end = -1;
  for (const m of head.matchAll(/[.!?…][»"”)]?(?=\s|$)/g)) end = m.index + m[0].length;
  if (end >= max / 2) return head.slice(0, end).trim();
  const space = head.lastIndexOf(" ");
  return `${head.slice(0, space > 0 ? space : max).trimEnd()}…`;
}

/** A closing reply asks nothing, since the candidate can no longer answer: its sentences ending in "?" go. */
function withoutQuestions(text: string): string {
  return text
    .split(/(?<=[.!?…][»"”)]?)\s+/)
    .filter((sentence) => !/\?[»"”)]?$/.test(sentence))
    .join(" ")
    .trim();
}

// Small numbers written out in the sources ("trois filiales") back a "3" in the reply.
const NUMBER_WORDS: Record<string, string> = {
  deux: "2",
  trois: "3",
  quatre: "4",
  cinq: "5",
  six: "6",
  sept: "7",
  huit: "8",
  neuf: "9",
  dix: "10",
  onze: "11",
  douze: "12",
  quinze: "15",
  vingt: "20",
  trente: "30",
  quarante: "40",
  cinquante: "50",
  cent: "100",
  mille: "1000",
};

/** Numbers written in digits, as values: French thousands separators dropped, decimal commas read ("15 000" → 15000, "1,2" → 1.2). */
function numbersIn(text: string): { raw: string; value: string }[] {
  const joined = text.normalize("NFKC").replace(/(\d)[\s.](?=\d{3}(?!\d))/g, "$1");
  return (joined.match(/\d+(?:[.,]\d+)?/g) ?? []).map((raw) => ({ raw, value: String(Number(raw.replace(",", "."))) }));
}

// Read in the sources, not in the reply: there they are rarely figures ("les deux", "neuf" for new, "pour cent").
const AMBIGUOUS_WORDS = new Set(["deux", "neuf", "cent"]);

/** The figures of a reply, in digits or written out ("douze usines"), as value → how the reply wrote it. */
function replyNumbers(reply: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const n of numbersIn(reply)) if (!found.has(n.value)) found.set(n.value, n.raw);
  for (const word of reply.toLowerCase().match(/\p{L}+/gu) ?? []) {
    const value = NUMBER_WORDS[word];
    if (value && !AMBIGUOUS_WORDS.has(word) && !found.has(value)) found.set(value, word);
  }
  return found;
}

function sourcedNumbers(texts: string[]): Set<string> {
  const values = new Set<string>();
  for (const text of texts) {
    for (const n of numbersIn(text)) values.add(n.value);
    for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      if (NUMBER_WORDS[word]) values.add(NUMBER_WORDS[word]);
    }
  }
  return values;
}

/**
 * The code-side rules of one interviewer turn: only known client answers are revealed, the reply stays short,
 * and the code, not the model, decides when the interview may or must end.
 */
export function normalizeTurn(output: InterviewTurnOutput, inputs: InterviewTurnInput): NormalizedTurn {
  const notes: string[] = [];
  const checks: Record<string, number> = {
    revealUnknown: 0,
    revealCapped: 0,
    replyEmpty: 0,
    replyTruncated: 0,
    extraQuestions: 0,
    closeRefused: 0,
    closeForced: 0,
    doneIgnored: 0,
    closingQuestions: 0,
    unsourcedNumbers: 0,
  };

  const byId = new Map(inputs.factSheet.clientAnswers.map((a) => [a.id.toUpperCase(), a.id]));
  let reveal: string[] = [];
  const unknown = new Set<string>();
  for (const raw of output.reveal) {
    const key = raw.trim();
    if (!key) continue;
    const id = byId.get(key.toUpperCase());
    if (!id) unknown.add(key);
    else if (!reveal.includes(id)) reveal.push(id);
  }
  if (unknown.size) {
    checks.revealUnknown = unknown.size;
    notes.push(`Réponse client inconnue ignorée : ${[...unknown].join(", ")}.`);
  }
  // Answers given in earlier turns stay; only the new ones are capped, in the model's order.
  const fresh = reveal.filter((id) => !inputs.revealed.includes(id));
  if (fresh.length > MAX_REVEAL_PER_TURN) {
    const dropped = fresh.slice(MAX_REVEAL_PER_TURN);
    reveal = reveal.filter((id) => !dropped.includes(id));
    checks.revealCapped = dropped.length;
    notes.push(`Plus de ${MAX_REVEAL_PER_TURN} réponses client en un tour : ${dropped.join(", ")} non comptée(s).`);
  }

  let reply = output.reply.trim();
  if (!reply) {
    checks.replyEmpty = 1;
    notes.push("Réponse vide du client remplacée par une phrase type.");
  } else {
    const capped = capReply(reply);
    if (capped !== reply) {
      checks.replyTruncated = 1;
      notes.push("Réponse du client raccourcie (trop longue).");
      reply = capped;
    }
  }
  checks.extraQuestions = Math.max(0, (reply.match(/\?/g) ?? []).length - 1);

  let action: InterviewAction = output.action;
  let done = false;
  // The reply is no longer the model's: the answers it gave are not in it.
  let replyReplaced = false;
  const wantsClose = output.done || output.action === "wrap_up";
  if (inputs.round >= inputs.maxRounds) {
    done = true;
    if (!(output.done && output.action === "wrap_up")) checks.closeForced = 1;
    if (output.action !== "wrap_up") {
      action = "wrap_up";
      notes.push("Dernier tour atteint : l'entretien est clos.");
    }
  } else if (wantsClose && inputs.round < MIN_CLOSE_ROUND) {
    checks.closeRefused = 1;
    notes.push(`Clôture refusée avant le tour ${MIN_CLOSE_ROUND} : l'entretien continue.`);
    if (action === "wrap_up") {
      // A wrap_up reply says goodbye: kept, the client would take leave and then wait for the next message.
      action = "probe";
      reply = CONTINUE_REPLY;
      replyReplaced = true;
    }
  } else if (wantsClose) {
    // wrap_up closes; a stray done only when the reply asks nothing, since the candidate could not answer it.
    done = output.action === "wrap_up" || !reply.includes("?");
    if (done) action = "wrap_up";
    else checks.doneIgnored = 1;
  }

  if (done) {
    const kept = withoutQuestions(reply);
    if (kept !== reply) checks.closingQuestions = 1;
    if (wantsClose) {
      reply = kept || CLOSING_REPLY;
    } else {
      // The model meant to go on: what it said stays, minus its question, and the code takes leave within the cap.
      const head = kept && capReply(kept, MAX_REPLY_CHARS - CLOSING_REPLY.length - 2);
      reply = head ? `${head} ${CLOSING_REPLY}` : CLOSING_REPLY;
    }
  }
  if (!reply) reply = FALLBACK_REPLY;

  // Repeating a figure the candidate gave is not inventing one; 0 and 1 are too often words ("1er", "un seul") to judge.
  const known = sourcedNumbers([
    inputs.caseText,
    ...inputs.factSheet.facts.map((f) => f.text),
    ...inputs.factSheet.clientAnswers.flatMap((a) => [a.question, a.answer]),
    ...inputs.transcript.filter((m) => m.role === "candidate").map((m) => m.text),
  ]);
  const unsourced = [...replyNumbers(reply).entries()]
    .filter(([value]) => value !== "0" && value !== "1" && !known.has(value))
    .map(([, raw]) => raw);
  if (unsourced.length) {
    checks.unsourcedNumbers = unsourced.length;
    notes.push(`Chiffre absent de l'énoncé et de la fiche client : ${unsourced.map((n) => `« ${n} »`).join(", ")}.`);
  }

  return { data: { reply, action, reveal: checks.replyEmpty || replyReplaced ? [] : reveal, done }, notes, checks };
}
