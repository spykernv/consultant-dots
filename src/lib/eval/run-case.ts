import { randomUUID } from "node:crypto";
import type { StageId, StageOutputs } from "@/lib/schemas";
import type { DoneMeta, EngineErrorCode, StageEvent, StageRequest } from "@/lib/schemas/api";
import { runStage } from "@/lib/pipeline/run-stage";
import { buildInputs, emptyRun, initialSession, passGate, runnableStages, type Session } from "@/lib/store/machine";

/**
 * Runs a case end to end without the browser, through the same state machine as the app: the same waves,
 * the same inputs per stage, and the clarification gate passed with no answers (every question keeps its
 * default working assumption).
 */

export type StageRecord = {
  stage: StageId;
  ok: boolean;
  ms: number;
  meta: DoneMeta | null;
  error: { code: EngineErrorCode; message: string } | null;
};

export type PipelineRun = { session: Session; stages: StageRecord[]; wallMs: number };

export type ChallengeRun = StageRecord & { data: StageOutputs["challenge"] | null };

type Options = { caseId: string | null; mock: boolean; signal?: AbortSignal };

async function callStage(s: Session, stage: StageId, options: Options): Promise<{ record: StageRecord; data: unknown }> {
  const request: StageRequest = {
    runId: randomUUID(),
    mock: options.mock,
    caseId: options.caseId,
    inputs: buildInputs(s, stage),
    steer: null,
    previous: null,
    choices: null,
  };
  let last: StageEvent | null = null;
  const started = Date.now();
  await runStage(stage, request, (event) => {
    if (event.type === "done" || event.type === "error") last = event;
  }, options.signal ?? new AbortController().signal);
  const ms = Date.now() - started;
  const event = last as StageEvent | null;
  if (event?.type === "done") return { record: { stage, ok: true, ms, meta: event.meta, error: null }, data: event.data };
  const error = event?.type === "error" ? { code: event.code, message: event.message } : { code: "engine_error" as const, message: "Aucun résultat." };
  return { record: { stage, ok: false, ms, meta: null, error }, data: null };
}

function withResult(s: Session, stage: StageId, record: StageRecord, data: unknown): Session {
  return {
    ...s,
    stages: {
      ...s.stages,
      [stage]: {
        ...emptyRun(),
        status: record.ok ? "done" : "error",
        data: record.ok ? data : null,
        ms: record.ms,
        model: record.meta?.model ?? null,
        costUsd: record.meta?.costUsd ?? null,
        notes: record.meta?.notes ?? [],
        error: record.error,
      },
    },
  };
}

export async function runPipeline(caseText: string, options: Options): Promise<PipelineRun> {
  let s: Session = { ...initialSession(), started: true, caseText, caseId: options.caseId, mock: options.mock, autoRun: true };
  const stages: StageRecord[] = [];
  const started = Date.now();
  for (;;) {
    let wave = runnableStages(s);
    if (!wave.length && !s.gatePassed && s.stages.questions.status === "done") {
      s = passGate(s);
      wave = runnableStages(s);
    }
    if (!wave.length) break;
    const results = await Promise.all(wave.map(async (stage) => ({ stage, ...(await callStage(s, stage, options)) })));
    for (const { stage, record, data } of results) {
      stages.push(record);
      s = withResult(s, stage, record, data);
    }
  }
  return { session: s, stages, wallMs: Date.now() - started };
}

/** The challenge stage as the app runs it after an analysis: it sees the case, the clarifications and the analysis. */
export async function runChallenge(s: Session, answer: string, options: Options): Promise<ChallengeRun> {
  const { record, data } = await callStage({ ...s, challengeAnswer: answer }, "challenge", options);
  return { ...record, data: data as StageOutputs["challenge"] | null };
}

/** The generated oral pitch as plain text, so the challenge stage can critique the app's own recommendation. */
export function oralToText(oral: StageOutputs["oral"]): string {
  return [
    oral.opening,
    ...oral.sections.flatMap((section) => [`${section.title} :`, ...section.bullets.map((b) => `- ${b.point} ${b.detail}`)]),
    oral.closing,
  ].join("\n");
}
