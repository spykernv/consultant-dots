import { describe, expect, it } from "vitest";
import { initialSession, type Session } from "@/lib/store/machine";
import { MAX_CANDIDATE_CHARS, type FactSheet, type InterviewMessage } from "@/lib/interview/schema";
import type { ChallengeLevel, Severity } from "@/lib/schemas/challenge";
import type { ReflexId } from "@/lib/schemas/common";
import type { Verdict } from "@/lib/schemas/options";
import type { ChallengeRun } from "@/lib/eval/run-case";
import type { CaseLabels } from "@/lib/eval/metrics";
import type {
  CandidatePersona,
  CandidateTurn,
  EngineFailure,
  InterviewerTurn,
  InterviewRun,
  SolutionTerms,
} from "@/lib/eval/interview-types";
import { interviewCompleted, leaks, solutionTerms, summarizeInterviews } from "@/lib/eval/interview-metrics";
import { renderInterviewReport, type InterviewRunInfo } from "@/lib/eval/interview-report";
import { fixture } from "./helpers";

// ── Builders ────────────────────────────────────────────────────────────────

const OPENING = "Bonjour : comment aborderiez-vous le sujet ?";

const failure = (code: EngineFailure["code"]): EngineFailure => ({ code, message: "Échec." });

/** "E1:high" is a high-severity flag on E1; the severity defaults to medium. */
function debrief(level: ChallengeLevel, flags: string[] = [], patch: Partial<ChallengeRun> = {}): ChallengeRun {
  return {
    stage: "challenge",
    ok: true,
    ms: 20_000,
    meta: { ms: 20_000, model: "debrief-model", costUsd: 0.1, notes: [] },
    error: null,
    data: {
      level,
      verdict: "Verdict.",
      flags: flags.map((f) => {
        const [reflex, severity = "medium"] = f.split(":");
        return { reflex: reflex as ReflexId, severity: severity as Severity, quote: "", issue: "Problème.", interviewerQuestion: "Pourquoi ?", fix: "Mieux." };
      }),
      strengths: ["Clair."],
      missing: [],
      nextVersion: ["Cadrer."],
    },
    ...patch,
  };
}

const failedDebrief = (code: EngineFailure["code"]) => debrief("correct", [], { ok: false, data: null, meta: null, error: failure(code) });

type Exchange = {
  say: string;
  reply?: string;
  checks?: Record<string, number>;
  candidate?: Partial<CandidateTurn>;
  /** null: no interviewer call for this round. */
  interviewer?: Partial<InterviewerTurn> | null;
};

const failedReply = (code: EngineFailure["code"], ms = 100): Partial<InterviewerTurn> => ({ ok: false, ms, data: null, meta: null, error: failure(code) });

type RunSpec = {
  caseId?: string;
  persona?: CandidatePersona;
  sample?: number;
  tools?: boolean;
  exchanges?: Exchange[];
  endedBy?: InterviewRun["endedBy"];
  debrief?: ChallengeRun | null;
  score?: number | null;
  revealed?: string[];
  questionIds?: string[];
  observations?: string[];
  wallMs?: number;
};

const simple = (n: number): Exchange[] => Array.from({ length: n }, (_, i) => ({ say: `Message ${i + 1} du candidat.`, reply: `Réponse ${i + 1}.` }));

/** An interview as the runner records it: the transcript is rebuilt from the turns, after the code's opening. */
function interview(spec: RunSpec = {}): InterviewRun {
  const messages: InterviewMessage[] = [{ role: "interviewer", text: OPENING }];
  const turns = (spec.exchanges ?? simple(1)).map((x, i) => {
    const candidate: CandidateTurn = {
      message: x.say,
      truncated: false,
      originalChars: x.say.length,
      retried: false,
      ms: 2_000,
      model: "candidate-model",
      costUsd: 0.01,
      error: null,
      ...x.candidate,
    };
    if (!candidate.error) messages.push({ role: "candidate", text: candidate.message });
    let interviewer: InterviewerTurn | null = null;
    if (x.interviewer !== null && !candidate.error) {
      interviewer = {
        ok: true,
        ms: 3_000,
        data: { reply: x.reply ?? "Poursuivez.", action: "probe", reveal: [], done: false, observations: [], toolCalls: [] },
        meta: { ms: 3_000, model: "interviewer-model", costUsd: 0.02, notes: [], checks: x.checks ?? {} },
        error: null,
        ...x.interviewer,
      };
      if (interviewer.ok && interviewer.data) messages.push({ role: "interviewer", text: interviewer.data.reply });
    }
    return { round: i + 1, candidate, interviewer };
  });
  const d = spec.debrief === undefined ? debrief("correct") : spec.debrief;
  const questionIds = spec.questionIds ?? ["Q1", "Q2"];
  const revealed = spec.revealed ?? [];
  const score = spec.score === undefined ? 50 : spec.score;
  const asked = questionIds.filter((id) => revealed.includes(id));
  return {
    caseId: spec.caseId ?? "a",
    persona: spec.persona ?? "flawed",
    sample: spec.sample ?? 1,
    tools: spec.tools ?? true,
    turns,
    messages,
    revealed,
    observations: (spec.observations ?? []).map((reflex) => ({ reflex: reflex as ReflexId, severity: "medium", quote: "mots", note: "Noté.", round: 1 })),
    endedBy: spec.endedBy ?? "client",
    debrief: d,
    score:
      score === null
        ? null
        : {
            score,
            keyQuestions: { asked, missed: questionIds.filter((id) => !asked.includes(id)), total: questionIds.length },
            level: d?.data?.level ?? null,
            blockingFlags: 0,
            roundsUsed: messages.filter((m) => m.role === "candidate").length,
            maxRounds: 8,
          },
    questionIds,
    wallMs: spec.wallMs ?? 60_000,
  };
}

const ALL_BUT = (...ids: string[]) => ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "E9", "E10"].filter((r) => !ids.includes(r));

const LABELS: Record<string, CaseLabels> = {
  a: {
    flawed: { violated: ["E1", "E2", "E3"], notViolated: ALL_BUT("E1", "E2", "E3"), ambiguous: [] },
    control: { violated: [], notViolated: ALL_BUT("E10"), ambiguous: ["E10"] },
  },
  b: {
    flawed: { violated: ["E1", "E4"], notViolated: ALL_BUT("E1", "E4"), ambiguous: [] },
    control: { violated: ["E9"], notViolated: ALL_BUT("E9"), ambiguous: [] },
  },
};

const r = (num: number, den: number) => ({ value: den > 0 ? num / den : null, num, den });

/** A run as an older raw file holds it: its candidate turns predate originalChars and retried. */
function olderRun(run: InterviewRun): InterviewRun {
  const turns = run.turns.map((turn) => {
    const candidate: Partial<CandidateTurn> = { ...turn.candidate };
    delete candidate.originalChars;
    delete candidate.retried;
    return { ...turn, candidate: candidate as CandidateTurn };
  });
  return { ...run, turns };
}

// ── Solution terms ──────────────────────────────────────────────────────────

function sessionWithOptions(caseText: string, recommended: string | null, names: string[], initiatives: [string, Verdict][]): Session {
  const base = fixture("options");
  const s = initialSession();
  s.caseText = caseText;
  s.stages.options = {
    ...s.stages.options,
    status: "done",
    data: {
      ...base,
      options: names.map((name, i) => ({ ...base.options[0], id: `O${i + 1}`, name })),
      recommendation: { ...base.recommendation, optionId: recommended },
      initiatives: initiatives.map(([name, verdict]) => ({ ...base.initiatives[0], name, verdict })),
    },
  };
  return s;
}

const CASE = "Un groupe de 3 filiales veut des tableaux de bord hybrides.";
const FACT_SHEET: FactSheet = {
  facts: [{ id: "F1", text: "La marge consolidée est calculée à la main." }],
  clientAnswers: [{ id: "Q1", question: "Quelle gouvernance des données ?", answer: "L'Espagne garde ses données." }],
};
const OPTIONS = ["Lac central unique", "Socle data hybride entre filiales"];
const INITIATIVES: [string, Verdict][] = [
  ["Catalogue groupe", "next"],
  ["Pilote marge consolidée Espagne et gouvernance régionale", "pilot"],
];

describe("solution terms", () => {
  it("keeps the words of the recommended option and the pilot that neither the case nor the fact sheet holds", () => {
    const terms = solutionTerms(sessionWithOptions(CASE, "O2", OPTIONS, INITIATIVES), FACT_SHEET);
    // socle: kept. data, et: too short. hybride: the case says "hybrides". entre: stopword. filiales: in the case.
    // pilote: generic word. marge, consolidée: in a fact. espagne: in an answer. gouvernance: in a question.
    expect(terms).toEqual({
      option: "Socle data hybride entre filiales",
      pilot: "Pilote marge consolidée Espagne et gouvernance régionale",
      terms: ["régionale", "socle"],
    });
  });

  it("ignores the options that are not recommended and the initiatives that are not the pilot", () => {
    const terms = solutionTerms(sessionWithOptions(CASE, "O1", OPTIONS, INITIATIVES), FACT_SHEET);
    expect(terms?.option).toBe("Lac central unique");
    // lac: too short; catalogue (not the pilot) and socle (not recommended) never come in.
    expect(terms?.terms).toEqual(["central", "régionale", "unique"]);
  });

  it("compares whole words, lowercased, and dedupes a word both names use", () => {
    const s = sessionWithOptions("La localisation des Socles est libre.", "O1", ["LOCAL Socle"], [["Socle local", "pilot"]]);
    // "localisation" does not hold "local"; "Socles" is the plural of "socle".
    expect(solutionTerms(s, { facts: [], clientAnswers: [] })?.terms).toEqual(["local"]);
  });

  it("reads the pilot alone when the recommendation is undecided", () => {
    const terms = solutionTerms(sessionWithOptions(CASE, null, OPTIONS, INITIATIVES), FACT_SHEET);
    expect(terms).toEqual({ option: "", pilot: INITIATIVES[1][0], terms: ["régionale"] });
  });

  it("is null when the options stage is not done", () => {
    expect(solutionTerms(initialSession(), FACT_SHEET)).toBeNull();
    const s = sessionWithOptions(CASE, "O2", OPTIONS, INITIATIVES);
    s.stages.options = { ...s.stages.options, status: "error", data: null };
    expect(solutionTerms(s, FACT_SHEET)).toBeNull();
  });
});

// ── Leaks ───────────────────────────────────────────────────────────────────

describe("leaks", () => {
  const terms = ["hybride", "local", "socle"];

  it("reports the replies that use a term first, never the opening, never a term the candidate said before", () => {
    const run = interview({
      exchanges: [
        { say: "Je partirais des usages métier.", reply: "Pensez-vous à un socle commun ?" },
        { say: "Oui, un socle partagé.", reply: "Un socle, d'accord. La délocalisation vous inquiète ?" },
        { say: "Je garderais du LOCAL.", reply: "Du local et du Hybride ?" },
        { say: "Les socles hybrides, oui.", reply: "Un socle hybride en local, entendu." },
      ],
    });
    run.messages[0] = { role: "interviewer", text: "Bonjour : un socle hybride en local vous parle ?" };
    expect(leaks(run, terms)).toEqual([
      { round: 1, terms: ["socle"] },
      { round: 3, terms: ["hybride"] },
    ]);
  });

  it("matches whole words with their accents, whatever the Unicode form", () => {
    const say = "Bonjour.";
    expect(leaks(interview({ exchanges: [{ say, reply: "C'est DÉCIDÉE ?" }] }), ["décidée"])).toEqual([{ round: 1, terms: ["décidée"] }]);
    expect(leaks(interview({ exchanges: [{ say, reply: "C'est décidée ?" }] }), ["décidée"])).toHaveLength(1);
    expect(leaks(interview({ exchanges: [{ say, reply: "C'est decidee ? Et l'indécidée ?" }] }), ["décidée"])).toEqual([]);
  });

  it("finds nothing without terms or without a reply", () => {
    expect(leaks(interview({ exchanges: [{ say: "Un socle.", reply: "Un socle ?" }] }), [])).toEqual([]);
    expect(leaks(interview({ exchanges: [{ say: "Bonjour.", interviewer: null }] }), terms)).toEqual([]);
  });
});

// ── Summary ─────────────────────────────────────────────────────────────────

describe("interview summary", () => {
  it("counts interviews, completions, endings and rounds, per persona and overall", () => {
    const runs = [
      interview({ sample: 1, exchanges: simple(3) }),
      interview({ sample: 2, exchanges: simple(5), endedBy: "max_rounds" }),
      // Debriefed, but ended by a failed call: not completed.
      interview({ sample: 3, exchanges: [...simple(1), { say: "Encore.", interviewer: failedReply("timeout") }], endedBy: "error" }),
      interview({ persona: "control", sample: 1, exchanges: simple(4), debrief: failedDebrief("timeout") }),
      interview({ persona: "control", sample: 2, exchanges: simple(2), debrief: null, score: null }),
      interview({ persona: "control", sample: 3, exchanges: simple(6) }),
    ];
    expect(runs.map(interviewCompleted)).toEqual([true, true, false, false, false, true]);

    const s = summarizeInterviews(runs, LABELS, {});
    expect(s.interviews).toBe(6);
    expect(s.byPersona.flawed).toMatchObject({ interviews: 3, completed: r(2, 3), endedBy: { client: 1, max_rounds: 1, error: 1 }, meanRounds: 4 });
    expect(s.byPersona.control).toMatchObject({ interviews: 3, completed: r(1, 3), endedBy: { client: 3, max_rounds: 0, error: 0 }, meanRounds: 6 });
    expect(s.overall).toMatchObject({ interviews: 6, completed: r(3, 6), endedBy: { client: 4, max_rounds: 1, error: 1 } });
    expect(s.overall.meanRounds).toBeCloseTo(14 / 3);
  });

  it("scores the debrief against the labels of the persona's answer, next to the answer-blind baseline", () => {
    const runs = [
      interview({ caseId: "a", debrief: debrief("a_retravailler", ["E1:high", "E2", "E5:high"]) }),
      interview({ caseId: "b", debrief: debrief("correct", ["E1:high", "E4"]) }),
      interview({ caseId: "a", persona: "control", debrief: debrief("solide", ["E4:low"]) }),
      interview({ caseId: "b", persona: "control", debrief: debrief("solide", ["E9", "E2:low"]) }),
      // Not completed: its flags count nowhere.
      interview({ caseId: "a", sample: 2, endedBy: "error", debrief: debrief("correct", ["E7:high", "E8:high"]) }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    expect(s.byPersona.flawed.debrief).toEqual({
      interviews: 2,
      precision: r(4, 5),
      highSeverityPrecision: r(2, 3),
      recall: r(4, 5),
      recallCeiling: 1,
      falsePositives: r(1, 2),
      levels: { a_retravailler: 1, correct: 1 },
      baseline: expect.any(Object),
    });
    expect(s.byPersona.control.debrief).toEqual({
      interviews: 2,
      precision: r(1, 3),
      highSeverityPrecision: r(0, 0),
      recall: r(1, 1),
      recallCeiling: 1,
      falsePositives: r(2, 2),
      levels: { solide: 2 },
      baseline: expect.any(Object),
    });
    expect(s.overall.debrief).toMatchObject({ precision: r(5, 8), recall: r(5, 6), highSeverityPrecision: r(2, 3), falsePositives: r(3, 4) });
    // Most often violated across a and b: E1 (twice), then E2, E3, E4, E9 once each.
    expect(s.baselineFlags).toEqual(["E1", "E2", "E3", "E4", "E9"]);
    // Scored on the same two answers per column as the debrief. Flawed a: E1 E2 E3 right, E4 E9 wrong; flawed b: E1 E4
    // right, E2 E3 E9 wrong. Control a: all five wrong; control b: E9 right, four wrong.
    expect(s.byPersona.flawed.debrief.baseline).toEqual({ precision: r(5, 10), recall: r(5, 5), falsePositives: r(5, 2) });
    expect(s.byPersona.control.debrief.baseline).toEqual({ precision: r(1, 10), recall: r(1, 1), falsePositives: r(9, 2) });
    expect(s.overall.debrief.baseline).toEqual({ precision: r(6, 20), recall: r(6, 6), falsePositives: r(14, 4) });
  });

  it("scores the baseline per persona on the debrief's own answers, as on the live run: 17/18 and 17/22 on the flawed persona", () => {
    // The labels of the three sample cases, and the flags and notes of the live run of 2026-10-02.
    const clean = { violated: [], notViolated: ALL_BUT(), ambiguous: [] };
    const labels: Record<string, CaseLabels> = {
      dp: { flawed: { violated: ["E1", "E2", "E3", "E4", "E5", "E6", "E8", "E9"], notViolated: ["E7", "E10"], ambiguous: [] }, control: clean },
      ga: { flawed: { violated: ["E1", "E3", "E4", "E5", "E6", "E9"], notViolated: ["E2", "E8", "E10"], ambiguous: ["E7"] }, control: clean },
      ci: { flawed: { violated: ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E10"], notViolated: ["E8", "E9"], ambiguous: [] }, control: clean },
    };
    const live: [string, CandidatePersona, string[], string[]][] = [
      ["dp", "flawed", ["E1", "E2", "E3", "E5", "E6", "E7"], ["E1", "E2", "E3", "E4", "E5", "E8"]],
      ["dp", "control", ["E1", "E3", "E6", "E7"], ["E6"]],
      ["ga", "flawed", ["E1", "E2", "E3", "E6", "E9"], ["E1", "E2", "E3", "E5", "E6", "E7", "E9"]],
      ["ga", "control", ["E6", "E7", "E9"], ["E6"]],
      ["ci", "flawed", ["E1", "E2", "E3", "E6", "E7", "E10"], ["E1", "E2", "E3", "E4", "E7", "E10"]],
      ["ci", "control", ["E3", "E4", "E6", "E7", "E10"], ["E4"]],
    ];
    const runs = live.map(([caseId, persona, flags, observations]) => interview({ caseId, persona, debrief: debrief("correct", flags), observations }));
    const s = summarizeInterviews(runs, labels, {});

    // E1, E3, E4, E5, E6 are violated in three answers, E2 in two.
    expect(s.baselineFlags).toEqual(["E1", "E3", "E4", "E5", "E6", "E2"]);
    expect(s.byPersona.flawed.debrief).toMatchObject({ precision: r(15, 17), recall: r(15, 22) });
    // On the flawed answers alone the baseline is right 17 times out of 18: the pooled 17/36 hid that the debrief's
    // recall (15/22) is under the baseline's (17/22) there.
    expect(s.byPersona.flawed.debrief.baseline).toEqual({ precision: r(17, 18), recall: r(17, 22), falsePositives: r(1, 3) });
    expect(s.byPersona.control.debrief).toMatchObject({ precision: r(0, 12), falsePositives: r(12, 3) });
    expect(s.byPersona.control.debrief.baseline).toEqual({ precision: r(0, 18), recall: r(0, 0), falsePositives: r(18, 3) });
    expect(s.overall.debrief.baseline).toEqual({ precision: r(17, 36), recall: r(17, 22), falsePositives: r(19, 6) });
    // The client's notes tie the baseline on the flawed persona.
    expect(s.byPersona.flawed.observations).toMatchObject({ precision: r(17, 18), recall: r(17, 22) });
    expect(s.byPersona.flawed.observations.baseline).toEqual({ precision: r(17, 18), recall: r(17, 22) });
    expect(s.byPersona.control.observations.baseline).toEqual({ precision: r(0, 18), recall: r(0, 0) });
  });

  it("scores the baseline only where its figure is scored: failed interviews nowhere, structured mode beside the debrief only", () => {
    const runs = [
      interview({ caseId: "a", observations: ["E1"] }),
      interview({ caseId: "b", tools: false }),
      interview({ caseId: "a", sample: 2, endedBy: "error", observations: ["E2"] }),
      interview({ caseId: "b", sample: 2, debrief: failedDebrief("timeout"), score: null }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    // Chosen from both answers of a and b, though no control interview ran.
    expect(s.baselineFlags).toEqual(["E1", "E2", "E3", "E4", "E9"]);
    expect(s.byPersona.flawed.debrief.baseline).toEqual({ precision: r(5, 10), recall: r(5, 5), falsePositives: r(5, 2) });
    // The notes come from the tool-mode interview of case a alone.
    expect(s.byPersona.flawed.observations.baseline).toEqual({ precision: r(3, 5), recall: r(3, 3) });
    // No completed control interview: no false positives per control interview, where the labels alone gave 9/2.
    expect(s.byPersona.control.debrief.baseline).toEqual({ precision: r(0, 0), recall: r(0, 0), falsePositives: r(0, 0) });
    expect(s.overall.debrief.baseline).toEqual(s.byPersona.flawed.debrief.baseline);
  });

  it("counts the candidate's messages over the cap, asked to shorten and cut, failed interviews included", () => {
    const over = MAX_CANDIDATE_CHARS + 300;
    const runs = [
      interview({
        endedBy: "error",
        exchanges: [
          // Shortened on request.
          { say: "Un.", candidate: { originalChars: over, retried: true } },
          // Still over the cap once shortened: cut.
          { say: "Deux.", candidate: { originalChars: over, retried: true, truncated: true } },
          { say: "Trois." },
          // A failed call sent nothing.
          { say: "", candidate: { originalChars: 0, error: failure("timeout") } },
        ],
      }),
      interview({
        sample: 2,
        exchanges: [
          { say: "Un.", candidate: { originalChars: over + 1, truncated: true } },
          { say: "Deux.", candidate: { originalChars: MAX_CANDIDATE_CHARS } },
        ],
      }),
      // Written before originalChars and retried: length unknown, never asked to shorten.
      olderRun(interview({ persona: "control", exchanges: [{ say: "Un." }, { say: "Deux.", candidate: { truncated: true } }] })),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    expect(s.byPersona.flawed.candidateLength).toEqual({ messages: 5, overCap: r(3, 5), retried: 2, truncated: 2, truncatedRounds: [1, 2] });
    expect(s.byPersona.control.candidateLength).toEqual({ messages: 2, overCap: r(0, 0), retried: 0, truncated: 1, truncatedRounds: [2] });
    expect(s.overall.candidateLength).toEqual({ messages: 7, overCap: r(3, 5), retried: 2, truncated: 3, truncatedRounds: [1, 2, 2] });
  });

  it("caps the debrief's recall at six flags, like the challenge", () => {
    const labels: Record<string, CaseLabels> = {
      c: { flawed: { violated: ALL_BUT("E9", "E10"), notViolated: ["E9", "E10"], ambiguous: [] }, control: LABELS.a.control },
    };
    const s = summarizeInterviews([interview({ caseId: "c", debrief: debrief("a_retravailler", ["E1", "E2", "E3", "E4", "E5", "E6"]) })], labels, {});
    expect(s.byPersona.flawed.debrief.recall).toEqual(r(6, 8));
    expect(s.byPersona.flawed.debrief.recallCeiling).toBe(0.75);
  });

  it("scores the client's live notes in tool mode only, on completed interviews", () => {
    const runs = [
      interview({ caseId: "a", observations: ["E1", "E4"] }),
      // Structured mode: no notes, and no zero recall either.
      interview({ caseId: "b", tools: false }),
      interview({ caseId: "a", persona: "control" }),
      interview({ caseId: "b", persona: "control", observations: ["E9"] }),
      interview({ caseId: "a", sample: 2, endedBy: "error", observations: ["E2", "E3"] }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    // The baseline (E1, E2, E3, E4, E9) on the same answers: flawed a; controls a and b.
    expect(s.byPersona.flawed.observations).toEqual({
      interviews: 1,
      precision: r(1, 2),
      recall: r(1, 3),
      perInterview: r(2, 1),
      baseline: { precision: r(3, 5), recall: r(3, 3) },
    });
    expect(s.byPersona.control.observations).toEqual({
      interviews: 2,
      precision: r(1, 1),
      recall: r(1, 1),
      perInterview: r(1, 2),
      baseline: { precision: r(1, 10), recall: r(1, 1) },
    });
    expect(s.overall.observations).toEqual({
      interviews: 3,
      precision: r(2, 3),
      recall: r(2, 4),
      perInterview: r(3, 3),
      baseline: { precision: r(4, 15), recall: r(4, 4) },
    });
  });

  it("gives the score's spread per persona, the separation, and the same-case ordering with ties counting half", () => {
    const runs = [
      interview({ caseId: "a", sample: 1, score: 40 }),
      interview({ caseId: "a", sample: 2, score: 60 }),
      interview({ caseId: "a", sample: 3, score: 90, endedBy: "error" }),
      interview({ caseId: "a", persona: "control", sample: 1, score: 70 }),
      interview({ caseId: "a", persona: "control", sample: 2, score: 60 }),
      interview({ caseId: "b", score: 55 }),
      interview({ caseId: "b", persona: "control", score: 50 }),
      // No flawed interview of case c: no pair.
      interview({ caseId: "c", persona: "control", score: 80 }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    const flawed = s.byPersona.flawed.score;
    expect(flawed).toMatchObject({ n: 3, min: 40, max: 60 });
    expect(flawed.mean).toBeCloseTo(155 / 3);
    expect(flawed.sd).toBeCloseTo(Math.sqrt(650 / 6));
    expect(s.byPersona.control.score).toMatchObject({ n: 4, mean: 65, min: 50, max: 80 });
    expect(s.byPersona.control.score.sd).toBeCloseTo(Math.sqrt(500 / 3));
    expect(s.separation).toBeCloseTo(65 - 155 / 3);
    // Case a: 70 > 40, 70 > 60, 60 > 40, 60 = 60 (half); case b: 50 < 55.
    expect(s.ordering).toEqual(r(3.5, 5));
  });

  it("leaves the spread, the separation and the ordering empty without enough scores", () => {
    const s = summarizeInterviews([interview({ score: 40 })], LABELS, {});
    expect(s.byPersona.flawed.score).toEqual({ n: 1, mean: 40, sd: null, min: 40, max: 40 });
    expect(s.byPersona.control.score).toEqual({ n: 0, mean: null, sd: null, min: null, max: null });
    expect(s.separation).toBeNull();
    expect(s.ordering).toEqual(r(0, 0));
  });

  it("measures key-question coverage over the case's questions, micro, on completed interviews", () => {
    const runs = [
      // An id outside the questions and a repeated one count once at most.
      interview({ sample: 1, questionIds: ["Q1", "Q2"], revealed: ["Q1", "Q1", "Q9"] }),
      interview({ sample: 2, questionIds: ["Q1", "Q2", "Q3"], revealed: ["Q1", "Q3"] }),
      interview({ sample: 3, questionIds: ["Q1", "Q2"], revealed: ["Q1", "Q2"], endedBy: "error" }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    expect(s.byPersona.flawed.coverage).toEqual(r(3, 5));
    expect(s.byPersona.control.coverage).toEqual(r(0, 0));
  });

  it("counts leaking replies over every interview of the cases whose solution is known", () => {
    const solutions: Record<string, SolutionTerms | null> = {
      a: { option: "Socle commun", pilot: "Pilote", terms: ["socle"] },
      b: null,
      c: { option: "Lac", pilot: "Pilote", terms: [] },
    };
    const runs = [
      interview({ caseId: "a", exchanges: [{ say: "Bonjour.", reply: "Un socle ?" }, { say: "Oui.", reply: "D'accord." }] }),
      // Ended by an error, but its first reply reached the candidate.
      interview({ caseId: "a", sample: 2, endedBy: "error", exchanges: [{ say: "Bonjour.", reply: "Un socle ?" }, { say: "Oui.", interviewer: failedReply("timeout") }] }),
      interview({ caseId: "a", persona: "control", exchanges: [{ say: "Un socle.", reply: "Le socle, oui." }, { say: "Oui.", reply: "Et le socle ?" }] }),
      interview({ caseId: "b", exchanges: [{ say: "Bonjour.", reply: "Un socle ?" }] }),
      interview({ caseId: "c", persona: "control", exchanges: [{ say: "Bonjour.", reply: "Un lac ?" }] }),
    ];
    const s = summarizeInterviews(runs, LABELS, solutions);
    expect(s.byPersona.flawed.leaks).toEqual(r(2, 3));
    expect(s.byPersona.control.leaks).toEqual(r(0, 3));
    expect(s.overall.leaks).toEqual(r(2, 6));
    expect(s.leakedTerms).toEqual({ socle: 2 });
    expect(s.uncheckedCases).toEqual(["b"]);
    expect(s.perCase.a.flawed.leaks).toEqual([1, 1]);
    expect(s.perCase.b.flawed.leaks).toEqual([null]);
    expect(s.perCase.c.control.leaks).toEqual([0]);
  });

  it("sums the guardrail checks of the replies: fact-sheet consistency and tool usage", () => {
    const runs = [
      interview({
        exchanges: [
          {
            say: "Bonjour.",
            checks: { unsourcedNumbers: 2, revealUnknown: 1, toolErrors: 1, emailMasked: 1, toolCalls: 3, toolIterations: 2, observationsRecorded: 1, observationsRejected: 1 },
          },
          { say: "Encore.", checks: { revealUnknownCall: 2, toolCalls: 1, toolIterations: 1, observationsRecorded: 1 } },
        ],
      }),
      interview({
        sample: 2,
        endedBy: "error",
        exchanges: [
          { say: "Bonjour.", checks: { unsourcedNumbers: 1, toolCalls: 2, toolIterations: 1 } },
          { say: "Encore.", interviewer: failedReply("invalid_output") },
        ],
      }),
      interview({ persona: "control", tools: false, exchanges: [{ say: "Bonjour.", checks: { unsourcedNumbers: 1, revealUnknown: 1 } }, { say: "Encore." }] }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    expect(s.byPersona.flawed.factSheet).toEqual({
      replies: 3,
      unsourcedNumbers: 3,
      repliesWithUnsourcedNumbers: r(2, 3),
      unknownAnswerIds: 3,
      toolErrors: 1,
      invalidOutputs: r(1, 4),
      emailsMasked: 1,
    });
    expect(s.byPersona.flawed.tools).toEqual({ replies: 3, callsPerReply: r(6, 3), roundsPerReply: r(4, 3), observationsRecorded: 2, observationsRejected: 1 });
    expect(s.byPersona.control.factSheet).toEqual({
      replies: 2,
      unsourcedNumbers: 1,
      repliesWithUnsourcedNumbers: r(1, 2),
      unknownAnswerIds: 1,
      toolErrors: 0,
      invalidOutputs: r(0, 2),
      emailsMasked: 0,
    });
    // Structured mode: no tool usage to measure.
    expect(s.byPersona.control.tools).toEqual({ replies: 0, callsPerReply: r(0, 0), roundsPerReply: r(0, 0), observationsRecorded: 0, observationsRejected: 0 });
    expect(s.overall.factSheet).toMatchObject({ replies: 5, unsourcedNumbers: 4, repliesWithUnsourcedNumbers: r(3, 5), unknownAnswerIds: 4, invalidOutputs: r(1, 6) });
    expect(s.overall.tools).toMatchObject({ replies: 3, callsPerReply: r(6, 3) });
  });

  it("takes nearest-rank latencies of the calls that succeeded, and the wall time of completed interviews", () => {
    const runs = [
      interview({
        wallMs: 30_000,
        debrief: debrief("correct", [], { ms: 10_000 }),
        exchanges: [
          { say: "Un.", candidate: { ms: 1_000 }, interviewer: { ms: 2_000 } },
          { say: "Deux.", candidate: { ms: 3_000 }, interviewer: { ms: 6_000 } },
        ],
      }),
      interview({ persona: "control", wallMs: 50_000, debrief: debrief("solide", [], { ms: 20_000 }), exchanges: [{ say: "Un.", candidate: { ms: 2_000 }, interviewer: { ms: 4_000 } }] }),
      interview({
        sample: 2,
        wallMs: 99_000,
        endedBy: "error",
        debrief: null,
        exchanges: [
          { say: "Un.", candidate: { ms: 5_000 }, interviewer: { ms: 8_000 } },
          { say: "Deux.", candidate: { ms: 7_000 }, interviewer: failedReply("timeout", 100) },
        ],
      }),
      interview({ persona: "control", sample: 2, endedBy: "error", debrief: null, exchanges: [{ say: "", candidate: { ms: 9_000, costUsd: null, error: failure("usage_limit") } }] }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    expect(s.latencyMs).toEqual({
      candidate: { p50: 3_000, p90: 7_000 },
      interviewer: { p50: 4_000, p90: 8_000 },
      debrief: { p50: 10_000, p90: 20_000 },
    });
    expect(s.wallMs).toEqual({ p50: 30_000, max: 50_000 });
    expect(s.servedModels).toEqual(["candidate-model", "interviewer-model", "debrief-model"]);
  });

  it("prices an interview whole (candidate, interviewer and debrief) or not at all", () => {
    const runs = [
      // 2 × 0.01 + 2 × 0.02 + 0.1
      interview({ exchanges: simple(2) }),
      // 0.01 + 0.02 + 0.1
      interview({ sample: 2 }),
      interview({ sample: 3, exchanges: [{ say: "Un.", candidate: { costUsd: null } }] }),
      interview({ sample: 4, endedBy: "error", exchanges: [{ say: "Un.", interviewer: failedReply("timeout") }] }),
      interview({ sample: 5, debrief: debrief("correct", [], { meta: null }) }),
      // Never debriefed: priced on its turns alone.
      interview({ sample: 6, debrief: null, score: null, endedBy: "error", exchanges: [{ say: "Un.", interviewer: null }] }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    expect(s.costCoverage).toEqual(r(3, 6));
    expect(s.costUsdPerInterview).toBeCloseTo((0.16 + 0.13 + 0.01) / 3);
    expect(summarizeInterviews([runs[2]], LABELS, {}).costUsdPerInterview).toBeNull();
  });

  it("counts errors by step and code, and keeps failed interviews out of the quality figures", () => {
    const runs = [
      interview({ endedBy: "error", debrief: null, score: null, exchanges: [{ say: "", candidate: { error: failure("usage_limit") } }] }),
      interview({ sample: 2, endedBy: "error", exchanges: [{ say: "Un.", interviewer: failedReply("invalid_output") }] }),
      interview({ sample: 3, endedBy: "error", exchanges: [{ say: "Un.", interviewer: failedReply("invalid_output") }] }),
      interview({ persona: "control", endedBy: "error", exchanges: [{ say: "Un.", interviewer: failedReply("timeout") }] }),
      interview({ persona: "control", sample: 2, debrief: failedDebrief("timeout"), score: null }),
    ];
    const s = summarizeInterviews(runs, LABELS, {});
    expect(s.errors).toEqual({ "candidate: usage_limit": 1, "interviewer: invalid_output": 2, "interviewer: timeout": 1, "debrief: timeout": 1 });
    expect(s.overall.completed).toEqual(r(0, 5));
    expect(s.overall.debrief).toMatchObject({ interviews: 0, precision: r(0, 0), recall: r(0, 0), levels: {} });
    expect(s.overall.score).toEqual({ n: 0, mean: null, sd: null, min: null, max: null });
    expect(s.overall.meanRounds).toBeNull();
    expect(s.wallMs).toEqual({ p50: null, max: null });
    expect(s.latencyMs.debrief).toEqual({ p50: 20_000, p90: 20_000 });
  });

  it("lists each case and persona's interviews in sample order, with n/a for those not completed", () => {
    const runs = [
      interview({
        caseId: "a",
        sample: 2,
        score: 40,
        debrief: debrief("a_retravailler", ["E3", "E1:high", "E1"]),
        observations: ["E4"],
        revealed: ["Q1"],
        exchanges: [{ say: "Bonjour.", reply: "Un socle ?" }],
      }),
      interview({ caseId: "a", sample: 1, endedBy: "error", observations: ["E2"] }),
      interview({ caseId: "b", tools: false, score: 55 }),
    ];
    const s = summarizeInterviews(runs, LABELS, { a: { option: "Socle", pilot: "Pilote", terms: ["socle"] } });
    expect(Object.keys(s.perCase)).toEqual(["a", "b"]);
    expect(s.perCase.a.flawed).toEqual({
      samples: [1, 2],
      endedBy: ["error", "client"],
      scores: [null, 40],
      levels: [null, "a_retravailler"],
      flagged: [null, ["E1", "E3"]],
      observed: [null, ["E4"]],
      coverage: [null, 0.5],
      leaks: [0, 1],
    });
    expect(s.perCase.a.control).toEqual({ samples: [], endedBy: [], scores: [], levels: [], flagged: [], observed: [], coverage: [], leaks: [] });
    expect(s.perCase.b.flawed).toMatchObject({ scores: [55], observed: [null], leaks: [null] });
  });

  it("is all empty, never NaN, without interviews", () => {
    const s = summarizeInterviews([], {}, {});
    expect(s.interviews).toBe(0);
    expect(s.overall.completed).toEqual(r(0, 0));
    expect(s.overall.coverage).toEqual(r(0, 0));
    expect(s.overall.debrief.recallCeiling).toBeNull();
    expect(s.baselineFlags).toEqual([]);
    expect(s.overall.debrief.baseline).toEqual({ precision: r(0, 0), recall: r(0, 0), falsePositives: r(0, 0) });
    expect(s.overall.candidateLength).toEqual({ messages: 0, overCap: r(0, 0), retried: 0, truncated: 0, truncatedRounds: [] });
    expect(s.separation).toBeNull();
    expect(s.costUsdPerInterview).toBeNull();
    expect(s.latencyMs.candidate).toEqual({ p50: null, p90: null });
    expect(s).toMatchObject({ servedModels: [], errors: {}, perCase: {}, leakedTerms: {}, uncheckedCases: [] });
  });
});

// ── Report ──────────────────────────────────────────────────────────────────

const INFO: InterviewRunInfo = {
  date: "2026-10-02 12:00 UTC",
  engine: "cli",
  requestedModel: "some-model",
  cases: ["a", "b"],
  interviewsPerPersona: 1,
  personas: ["flawed", "control"],
  promptVersion: "abcd1234",
  tools: true,
  pipelinesFrom: "runs.json",
  freshPipelines: [],
  skipped: [],
  labelsReviewedByHand: false,
};

describe("interview report", () => {
  const solutions: Record<string, SolutionTerms | null> = {
    a: { option: "Socle commun | local", pilot: "Pilote marge", terms: ["local", "socle"] },
    b: null,
  };
  const runs = [
    interview({
      caseId: "a",
      score: 40,
      debrief: debrief("a_retravailler", ["E1:high", "E2", "E5:high"]),
      observations: ["E1"],
      revealed: ["Q1"],
      exchanges: [{ say: "Un data lake.", reply: "Un socle ?", checks: { toolCalls: 2, toolIterations: 1, unsourcedNumbers: 1 } }],
    }),
    interview({ caseId: "a", persona: "control", score: 70, debrief: debrief("solide", ["E4:low"]), revealed: ["Q1", "Q2"] }),
    interview({ caseId: "b", score: 55, endedBy: "error", exchanges: [{ say: "Un.", interviewer: failedReply("invalid_output") }] }),
    interview({ caseId: "b", persona: "control", score: 60, debrief: debrief("solide", ["E9"]) }),
  ];
  const summary = summarizeInterviews(runs, LABELS, solutions);

  it("renders every section, with the baseline beside the debrief and the solution terms to audit", () => {
    const report = renderInterviewReport(INFO, summary, LABELS, solutions);
    for (const heading of [
      "# Interview eval · 2026-10-02 12:00 UTC",
      "## Interviews",
      "## Debrief against labelled answers",
      "## Live observations (tool mode)",
      "## Score",
      "## Leaks of the solution",
      "## Fact-sheet consistency",
      "## Tool usage",
      "## Latency and cost",
      "## Per case",
      "## Errors",
      "## Caveats",
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain("served by `candidate-model`, `interviewer-model`, `debrief-model`");
    expect(report).toContain("interviewer in tool mode · pipeline runs reused from `runs.json`");
    expect(report).toContain("| Interviews completed | 1/2 (50 %) | 2/2 (100 %) | 3/4 (75 %) |");
    expect(report).toContain("| Ended by the client / at the last round / by an error | 1 / 0 / 1 | 2 / 0 / 0 | 3 / 0 / 1 |");
    expect(report).toContain("| Precision | 2/3 (67 %) | 1/2 (50 %) | 3/5 (60 %) | Flagged reflexes");
    // The baseline on the same completed answers: flawed a alone (b ended by an error), controls a and b.
    expect(report).toContain("| Precision, answer-blind baseline | 3/5 (60 %) | 1/10 (10 %) | 4/15 (27 %) |");
    expect(report).toContain("| Recall, answer-blind baseline | 3/3 (100 %) | 1/1 (100 %) | 4/4 (100 %) |");
    expect(report).toContain("| False positives per interview | 1.0 | 0.5 | 0.7 |");
    expect(report).toContain("| False positives per interview, answer-blind baseline | 2.0 | 4.5 | 3.7 |");
    expect(report).toContain("it always flags E1, E2, E3, E4, E9");
    // The notes are scored on the same interviews here, all in tool mode.
    expect(report).toContain("| Precision | 1/1 (100 %) | n/a | 1/1 (100 %) | Reflexes the client noted");
    expect(report.split("| Precision, answer-blind baseline | 3/5 (60 %) | 1/10 (10 %) | 4/15 (27 %) |")).toHaveLength(3);
    expect(report).toContain("| flawed | 1 | 40.0 | n/a | 40 | 40 | a_retravailler × 1 |");
    expect(report).toContain("| control | 2 | 65.0 | 7.1 | 60 | 70 | solide × 2 |");
    expect(report).toContain("Separation (mean control score − mean flawed score): +25.0 points");
    expect(report).toContain("scored higher in 1/1 (100 %) of the same-case (control, flawed) pairs");
    // Case b has no solution terms: its replies are not checked.
    expect(report).toContain("| Replies with a leaked term | 1/1 (100 %) | 0/1 (0 %) | 1/2 (50 %) |");
    expect(report).toContain("Leaked terms, by replies: socle × 1.");
    expect(report).toContain("Not checked (no full pipeline run to take the solution from): b.");
    // The terms are printed so that the leak check can be audited; a pipe in a name stays in its cell.
    expect(report).toContain("| a | Socle commun \\| local | Pilote marge | local, socle |");
    expect(report).toContain("| b | n/a | n/a | not checked |");
    expect(report).toContain("| Unsourced numbers | 1 (replies: 1/1 (100 %)) |");
    expect(report).toContain("| Invalid outputs | 1/2 (50 %) | 0/2 (0 %) | 1/4 (25 %) |");
    expect(report).toContain("| Tool calls per reply | 2.0 | 0.0 | 0.7 |");
    expect(report).toContain("| a | flawed | E1, E2, E3 | client | 40 | a_retravailler | E1 E2 E5 | E1 | 50 % | 1 |");
    expect(report).toContain("| b | flawed | E1, E4 | error | n/a | n/a | n/a | n/a | n/a | n/a |");
    expect(report).toContain("- interviewer: invalid_output × 1");
    expect(report).toContain("API-equivalent cost");
    expect(report).toContain("not for the conversations the personas produce");
    expect(report).toContain("same model family");
    expect(report).toContain("word heuristic");
    expect(report).toContain("drift from its plan");
    expect(report).toContain("4 interview(s) in total, 1 per case and persona");
    expect(report).not.toContain("Mock engine");
    expect(report).not.toContain("NaN");
    expect(report.endsWith("\n")).toBe(true);
  });

  it("says when the run was in mock mode or in structured mode", () => {
    const structured = summarizeInterviews(runs.map((run) => ({ ...run, tools: false })), LABELS, solutions);
    const report = renderInterviewReport(
      { ...INFO, engine: "mock", tools: false, pipelinesFrom: null, freshPipelines: ["a", "b"] },
      structured,
      LABELS,
      solutions,
    );
    expect(report).toContain("interviewer in structured mode (no tools) · pipelines run for this eval: a, b");
    expect(report).not.toContain("reused from");
    expect(report).toContain("Mock engine: recorded turns are replayed");
    expect(report).toContain("n/a: no completed interview ran in tool mode");
    expect(report).toContain("n/a: no interviewer reply ran in tool mode.");
    expect(report).not.toContain("API-equivalent cost");
  });

  it("renders n/a everywhere when there is nothing to measure", () => {
    const report = renderInterviewReport({ ...INFO, cases: ["a"] }, summarizeInterviews([], {}, {}), {}, { a: { option: "Lac", pilot: "Pilote", terms: [] } });
    expect(report).toContain("served by n/a");
    expect(report).toContain("| Interviews completed | n/a | n/a | n/a |");
    expect(report).toContain("| Precision | n/a | n/a | n/a | Flagged reflexes");
    expect(report).not.toContain("answer-blind baseline |");
    expect(report).toContain("ceiling n/a");
    expect(report).toContain("No labels for these cases: no answer-blind baseline.");
    expect(report).toContain("| flawed | 0 | n/a | n/a | n/a | n/a | n/a |");
    expect(report).toContain("Separation (mean control score − mean flawed score): n/a.");
    expect(report).toContain("No leaked term.");
    expect(report).toContain("| a | Lac | Pilote | none: every word is in the case or the fact sheet |");
    expect(report).toContain("| Interview wall time (p50 / max) | n/a / n/a |");
    expect(report).toContain("| Cost per interview | n/a (n/a of interviews priced) |");
    expect(report).not.toContain("## Errors");
    expect(report).not.toContain("NaN");
  });

  it("gives each column its own baseline, and no control false positives without a completed control interview", () => {
    const flawedOnly = [interview({ caseId: "a" }), interview({ caseId: "b" })];
    const report = renderInterviewReport({ ...INFO, personas: ["flawed"] }, summarizeInterviews(flawedOnly, LABELS, {}), LABELS, {});
    expect(report).toContain("| Precision, answer-blind baseline | 5/10 (50 %) | n/a | 5/10 (50 %) |");
    expect(report).toContain("| False positives per interview, answer-blind baseline | 2.5 | n/a | 2.5 |");
    expect(report).not.toContain("per control answer");
    expect(report).toContain("on exactly the labelled answers its debrief was scored on, one per completed interview of that column");
  });

  it("says which figures count completed interviews only and which count every call, failed interviews included", () => {
    const report = renderInterviewReport(INFO, summary, LABELS, solutions);
    expect(report).toContain(
      "The debrief, the client's live notes, the score, the key-question coverage, the rounds and the wall time count completed " +
        "interviews only: debriefed, and not ended by a failed call. The leaks, the fact-sheet consistency, the tool usage and the " +
        "invalid outputs count every interviewer call or reply",
    );
    expect(report).toContain("(src/lib/interview/score.ts), completed interviews only;");

    // The rows of the tables with a column per persona, by section.
    const rows: Record<string, string[]> = {};
    let section = "";
    let inTable = false;
    for (const line of report.split("\n")) {
      if (line.startsWith("## ")) section = line.slice(3);
      if (line.startsWith("| Metric | Flawed persona")) inTable = true;
      else if (!line.startsWith("|")) inTable = false;
      else if (inTable && !line.startsWith("|---")) (rows[section] ??= []).push(line);
    }
    const scope = (title: string) => rows[Object.keys(rows).find((t) => t.startsWith(title))!];
    for (const title of ["Debrief", "Live observations"]) {
      for (const line of scope(title)) expect(line).toMatch(/completed (tool-mode )?interviews[^|]*\|$/);
    }
    for (const title of ["Leaks", "Fact-sheet", "Tool usage"]) {
      for (const line of scope(title)) expect(line).toMatch(/, every (tool-mode )?(reply|call), failed interviews included \|$/);
    }
    expect(scope("Fact-sheet")).toContain(
      "| Invalid outputs | 1/2 (50 %) | 0/2 (0 %) | 1/4 (25 %) | Interviewer calls whose output failed the reply schema, every call, failed interviews included |",
    );
    expect(scope("Interviews")).toContain("| Rounds used (mean) | 1.0 | 1.0 | 1.0 | Candidate messages per interview, completed interviews only |");
    expect(scope("Interviews").find((line) => line.startsWith("| Candidate messages over the cap"))).toContain("failed interviews included");
  });

  it("counts only the interviewed cases, names the skipped ones, and tells reused pipelines from fresh ones", () => {
    const report = renderInterviewReport(
      { ...INFO, cases: ["a", "b", "c"], freshPipelines: ["b", "c"], skipped: ["c"] },
      summary,
      LABELS,
      { ...solutions, c: null },
    );
    expect(report).toContain("some-model`, served by `candidate-model`, `interviewer-model`, `debrief-model` · 2 case(s) ·");
    expect(report).toContain("interviewer in tool mode · pipeline runs reused from `runs.json` for a · pipelines run for this eval: b, c\n");
    expect(report).toContain("No interview (pipeline stopped before its clarification questions): c.");
    expect(report).toContain("| b | n/a | n/a | not checked |");
    expect(report).toContain("| c | n/a | n/a | no interview |");

    // --reuse given, but every pipeline run here: no claim of reuse.
    const fresh = renderInterviewReport({ ...INFO, freshPipelines: ["a", "b"] }, summary, LABELS, solutions);
    expect(fresh).toContain("· 2 case(s) ·");
    expect(fresh).not.toContain("reused from");
    expect(fresh).toContain("interviewer in tool mode · pipelines run for this eval: a, b\n");
    expect(fresh).not.toContain("No interview");
  });

  it("reports the candidate's messages over the cap, asked to shorten and cut, with n/a for an older raw run", () => {
    const over = MAX_CANDIDATE_CHARS + 1;
    const runs = [
      interview({
        exchanges: [
          { say: "Un.", candidate: { originalChars: over, retried: true } },
          { say: "Deux.", candidate: { originalChars: over, retried: true, truncated: true } },
        ],
      }),
      interview({ sample: 2, exchanges: [{ say: "Un.", candidate: { originalChars: over, truncated: true } }, { say: "Deux." }] }),
      olderRun(interview({ persona: "control", exchanges: [{ say: "Un." }, { say: "Deux.", candidate: { truncated: true } }] })),
    ];
    const report = renderInterviewReport(INFO, summarizeInterviews(runs, LABELS, {}), LABELS, {});
    expect(report).toContain(`| Candidate messages over the cap | 3/4 (75 %) | n/a | 3/4 (75 %) | First drafts longer than the ${MAX_CANDIDATE_CHARS} characters`);
    expect(report).toContain("| Asked to shorten | 2 | 0 | 2 |");
    expect(report).toContain("| Cut by the code | 2 (rounds 1, 2) | 1 (round 2) | 3 (rounds 1, 2, 2) |");
    expect(report).toContain("(n/a: the raw run predates the count)");

    const none = renderInterviewReport(INFO, summarizeInterviews([interview()], LABELS, {}), LABELS, {});
    expect(none).toContain("| Candidate messages over the cap | 0/1 (0 %) | n/a | 0/1 (0 %) |");
    expect(none).toContain("| Cut by the code | 0 | 0 | 0 |");
  });
});
