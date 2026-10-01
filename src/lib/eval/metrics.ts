import { PIPELINE_STAGE_IDS, type StageOutputs } from "@/lib/schemas";
import type { TokenUsage } from "@/lib/schemas/api";
import type { ChallengeRun, PipelineRun, StageRecord } from "./run-case";

/** Ground truth for one answer: which reflexes (E1-E10) it violates, according to the labels file. */
export type AnswerLabels = { violated: string[]; notViolated: string[]; ambiguous: string[] };

/** Each sample case has a deliberately flawed answer and a strong control answer, both labelled. */
export const ANSWER_KINDS = ["flawed", "control"] as const;
export type AnswerKind = (typeof ANSWER_KINDS)[number];
export type CaseLabels = Record<AnswerKind, AnswerLabels>;

/** The challenge stage keeps at most this many flags, which caps recall when more reflexes are violated. */
export const MAX_FLAGS = 6;

export type FlagScore = { tp: number; fp: number; fn: number; flagged: string[] };

/** Reflexes flagged at least once against the labels; ambiguous reflexes count neither for nor against. */
export function scoreFlags(flagged: string[], labels: AnswerLabels): FlagScore {
  const unique = [...new Set(flagged)].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return {
    tp: unique.filter((r) => labels.violated.includes(r)).length,
    fp: unique.filter((r) => labels.notViolated.includes(r)).length,
    fn: labels.violated.filter((r) => !unique.includes(r)).length,
    flagged: unique,
  };
}

export const flaggedReflexes = (challenge: StageOutputs["challenge"] | null) => (challenge ? challenge.flags.map((f) => f.reflex) : null);

export type Ratio = { value: number | null; num: number; den: number };
export const ratio = (num: number, den: number): Ratio => ({ value: den > 0 ? num / den : null, num, den });

const total = (scores: FlagScore[]) => ({
  tp: scores.reduce((n, s) => n + s.tp, 0),
  fp: scores.reduce((n, s) => n + s.fp, 0),
  fn: scores.reduce((n, s) => n + s.fn, 0),
});

/**
 * What a challenger that never reads the answer would score: it always flags the reflexes most often violated
 * across the labelled answers. The challenge's scores only mean something above this line.
 */
export function answerBlindBaseline(caseIds: string[], labels: Record<string, CaseLabels>) {
  const answers = caseIds.flatMap((id) => ANSWER_KINDS.map((kind) => labels[id]?.[kind]).filter((l): l is AnswerLabels => Boolean(l)));
  const counts = new Map<string, number>();
  for (const a of answers) for (const r of a.violated) counts.set(r, (counts.get(r) ?? 0) + 1);
  const fixed = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || Number(a[0].slice(1)) - Number(b[0].slice(1)))
    .slice(0, MAX_FLAGS)
    .map(([r]) => r);
  const t = total(answers.map((a) => scoreFlags(fixed, a)));
  return { flags: fixed, precision: ratio(t.tp, t.tp + t.fp), recall: ratio(t.tp, t.tp + t.fn) };
}

export type CaseSample = {
  caseId: string;
  sample: number;
  pipeline: PipelineRun;
  challenges: { kind: AnswerKind; run: ChallengeRun }[];
  selfCritique: ChallengeRun | null;
};

const sumCheck = (samples: CaseSample[], stage: string, key: string) =>
  samples.reduce((n, s) => n + s.pipeline.stages.filter((r) => r.stage === stage).reduce((m, r) => m + (r.meta?.checks?.[key] ?? 0), 0), 0);

/** Nearest-rank quantile: never above the true value on small samples. */
const quantile = (values: number[], q: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
};

const recordsOf = (s: CaseSample): StageRecord[] => [...s.pipeline.stages, ...s.challenges.map((c) => c.run), ...(s.selfCritique ? [s.selfCritique] : [])];
const completed = (s: CaseSample) => s.pipeline.session.stages.oral.status === "done";

type Scored = { caseId: string; kind: AnswerKind; score: FlagScore; positives: number };

export type Summary = {
  runs: number;
  pipelinesCompleted: Ratio;
  stageSuccess: Ratio;
  invalidOutputs: number;
  errors: Record<string, number>;
  servedModels: string[];
  factVerification: Ratio;
  citationDrop: Ratio;
  uncitedFindings: Ratio;
  inferredFindings: Ratio;
  recommendationFailsConstraint: Ratio;
  pilotFixed: Ratio;
  challenge: {
    precision: Ratio;
    /** Precision of the reflexes flagged with high severity only: what the critic calls blocking. */
    highSeverityPrecision: Ratio;
    recall: Ratio;
    recallCeiling: number | null;
    flawedRecall: Ratio;
    controlFalsePositives: Ratio;
    baseline: ReturnType<typeof answerBlindBaseline>;
    missedOnFlawed: Record<string, number>;
    /** Does the critique at least separate a weak answer from a strong one, in volume, severity and overall level? */
    byKind: Record<AnswerKind, { runs: number; meanFlags: number | null; meanHighFlags: number | null; levels: Record<string, number> }>;
  };
  challengeQuoteRemoval: Ratio;
  selfCritiqueHighFlags: { mean: number | null; levels: Record<string, number> };
  latencyMs: Record<string, { p50: number | null; p90: number | null }>;
  pipelineWallMs: { p50: number | null; max: number | null };
  costUsdPerRun: number | null;
  costCoverage: Ratio;
  tokens: TokenUsage | null;
  perCase: Record<string, Record<AnswerKind, { flagged: string[][]; precision: (number | null)[]; recall: (number | null)[] }> & { factVerification: Ratio }>;
};

export function summarize(samples: CaseSample[], labels: Record<string, CaseLabels>): Summary {
  const records = samples.flatMap(recordsOf);
  const scored: Scored[] = samples.flatMap((s) =>
    s.challenges.flatMap(({ kind, run }) => {
      const flagged = flaggedReflexes(run.data);
      const l = labels[s.caseId]?.[kind];
      return flagged && l ? [{ caseId: s.caseId, kind, score: scoreFlags(flagged, l), positives: l.violated.length }] : [];
    }),
  );
  const all = total(scored.map((x) => x.score));
  const high = total(
    samples.flatMap((s) =>
      s.challenges.flatMap(({ kind, run }) => {
        const l = labels[s.caseId]?.[kind];
        if (!run.data || !l) return [];
        return [scoreFlags(run.data.flags.filter((f) => f.severity === "high").map((f) => f.reflex), l)];
      }),
    ),
  );
  const flawed = total(scored.filter((x) => x.kind === "flawed").map((x) => x.score));
  const controls = scored.filter((x) => x.kind === "control");
  const missedOnFlawed: Record<string, number> = {};
  for (const x of scored.filter((y) => y.kind === "flawed")) {
    for (const r of labels[x.caseId].flawed.violated) if (!x.score.flagged.includes(r)) missedOnFlawed[r] = (missedOnFlawed[r] ?? 0) + 1;
  }

  const withOptions = samples.filter((s) => s.pipeline.stages.some((r) => r.stage === "options" && r.ok)).length;
  // Stages never reached because an upstream stage failed count as failed runs too.
  const neverRun = samples.reduce((n, s) => n + (PIPELINE_STAGE_IDS.length - s.pipeline.stages.length), 0);

  const latencyMs: Summary["latencyMs"] = {};
  for (const stage of [...new Set(records.map((r) => r.stage))]) {
    const values = records.filter((r) => r.stage === stage && r.ok).map((r) => r.ms);
    latencyMs[stage] = { p50: quantile(values, 0.5), p90: quantile(values, 0.9) };
  }

  const costs = samples.map((s) => recordsOf(s).map((r) => r.meta?.costUsd));
  const priced = costs.filter((c) => c.every((v) => typeof v === "number")) as number[][];
  const usages = records.map((r) => r.meta?.usage).filter((u): u is TokenUsage => Boolean(u));

  const levels: Record<string, number> = {};
  const highFlags: number[] = [];
  for (const s of samples) {
    const data = s.selfCritique?.data;
    if (!data) continue;
    levels[data.level] = (levels[data.level] ?? 0) + 1;
    highFlags.push(data.flags.filter((f) => f.severity === "high").length);
  }

  const errors: Record<string, number> = {};
  for (const r of records) if (r.error) errors[`${r.stage}: ${r.error.code}`] = (errors[`${r.stage}: ${r.error.code}`] ?? 0) + 1;

  const perCase: Summary["perCase"] = {};
  for (const caseId of [...new Set(samples.map((s) => s.caseId))]) {
    const mine = samples.filter((s) => s.caseId === caseId);
    const byKind = (kind: AnswerKind) => {
      const xs = scored.filter((x) => x.caseId === caseId && x.kind === kind).map((x) => x.score);
      return {
        flagged: xs.map((x) => x.flagged),
        precision: xs.map((x) => (x.tp + x.fp ? x.tp / (x.tp + x.fp) : null)),
        recall: xs.map((x) => (x.tp + x.fn ? x.tp / (x.tp + x.fn) : null)),
      };
    };
    perCase[caseId] = {
      flawed: byKind("flawed"),
      control: byKind("control"),
      factVerification: ratio(sumCheck(mine, "frame", "factsVerified"), sumCheck(mine, "frame", "factsProposed")),
    };
  }

  const finished = samples.filter(completed);
  const challengeRuns = samples.flatMap((s) => s.challenges.map((c) => c.run)).filter((r) => r.ok);
  return {
    runs: samples.length,
    pipelinesCompleted: ratio(finished.length, samples.length),
    stageSuccess: ratio(records.filter((r) => r.ok).length, records.length + neverRun),
    invalidOutputs: records.filter((r) => r.error?.code === "invalid_output").length,
    errors,
    servedModels: [...new Set(records.map((r) => r.meta?.model).filter((m): m is string => Boolean(m)))],
    factVerification: ratio(sumCheck(samples, "frame", "factsVerified"), sumCheck(samples, "frame", "factsProposed")),
    citationDrop: ratio(
      sumCheck(samples, "diagnose", "citationsDropped") + sumCheck(samples, "options", "citationsDropped"),
      sumCheck(samples, "diagnose", "citations") + sumCheck(samples, "options", "citations"),
    ),
    uncitedFindings: ratio(sumCheck(samples, "diagnose", "findingsUncited"), sumCheck(samples, "diagnose", "findings")),
    inferredFindings: ratio(sumCheck(samples, "diagnose", "findingsInferred"), sumCheck(samples, "diagnose", "findings")),
    recommendationFailsConstraint: ratio(sumCheck(samples, "options", "recommendationFailsConstraint"), withOptions),
    pilotFixed: ratio(sumCheck(samples, "options", "pilotFixed"), withOptions),
    challenge: {
      precision: ratio(all.tp, all.tp + all.fp),
      highSeverityPrecision: ratio(high.tp, high.tp + high.fp),
      recall: ratio(all.tp, all.tp + all.fn),
      // Same aggregation as the recall (micro), over the same successful runs.
      recallCeiling: ratio(
        scored.reduce((n, x) => n + Math.min(MAX_FLAGS, x.positives), 0),
        scored.reduce((n, x) => n + x.positives, 0),
      ).value,
      flawedRecall: ratio(flawed.tp, flawed.tp + flawed.fn),
      controlFalsePositives: ratio(controls.reduce((n, x) => n + x.score.fp, 0), controls.length),
      baseline: answerBlindBaseline([...new Set(samples.map((s) => s.caseId))], labels),
      missedOnFlawed,
      byKind: Object.fromEntries(
        ANSWER_KINDS.map((kind) => {
          const data = samples.flatMap((s) => s.challenges.filter((c) => c.kind === kind && c.run.data).map((c) => c.run.data!));
          const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
          const levels: Record<string, number> = {};
          for (const d of data) levels[d.level] = (levels[d.level] ?? 0) + 1;
          return [
            kind,
            {
              runs: data.length,
              meanFlags: mean(data.map((d) => d.flags.length)),
              meanHighFlags: mean(data.map((d) => d.flags.filter((f) => f.severity === "high").length)),
              levels,
            },
          ];
        }),
      ) as Summary["challenge"]["byKind"],
    },
    challengeQuoteRemoval: ratio(
      challengeRuns.reduce((n, r) => n + (r.meta?.checks?.quotesRemoved ?? 0), 0),
      challengeRuns.reduce((n, r) => n + (r.meta?.checks?.quotesProposed ?? 0), 0),
    ),
    selfCritiqueHighFlags: { mean: highFlags.length ? highFlags.reduce((a, b) => a + b, 0) / highFlags.length : null, levels },
    latencyMs,
    pipelineWallMs: { p50: quantile(finished.map((s) => s.pipeline.wallMs), 0.5), max: finished.length ? Math.max(...finished.map((s) => s.pipeline.wallMs)) : null },
    costUsdPerRun: priced.length ? priced.reduce((n, c) => n + c.reduce((m, v) => m + v, 0), 0) / priced.length : null,
    costCoverage: ratio(priced.length, costs.length),
    tokens: usages.length
      ? usages.reduce((t, u) => ({ input: t.input + u.input, output: t.output + u.output, cacheRead: t.cacheRead + u.cacheRead, cacheWrite: t.cacheWrite + u.cacheWrite }))
      : null,
    perCase,
  };
}
