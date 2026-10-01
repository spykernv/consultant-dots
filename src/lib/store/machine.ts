import { PIPELINE_STAGE_IDS, POST_GATE_STAGES, STAGE_IDS, type StageId, type StageOutputs } from "@/lib/schemas";
import {
  MIN_CHALLENGE_CHARS,
  type Clarification,
  type MatrixChoices,
  type PilotOverride,
  type StageInputs,
} from "@/lib/schemas/api";
import type { Initiative, OptionsAnalysis, Verdict } from "@/lib/schemas/options";
import { DEFAULT_WEIGHTS, MAX_WEIGHT, weightedScore, type Criterion, type Weights } from "@/lib/domain/scoring";
import { splitClientNotes } from "@/lib/prompts/brief";

export type StageStatus = "idle" | "running" | "done" | "error" | "interrupted";

export type StageRun<T> = {
  status: StageStatus;
  runId: string | null;
  inputHash: string | null;
  data: T | null;
  error: { code: string; message: string } | null;
  ms: number | null;
  model: string | null;
  costUsd: number | null;
  notes: string[];
  /** Instruction used for the last regeneration of this stage, if any. */
  steer: string | null;
};

export type Phase = "input" | "identifying" | "clarifying" | "solving" | "complete";

export type TimerState = { durationSec: number; startedAt: number | null; remainingAtPause: number | null };

export const ZONE_KEYS = ["case", "reasoning", "diagrams", "roadmap", "oral"] as const;
export type ZoneKey = (typeof ZONE_KEYS)[number];

/** The user's working copy of the prioritization; `initiatives: null` means "as generated". */
export type MatrixState = { weights: Weights; initiatives: Initiative[] | null };

export type Session = {
  version: 2;
  epoch: number;
  started: boolean;
  caseText: string;
  caseId: string | null;
  mock: boolean;
  gatePassed: boolean;
  autoRun: boolean;
  stages: { [K in StageId]: StageRun<StageOutputs[K]> };
  answers: Record<string, string>;
  clientNotes: string;
  timer: TimerState;
  notes: Partial<Record<ZoneKey, string>>;
  matrix: MatrixState;
  challengeAnswer: string;
  /** Id of the case's folder under cases/, set on its first automatic save (never for the demo). */
  savedId: string | null;
};

export const STAGE_DEPS: Record<StageId, StageId[]> = {
  classify: [],
  frame: ["classify"],
  questions: ["classify"],
  diagnose: ["frame", "questions"],
  currentState: ["frame", "questions"],
  options: ["diagnose", "currentState"],
  target: ["options", "diagnose", "currentState"],
  roadmap: ["options", "diagnose"],
  oral: ["target", "roadmap", "options", "diagnose"],
  challenge: [],
};

export const TIMER_DEFAULT_SEC = 10 * 60;
export const SESSION_VERSION = 2;

export const isPostGate = (stage: StageId) => (POST_GATE_STAGES as readonly StageId[]).includes(stage);

export function emptyRun<T>(): StageRun<T> {
  return {
    status: "idle",
    runId: null,
    inputHash: null,
    data: null,
    error: null,
    ms: null,
    model: null,
    costUsd: null,
    notes: [],
    steer: null,
  };
}

export function initialSession(epoch = 0): Session {
  return {
    version: 2,
    epoch,
    started: false,
    caseText: "",
    caseId: null,
    mock: false,
    gatePassed: false,
    autoRun: false,
    stages: Object.fromEntries(STAGE_IDS.map((id) => [id, emptyRun()])) as Session["stages"],
    answers: {},
    clientNotes: "",
    timer: { durationSec: TIMER_DEFAULT_SEC, startedAt: null, remainingAtPause: null },
    notes: {},
    matrix: { weights: { ...DEFAULT_WEIGHTS }, initiatives: null },
    challengeAnswer: "",
    savedId: null,
  };
}

/** Upgrades a session persisted by an older version instead of wiping the user's work. */
export function migrateSession(persisted: unknown, version: number): Session {
  const fresh = initialSession();
  if (version !== 1 || !persisted || typeof persisted !== "object") return fresh;
  const old = persisted as Partial<Session>;
  const stages = Object.fromEntries(
    STAGE_IDS.map((id) => [id, { ...emptyRun(), ...((old.stages as Record<string, object> | undefined)?.[id] ?? {}) }]),
  ) as Session["stages"];
  return { ...fresh, ...old, version: 2, stages, notes: {}, matrix: fresh.matrix, challengeAnswer: "" };
}

export function derivePhase(s: Session): Phase {
  if (!s.started) return "input";
  if (!s.gatePassed) return s.stages.questions.status === "done" ? "clarifying" : "identifying";
  return s.stages.oral.status === "done" ? "complete" : "solving";
}

export function clarificationList(s: Session): Clarification[] {
  const questions = s.stages.questions.data?.questions ?? [];
  return questions.map((q) => {
    const answer = (s.answers[q.id] ?? "").trim();
    return {
      questionId: q.id,
      answer,
      status: answer ? "answered" : s.gatePassed ? "assumed" : "open",
    };
  });
}

export function canRun(s: Session, stage: StageId): boolean {
  if (!s.started) return false;
  if (stage === "challenge") return s.challengeAnswer.trim().length >= MIN_CHALLENGE_CHARS;
  if (isPostGate(stage) && !s.gatePassed) return false;
  return STAGE_DEPS[stage].every((dep) => s.stages[dep].status === "done" && s.stages[dep].data !== null);
}

/** The generated options with the user's prioritization applied: downstream stages follow the user's pilot. */
export function effectiveOptions(s: Session): OptionsAnalysis | null {
  const options = s.stages.options.data;
  if (!options) return null;
  return s.matrix.initiatives ? { ...options, initiatives: s.matrix.initiatives } : options;
}

export function pilotOverrideOf(s: Session): PilotOverride {
  if (!s.matrix.initiatives) return null;
  const suggested = s.stages.options.data?.initiatives.find((i) => i.verdict === "pilot")?.name ?? null;
  const chosen = s.matrix.initiatives.find((i) => i.verdict === "pilot")?.name ?? null;
  return chosen && chosen !== suggested ? { chosen, suggested } : null;
}

export const ADDED_BY_USER = "Ajoutée par moi";

/** The decisions a regenerated Options must keep; score tweaks and re-sorting are not decisions. */
export function matrixChoicesOf(s: Session): MatrixChoices {
  const pilot = pilotOverrideOf(s);
  const added = (s.matrix.initiatives ?? []).filter((i) => i.comment === ADDED_BY_USER).map((i) => i.name);
  return pilot || added.length > 0 ? { pilot, added } : null;
}

export function buildInputs<K extends StageId>(s: Session, stage: K): StageInputs[K] {
  const data = <S extends StageId>(id: S) => s.stages[id].data as StageOutputs[S];
  const base = { caseText: s.caseText };
  if (stage === "classify") return base as StageInputs[K];
  if (stage === "frame" || stage === "questions") {
    return { ...base, classification: data("classify") } as StageInputs[K];
  }
  if (stage === "challenge") {
    return {
      ...base,
      answer: s.challengeAnswer.trim(),
      classification: s.stages.classify.data,
      mapping: s.stages.frame.data,
      questions: s.stages.questions.data,
      clarifications: clarificationList(s),
      clientNotes: s.clientNotes,
      diagnostic: s.stages.diagnose.data,
      options: effectiveOptions(s),
      roadmap: s.stages.roadmap.data,
    } as StageInputs[K];
  }

  const brief = {
    ...base,
    classification: data("classify"),
    mapping: data("frame"),
    questions: data("questions"),
    clarifications: clarificationList(s),
    clientNotes: s.clientNotes,
  };
  switch (stage) {
    case "options":
      return { ...brief, diagnostic: data("diagnose"), currentState: data("currentState") } as StageInputs[K];
    case "target":
      return {
        ...brief,
        diagnostic: data("diagnose"),
        currentState: data("currentState"),
        options: effectiveOptions(s),
        pilotOverride: pilotOverrideOf(s),
      } as StageInputs[K];
    case "roadmap":
      return {
        ...brief,
        diagnostic: data("diagnose"),
        options: effectiveOptions(s),
        pilotOverride: pilotOverrideOf(s),
      } as StageInputs[K];
    case "oral":
      return {
        ...brief,
        diagnostic: data("diagnose"),
        options: effectiveOptions(s),
        target: data("target"),
        roadmap: data("roadmap"),
        pilotOverride: pilotOverrideOf(s),
      } as StageInputs[K];
    default:
      return brief as StageInputs[K];
  }
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => byText(a, b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** FNV-1a over a stable serialization: enough to tell whether a stage's inputs changed. */
export function hashValue(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const followsMatrix = (stage: StageId) => stage === "target" || stage === "roadmap" || stage === "oral";

/**
 * What must change for a stage's result to be outdated: what its prompt reads. Score tweaks and the row order in
 * the matrix only matter to the user's ranking; downstream stages go stale when the initiatives or their verdicts
 * (the pilot) change. Client notes count line by line, as the brief lists them.
 */
export function hashInputsOf<K extends StageId>(stage: K, inputs: StageInputs[K]): string {
  if (stage === "challenge") {
    const c = inputs as StageInputs["challenge"];
    return hashValue({ caseText: c.caseText, answer: c.answer });
  }
  const seen: Record<string, unknown> = { ...inputs };
  const { clientNotes, options } = inputs as { clientNotes?: string; options?: OptionsAnalysis | null };
  if (clientNotes !== undefined) seen.clientNotes = splitClientNotes(clientNotes);
  if (options && followsMatrix(stage)) {
    seen.options = {
      ...options,
      initiatives: options.initiatives
        .map((i) => ({ name: i.name, verdict: i.verdict }))
        .sort((a, b) => byText(a.name, b.name) || byText(a.verdict, b.verdict)),
    };
  }
  return hashValue(seen);
}

/** The hash of the raw inputs, still carried by results finished before hashInputsOf followed the prompt. */
function legacyHashInputsOf<K extends StageId>(stage: K, inputs: StageInputs[K]): string {
  if (stage === "challenge") return hashInputsOf(stage, inputs);
  const withOptions = inputs as { options?: OptionsAnalysis | null };
  if (withOptions.options && followsMatrix(stage)) {
    return hashValue({
      ...inputs,
      options: {
        ...withOptions.options,
        initiatives: withOptions.options.initiatives.map((i) => ({ name: i.name, verdict: i.verdict })),
      },
    });
  }
  return hashValue(inputs);
}

export function isStale(s: Session, stage: StageId): boolean {
  const run = s.stages[stage];
  if (run.status !== "done" || !run.inputHash || !canRun(s, stage)) return false;
  const inputs = buildInputs(s, stage);
  return run.inputHash !== hashInputsOf(stage, inputs) && run.inputHash !== legacyHashInputsOf(stage, inputs);
}

export function staleStages(s: Session): StageId[] {
  return PIPELINE_STAGE_IDS.filter((stage) => isStale(s, stage));
}

export function runnableStages(s: Session): StageId[] {
  return PIPELINE_STAGE_IDS.filter((stage) => s.stages[stage].status === "idle" && canRun(s, stage));
}

const withStages = (s: Session, update: (stage: StageId, run: StageRun<unknown>) => StageRun<unknown>): Session => ({
  ...s,
  stages: Object.fromEntries(STAGE_IDS.map((id) => [id, update(id, s.stages[id] as StageRun<unknown>)])) as Session["stages"],
});

export function passGate(s: Session): Session {
  return { ...s, gatePassed: true, autoRun: true };
}

/** Re-runs every stale stage and everything downstream of it; previous results stay visible meanwhile. */
export function resetStale(s: Session): Session {
  const toRerun = new Set<StageId>(staleStages(s));
  let grew = true;
  while (grew) {
    grew = false;
    for (const stage of PIPELINE_STAGE_IDS) {
      if (toRerun.has(stage) || s.stages[stage].status !== "done") continue;
      if (STAGE_DEPS[stage].some((dep) => toRerun.has(dep))) {
        toRerun.add(stage);
        grew = true;
      }
    }
  }
  return withStages({ ...s, autoRun: true }, (stage, run) =>
    toRerun.has(stage) ? { ...run, status: "idle", error: null } : run,
  );
}

export function markInterrupted(s: Session): Session {
  return withStages(s, (_stage, run) => (run.status === "running" ? { ...run, status: "interrupted" } : run));
}

export function resumeStopped(s: Session): Session {
  return withStages({ ...s, autoRun: true }, (stage, run) =>
    stage !== "challenge" && (run.status === "interrupted" || run.status === "error")
      ? { ...run, status: "idle", error: null }
      : run,
  );
}

export function retryStage(s: Session, stage: StageId): Session {
  return withStages({ ...s, autoRun: true }, (id, run) => (id === stage ? { ...run, status: "idle", error: null } : run));
}

// ── Prioritization working copy ─────────────────────────────────────────────

const VERDICT_CYCLE: Verdict[] = ["pilot", "next", "later", "avoid"];

function workingInitiatives(s: Session): Initiative[] {
  return (s.matrix.initiatives ?? s.stages.options.data?.initiatives ?? []).map((i) => ({ ...i }));
}

const withInitiatives = (s: Session, initiatives: Initiative[]): Session => ({
  ...s,
  matrix: { ...s.matrix, initiatives },
});

export function cycleScore(s: Session, index: number, criterion: Criterion, direction: 1 | -1): Session {
  const initiatives = workingInitiatives(s);
  const row = initiatives[index];
  if (!row) return s;
  const next = ((row[criterion] - 1 + direction + 5) % 5) + 1;
  initiatives[index] = { ...row, [criterion]: next as Initiative[Criterion] };
  return withInitiatives(s, initiatives);
}

export function setVerdict(s: Session, index: number, verdict: Verdict): Session {
  const initiatives = workingInitiatives(s);
  if (!initiatives[index]) return s;
  return withInitiatives(
    s,
    initiatives.map((row, i) =>
      i === index ? { ...row, verdict } : verdict === "pilot" && row.verdict === "pilot" ? { ...row, verdict: "next" } : row,
    ),
  );
}

export function cycleVerdict(s: Session, index: number): Session {
  const current = workingInitiatives(s)[index];
  if (!current) return s;
  return setVerdict(s, index, VERDICT_CYCLE[(VERDICT_CYCLE.indexOf(current.verdict) + 1) % VERDICT_CYCLE.length]);
}

export function addInitiative(s: Session, name: string): Session {
  const trimmed = name.trim();
  if (!trimmed) return s;
  return withInitiatives(s, [
    ...workingInitiatives(s),
    { name: trimmed, value: 3, feasibility: 3, risk: 3, timeToValue: 3, reuse: 3, verdict: "later", comment: ADDED_BY_USER },
  ]);
}

export function removeInitiative(s: Session, index: number): Session {
  const initiatives = workingInitiatives(s);
  const [removed] = initiatives.splice(index, 1);
  if (!removed) return s;
  // Removing the pilot promotes nobody: choosing the next pilot is the user's call.
  return withInitiatives(s, initiatives);
}

/** Rows keep a stable order while the user edits them; sorting is an explicit action. */
export function sortByScore(s: Session): Session {
  const initiatives = workingInitiatives(s);
  initiatives.sort((a, b) => weightedScore(b, s.matrix.weights) - weightedScore(a, s.matrix.weights));
  return withInitiatives(s, initiatives);
}

export function setWeight(s: Session, criterion: Criterion, weight: number): Session {
  const clamped = Math.max(0, Math.min(MAX_WEIGHT, Math.round(weight)));
  return { ...s, matrix: { ...s.matrix, weights: { ...s.matrix.weights, [criterion]: clamped } } };
}

export function resetMatrix(s: Session): Session {
  return { ...s, matrix: { weights: { ...DEFAULT_WEIGHTS }, initiatives: null } };
}

export function matrixEdited(s: Session): boolean {
  const w = s.matrix.weights;
  const weightsChanged = (Object.keys(DEFAULT_WEIGHTS) as Criterion[]).some((c) => w[c] !== DEFAULT_WEIGHTS[c]);
  return weightsChanged || s.matrix.initiatives !== null;
}
