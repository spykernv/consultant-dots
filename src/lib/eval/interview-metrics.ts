import { MAX_CANDIDATE_CHARS, type FactSheet } from "@/lib/interview/schema";
import type { Session } from "@/lib/store/machine";
import type { CandidatePersona, CandidateTurn, InterviewerTurn, InterviewRun, SolutionTerms } from "./interview-types";
import { ANSWER_KINDS, answerBlindBaseline, MAX_FLAGS, ratio, scoreFlags, type AnswerLabels, type CaseLabels, type FlagScore, type Ratio } from "./metrics";

/**
 * Scores the interview eval: the debrief and the client's live notes against the labels of the answer each persona
 * follows, each beside the answer-blind baseline on the same answers, how far the score separates the two personas,
 * what the interviewer did reply by reply (leaks of the solution, unsourced figures, tool use), how often the candidate
 * overran the message cap, with latency, cost and errors.
 */

// ── Solution terms and leaks ────────────────────────────────────────────────

/** Words as the leak check compares them: runs of letters, lowercased, accents kept (NFC, so "é" is one letter). */
function wordsOf(text: string): string[] {
  return text.normalize("NFC").toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
}

/** A final s or x is ignored when two words are compared: "applications" in the case covers "application" in a name. */
const fold = (word: string) => word.replace(/[sx]$/u, "");

const MIN_TERM_CHARS = 5;

/**
 * Words that name no solution. Only words of MIN_TERM_CHARS letters or more are listed, shorter ones are dropped anyway:
 * French function words first, then the words a client uses for any recommendation ("quel pilote ?"), which give
 * nothing away.
 */
const STOPWORDS = new Set(
  [
    "ainsi",
    "alors",
    "après",
    "aucun",
    "aucune",
    "auprès",
    "aussi",
    "autant",
    "autour",
    "autre",
    "avant",
    "avoir",
    "beaucoup",
    "celle",
    "celui",
    "certain",
    "certaine",
    "chacun",
    "chaque",
    "comme",
    "comment",
    "contre",
    "depuis",
    "dessus",
    "dessous",
    "devant",
    "durant",
    "elles",
    "encore",
    "entre",
    "étaient",
    "était",
    "étant",
    "jusqu",
    "leurs",
    "lorsque",
    "malgré",
    "moins",
    "notre",
    "nôtre",
    "parce",
    "parmi",
    "pendant",
    "plusieurs",
    "pourquoi",
    "pourtant",
    "puisque",
    "quand",
    "quelle",
    "quelque",
    "quels",
    "selon",
    "sinon",
    "tandis",
    "toujours",
    "toute",
    "votre",
    "vôtre",
    // Generic words of a recommendation.
    "approche",
    "cible",
    "démarche",
    "étape",
    "initiative",
    "option",
    "phase",
    "pilote",
    "premier",
    "première",
    "projet",
    "scénario",
    "solution",
    "usage",
  ].map(fold),
);

/**
 * The recommended option and the pilot of a full pipeline run, and the words of their names the interviewer could only
 * have taken from the analysis: 5 letters or more, not a stopword, and in neither the case nor the fact sheet (its
 * facts, questions and answers), which the client may quote freely. A heuristic, not a proof: a paraphrase or a
 * synonym goes unseen and a listed word can come up in another sense, which is why the report prints the terms.
 * Null when the run has no options.
 */
export function solutionTerms(session: Session, factSheet: FactSheet): SolutionTerms | null {
  const { status, data } = session.stages.options;
  if (status !== "done" || !data) return null;
  const option = data.options.find((o) => o.id === data.recommendation.optionId)?.name ?? "";
  const pilot = data.initiatives.find((i) => i.verdict === "pilot")?.name ?? "";
  const known = new Set(
    [
      session.caseText,
      ...factSheet.facts.map((f) => f.text),
      ...factSheet.clientAnswers.flatMap((a) => [a.question, a.answer]),
    ]
      .flatMap(wordsOf)
      .map(fold),
  );
  const kept = new Map<string, string>();
  for (const word of [...wordsOf(option), ...wordsOf(pilot)]) {
    const key = fold(word);
    if ([...word].length < MIN_TERM_CHARS || STOPWORDS.has(key) || known.has(key) || kept.has(key)) continue;
    kept.set(key, word);
  }
  return { option, pilot, terms: [...kept.values()].sort((a, b) => a.localeCompare(b, "fr")) };
}

/**
 * The interviewer's replies that use a solution term the candidate had not said before, with those terms. The round
 * is the candidate message a reply answers; the opening (round 0) is written by the code and never checked. Replies
 * that leak nothing are left out.
 */
export function leaks(run: InterviewRun, terms: string[]): { round: number; terms: string[] }[] {
  const said = new Set<string>();
  const found: { round: number; terms: string[] }[] = [];
  let round = 0;
  for (const message of run.messages) {
    const words = wordsOf(message.text).map(fold);
    if (message.role === "candidate") {
      round++;
      for (const word of words) said.add(word);
      continue;
    }
    if (round === 0) continue;
    const used = new Set(words);
    const leaked = terms.filter((term) => used.has(fold(term)) && !said.has(fold(term)));
    if (leaked.length) found.push({ round, terms: leaked });
  }
  return found;
}

/** Interviewer messages that answer a candidate message: the opening is the code's. */
function repliesInTranscript(run: InterviewRun): number {
  let round = 0;
  let replies = 0;
  for (const message of run.messages) {
    if (message.role === "candidate") round++;
    else if (round > 0) replies++;
  }
  return replies;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

type EndedBy = InterviewRun["endedBy"];
const ENDINGS: EndedBy[] = ["client", "max_rounds", "error"];

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const mean = (values: number[]) => (values.length ? sum(values) / values.length : null);

/** Sample standard deviation (n − 1): the spread of a handful of interviews, null below two. */
function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = sum(values) / values.length;
  return Math.sqrt(sum(values.map((v) => (v - m) ** 2)) / (values.length - 1));
}

/** Nearest-rank quantile, as metrics.ts computes it: never above the true value on small samples. */
function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

const total = (scores: FlagScore[]) => ({
  tp: sum(scores.map((s) => s.tp)),
  fp: sum(scores.map((s) => s.fp)),
  fn: sum(scores.map((s) => s.fn)),
});

const bump = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/** Reflex ids once each, in E1…E10 order. */
const reflexSet = (reflexes: string[]) => [...new Set(reflexes)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

/**
 * Debriefed, and not cut short by a failed call: only these interviews are scored, as the app would score them. An
 * interview that ended on an error was not played to its end, so its debrief judges a truncated conversation.
 */
export const interviewCompleted = (run: InterviewRun) => run.endedBy !== "error" && Boolean(run.debrief?.ok && run.debrief.data);

/** The interviewer's replies that came back, with their meta. */
const repliesOf = (run: InterviewRun): InterviewerTurn[] =>
  run.turns.flatMap((t) => (t.interviewer?.ok && t.interviewer.meta ? [t.interviewer] : []));

const check = (turn: InterviewerTurn, key: string) => turn.meta?.checks?.[key] ?? 0;

const candidateRounds = (run: InterviewRun) => run.messages.filter((m) => m.role === "candidate").length;

/** Clarification questions whose answer the client gave, out of the case's questions. */
const revealedQuestions = (run: InterviewRun) => new Set(run.revealed.filter((id) => run.questionIds.includes(id))).size;

/**
 * The answer-blind baseline's fixed flags scored on given labelled answers, one per interview, exactly as the debrief
 * or the notes it stands beside were scored: a column then compares the two on the same answers.
 */
function blindScore(flags: string[], answers: AnswerLabels[]): BaselineScore {
  const t = total(answers.map((l) => scoreFlags(flags, l)));
  return { precision: ratio(t.tp, t.tp + t.fp), recall: ratio(t.tp, t.tp + t.fn), falsePositives: ratio(t.fp, answers.length) };
}

/** Raw files written before the candidate was asked to shorten lack these two: missing reads as false and unknown. */
type DraftLength = Partial<Pick<CandidateTurn, "originalChars" | "retried">>;

/** The candidate's messages against the interviewer's cap, every message sent, failed interviews included. */
function candidateLengths(runs: InterviewRun[]): InterviewBlock["candidateLength"] {
  // A failed candidate call sent nothing.
  const sent = runs.flatMap((run) => run.turns.filter((t) => !t.candidate.error));
  const drafts: DraftLength[] = sent.map((t) => t.candidate);
  const known = drafts.flatMap((d) => (typeof d.originalChars === "number" ? [d.originalChars] : []));
  const cut = sent.filter((t) => t.candidate.truncated);
  return {
    messages: sent.length,
    overCap: ratio(known.filter((chars) => chars > MAX_CANDIDATE_CHARS).length, known.length),
    retried: drafts.filter((d) => d.retried === true).length,
    truncated: cut.length,
    truncatedRounds: cut.map((t) => t.round).sort((a, b) => a - b),
  };
}

/** Null when one part has no cost: an interview is priced whole or not at all. */
function interviewCost(run: InterviewRun): number | null {
  const parts: (number | null)[] = [
    ...run.turns.map((t) => t.candidate.costUsd),
    ...run.turns.flatMap((t) => (t.interviewer ? [t.interviewer.meta?.costUsd ?? null] : [])),
    ...(run.debrief ? [run.debrief.meta?.costUsd ?? null] : []),
  ];
  return parts.every((p): p is number => typeof p === "number") ? sum(parts) : null;
}

// ── Summary ─────────────────────────────────────────────────────────────────

export type ScoreStats = { n: number; mean: number | null; sd: number | null; min: number | null; max: number | null };

/** The answer-blind baseline on the labelled answers of a block's debrief, or of its notes. */
export type BaselineScore = {
  precision: Ratio;
  recall: Ratio;
  /** Per labelled interview, as the debrief's. */
  falsePositives: Ratio;
};

/** The same measures over one persona's interviews, or over all of them. */
export type InterviewBlock = {
  interviews: number;
  completed: Ratio;
  endedBy: Record<EndedBy, number>;
  /** Candidate messages per completed interview. */
  meanRounds: number | null;
  /** Key questions answered by the client, micro over the completed interviews. */
  coverage: Ratio;
  debrief: {
    /** Completed interviews with labels: the denominators below. */
    interviews: number;
    precision: Ratio;
    highSeverityPrecision: Ratio;
    recall: Ratio;
    recallCeiling: number | null;
    /** Reflexes flagged that the labels say the answer respects, per interview. */
    falsePositives: Ratio;
    levels: Record<string, number>;
    /** The baseline's fixed flags on exactly these interviews' labels. */
    baseline: BaselineScore;
  };
  /** Tool mode: the reflexes the client noted live (record_observation), against the same labels. */
  observations: {
    interviews: number;
    precision: Ratio;
    recall: Ratio;
    perInterview: Ratio;
    /** The baseline on exactly these tool-mode interviews' labels. */
    baseline: Pick<BaselineScore, "precision" | "recall">;
  };
  /**
   * Every candidate message sent, failed interviews included: first drafts over MAX_CANDIDATE_CHARS (out of those
   * whose length is known), drafts the candidate was asked to shorten, and messages the code cut, with their rounds.
   */
  candidateLength: { messages: number; overCap: Ratio; retried: number; truncated: number; truncatedRounds: number[] };
  score: ScoreStats;
  /** Interviewer replies (the opening excluded) that use a solution term first, in cases whose terms are known. */
  leaks: Ratio;
  factSheet: {
    replies: number;
    unsourcedNumbers: number;
    repliesWithUnsourcedNumbers: Ratio;
    /** Answer ids the client gave or asked for that the fact sheet does not hold (revealUnknown + revealUnknownCall). */
    unknownAnswerIds: number;
    toolErrors: number;
    /** Interviewer calls whose output failed the schema, out of the interviewer calls made. */
    invalidOutputs: Ratio;
    emailsMasked: number;
  };
  tools: { replies: number; callsPerReply: Ratio; roundsPerReply: Ratio; observationsRecorded: number; observationsRejected: number };
};

export type PerCaseRuns = {
  samples: number[];
  endedBy: EndedBy[];
  /** Completed interviews only, null otherwise, like the aggregates. */
  scores: (number | null)[];
  levels: (string | null)[];
  flagged: (string[] | null)[];
  /** Tool mode only. */
  observed: (string[] | null)[];
  coverage: (number | null)[];
  /** Leaking replies per interview, every interview; null when the case's solution terms are unknown. */
  leaks: (number | null)[];
};

export type InterviewSummary = {
  interviews: number;
  byPersona: Record<CandidatePersona, InterviewBlock>;
  overall: InterviewBlock;
  /**
   * The answer-blind baseline's fixed flags, chosen from the labels of these cases; each block scores them on its own
   * labelled interviews (debrief.baseline, observations.baseline).
   */
  baselineFlags: string[];
  /** Mean control score minus mean flawed score. */
  separation: number | null;
  /** Same-case (control, flawed) pairs where the control interview scored higher, ties counting half. */
  ordering: Ratio;
  /** Each term with the number of replies that leaked it. */
  leakedTerms: Record<string, number>;
  /** Cases without solution terms (no full pipeline run): their replies are not checked for leaks. */
  uncheckedCases: string[];
  latencyMs: Record<"candidate" | "interviewer" | "debrief", { p50: number | null; p90: number | null }>;
  wallMs: { p50: number | null; max: number | null };
  costUsdPerInterview: number | null;
  costCoverage: Ratio;
  servedModels: string[];
  errors: Record<string, number>;
  perCase: Record<string, Record<CandidatePersona, PerCaseRuns>>;
};

const termsFor = (solutions: Record<string, SolutionTerms | null>, caseId: string) => solutions[caseId]?.terms ?? null;

function summarizeBlock(
  runs: InterviewRun[],
  labels: Record<string, CaseLabels>,
  solutions: Record<string, SolutionTerms | null>,
  baselineFlags: string[],
): InterviewBlock {
  const done = runs.filter(interviewCompleted);
  const labelled = done.flatMap((run) => {
    const l: AnswerLabels | undefined = labels[run.caseId]?.[run.persona];
    return l ? [{ run, labels: l }] : [];
  });

  const flagScores = labelled.map(({ run, labels: l }) => scoreFlags(run.debrief!.data!.flags.map((f) => f.reflex), l));
  const all = total(flagScores);
  const high = total(
    labelled.map(({ run, labels: l }) =>
      scoreFlags(
        run.debrief!.data!.flags.filter((f) => f.severity === "high").map((f) => f.reflex),
        l,
      ),
    ),
  );
  const positives = labelled.map(({ labels: l }) => l.violated.length);
  const levels: Record<string, number> = {};
  for (const run of done) bump(levels, run.debrief!.data!.level);

  // A structured-mode interview has no notes at all: counting it would read as a client who noticed nothing.
  const toolDone = done.filter((run) => run.tools);
  const toolLabelled = labelled.filter(({ run }) => run.tools);
  const observed = total(toolLabelled.map(({ run, labels: l }) => scoreFlags(run.observations.map((o) => o.reflex), l)));
  const notesBaseline = blindScore(baselineFlags, toolLabelled.map(({ labels: l }) => l));

  const scores = done.map((run) => run.score?.score).filter((s): s is number => typeof s === "number");

  const checked = runs.filter((run) => termsFor(solutions, run.caseId));
  const leaking = sum(checked.map((run) => leaks(run, termsFor(solutions, run.caseId)!).length));

  const replies = runs.flatMap(repliesOf);
  const calls = runs.flatMap((run) => run.turns.flatMap((t) => (t.interviewer ? [t.interviewer] : [])));
  const toolReplies = runs.filter((run) => run.tools).flatMap(repliesOf);
  const sumCheck = (turns: InterviewerTurn[], ...keys: string[]) => sum(turns.flatMap((t) => keys.map((k) => check(t, k))));

  const endedBy = Object.fromEntries(ENDINGS.map((e) => [e, runs.filter((run) => run.endedBy === e).length])) as Record<EndedBy, number>;

  return {
    interviews: runs.length,
    completed: ratio(done.length, runs.length),
    endedBy,
    meanRounds: mean(done.map(candidateRounds)),
    coverage: ratio(sum(done.map(revealedQuestions)), sum(done.map((run) => run.questionIds.length))),
    debrief: {
      interviews: labelled.length,
      precision: ratio(all.tp, all.tp + all.fp),
      highSeverityPrecision: ratio(high.tp, high.tp + high.fp),
      recall: ratio(all.tp, all.tp + all.fn),
      // The debrief is the challenge stage: same cap on its flags, same micro aggregation as the recall.
      recallCeiling: ratio(sum(positives.map((p) => Math.min(MAX_FLAGS, p))), sum(positives)).value,
      falsePositives: ratio(all.fp, labelled.length),
      levels,
      baseline: blindScore(baselineFlags, labelled.map(({ labels: l }) => l)),
    },
    observations: {
      interviews: toolDone.length,
      precision: ratio(observed.tp, observed.tp + observed.fp),
      recall: ratio(observed.tp, observed.tp + observed.fn),
      perInterview: ratio(sum(toolDone.map((run) => run.observations.length)), toolDone.length),
      baseline: { precision: notesBaseline.precision, recall: notesBaseline.recall },
    },
    candidateLength: candidateLengths(runs),
    score: {
      n: scores.length,
      mean: mean(scores),
      sd: stdDev(scores),
      min: scores.length ? Math.min(...scores) : null,
      max: scores.length ? Math.max(...scores) : null,
    },
    leaks: ratio(leaking, sum(checked.map(repliesInTranscript))),
    factSheet: {
      replies: replies.length,
      unsourcedNumbers: sumCheck(replies, "unsourcedNumbers"),
      repliesWithUnsourcedNumbers: ratio(replies.filter((t) => check(t, "unsourcedNumbers") > 0).length, replies.length),
      unknownAnswerIds: sumCheck(replies, "revealUnknown", "revealUnknownCall"),
      toolErrors: sumCheck(replies, "toolErrors"),
      invalidOutputs: ratio(calls.filter((t) => t.error?.code === "invalid_output").length, calls.length),
      emailsMasked: sumCheck(replies, "emailMasked"),
    },
    tools: {
      replies: toolReplies.length,
      callsPerReply: ratio(sumCheck(toolReplies, "toolCalls"), toolReplies.length),
      roundsPerReply: ratio(sumCheck(toolReplies, "toolIterations"), toolReplies.length),
      observationsRecorded: sumCheck(toolReplies, "observationsRecorded"),
      observationsRejected: sumCheck(toolReplies, "observationsRejected"),
    },
  };
}

/** Scored interviews of one case and persona, in sample order. */
const scored = (runs: InterviewRun[], caseId: string, persona: CandidatePersona) =>
  runs
    .filter((run) => run.caseId === caseId && run.persona === persona && interviewCompleted(run))
    .map((run) => run.score?.score)
    .filter((s): s is number => typeof s === "number");

export function summarizeInterviews(
  runs: InterviewRun[],
  labels: Record<string, CaseLabels>,
  solutions: Record<string, SolutionTerms | null>,
): InterviewSummary {
  const caseIds = [...new Set(runs.map((run) => run.caseId))];
  // Chosen from the labels of every case, flawed and control alike, but scored per block on that block's interviews.
  const baselineFlags = answerBlindBaseline(caseIds, labels).flags;
  const byPersona = Object.fromEntries(
    ANSWER_KINDS.map((persona) => [persona, summarizeBlock(runs.filter((run) => run.persona === persona), labels, solutions, baselineFlags)]),
  ) as Record<CandidatePersona, InterviewBlock>;

  const control = byPersona.control.score.mean;
  const flawed = byPersona.flawed.score.mean;
  let wins = 0;
  let pairs = 0;
  for (const caseId of caseIds) {
    for (const c of scored(runs, caseId, "control")) {
      for (const f of scored(runs, caseId, "flawed")) {
        pairs++;
        wins += c > f ? 1 : c === f ? 0.5 : 0;
      }
    }
  }

  const leakedTerms: Record<string, number> = {};
  for (const run of runs) {
    const terms = termsFor(solutions, run.caseId);
    if (!terms) continue;
    for (const reply of leaks(run, terms)) for (const term of reply.terms) bump(leakedTerms, term);
  }

  const turns = runs.flatMap((run) => run.turns);
  const done = runs.filter(interviewCompleted);
  const costs = runs.map(interviewCost);
  const priced = costs.filter((c): c is number => c !== null);
  const latency = (values: number[]) => ({ p50: quantile(values, 0.5), p90: quantile(values, 0.9) });

  const errors: Record<string, number> = {};
  for (const run of runs) {
    for (const t of run.turns) {
      if (t.candidate.error) bump(errors, `candidate: ${t.candidate.error.code}`);
      if (t.interviewer?.error) bump(errors, `interviewer: ${t.interviewer.error.code}`);
    }
    if (run.debrief?.error) bump(errors, `debrief: ${run.debrief.error.code}`);
  }

  const models = runs.flatMap((run) => [
    ...run.turns.flatMap((t) => [t.candidate.model, t.interviewer?.meta?.model]),
    run.debrief?.meta?.model,
  ]);

  const perCase: InterviewSummary["perCase"] = {};
  for (const caseId of caseIds) {
    const terms = termsFor(solutions, caseId);
    const ofPersona = (persona: CandidatePersona): PerCaseRuns => {
      const mine = runs.filter((run) => run.caseId === caseId && run.persona === persona).sort((a, b) => a.sample - b.sample);
      const whenDone = <T>(fn: (run: InterviewRun) => T) => mine.map((run) => (interviewCompleted(run) ? fn(run) : null));
      return {
        samples: mine.map((run) => run.sample),
        endedBy: mine.map((run) => run.endedBy),
        scores: whenDone((run) => run.score?.score ?? null),
        levels: whenDone((run) => run.debrief!.data!.level),
        flagged: whenDone((run) => reflexSet(run.debrief!.data!.flags.map((f) => f.reflex))),
        observed: mine.map((run) => (interviewCompleted(run) && run.tools ? reflexSet(run.observations.map((o) => o.reflex)) : null)),
        coverage: whenDone((run) => ratio(revealedQuestions(run), run.questionIds.length).value),
        leaks: mine.map((run) => (terms ? leaks(run, terms).length : null)),
      };
    };
    perCase[caseId] = { flawed: ofPersona("flawed"), control: ofPersona("control") };
  }

  return {
    interviews: runs.length,
    byPersona,
    overall: summarizeBlock(runs, labels, solutions, baselineFlags),
    baselineFlags,
    separation: control != null && flawed != null ? control - flawed : null,
    ordering: ratio(wins, pairs),
    leakedTerms,
    uncheckedCases: caseIds.filter((id) => !termsFor(solutions, id)),
    latencyMs: {
      candidate: latency(turns.filter((t) => !t.candidate.error).map((t) => t.candidate.ms)),
      interviewer: latency(turns.flatMap((t) => (t.interviewer?.ok ? [t.interviewer.ms] : []))),
      debrief: latency(runs.flatMap((run) => (run.debrief?.ok ? [run.debrief.ms] : []))),
    },
    wallMs: { p50: quantile(done.map((run) => run.wallMs), 0.5), max: done.length ? Math.max(...done.map((run) => run.wallMs)) : null },
    costUsdPerInterview: priced.length ? sum(priced) / priced.length : null,
    costCoverage: ratio(priced.length, costs.length),
    servedModels: [...new Set(models.filter((m): m is string => Boolean(m)))],
    errors,
    perCase,
  };
}
