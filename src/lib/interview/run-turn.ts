import type { StageEvent } from "@/lib/schemas/api";
import { toStrictJsonSchema, type JsonSchema } from "@/lib/schemas/strict-schema";
import { runLiveEngine } from "@/lib/engine/dispatch";
import { runMockInterview } from "@/lib/engine/mock";
import { EngineError, type Effort, type EngineRequest } from "@/lib/engine/types";
import { describeIssues } from "@/lib/pipeline/run-stage";
import {
  InterviewTurnInputSchema,
  InterviewTurnOutputSchema,
  MAX_CANDIDATE_CHARS,
  type InterviewRequest,
  type InterviewTurnInput,
} from "./schema";
import { buildTurnMessage, INTERVIEWER_SYSTEM_PROMPT } from "./prompt";
import { normalizeTurn } from "./normalize";

/** A client's reply is short and the candidate is waiting: low effort, and a tighter timeout than a pipeline stage. */
export const TURN_EFFORT: Effort = "low";
export const TURN_TIMEOUT_MS = 90_000;

let strictSchema: JsonSchema | null = null;

export function interviewTurnJsonSchema(): JsonSchema {
  strictSchema ??= toStrictJsonSchema(InterviewTurnOutputSchema);
  return strictSchema;
}

/** What the schema cannot say: the turn answers the candidate's message, and its round matches the transcript. */
function inconsistency(inputs: InterviewTurnInput): string | null {
  const candidate = inputs.transcript.filter((m) => m.role === "candidate");
  if (inputs.transcript.at(-1)?.role !== "candidate") return "le dernier message doit être celui du candidat";
  if (candidate.some((m) => m.text.length > MAX_CANDIDATE_CHARS)) {
    return `un message du candidat dépasse ${MAX_CANDIDATE_CHARS} caractères`;
  }
  if (candidate.length !== inputs.round) return `tour ${inputs.round} pour ${candidate.length} message(s) du candidat`;
  if (inputs.round > inputs.maxRounds) return "l'entretien a déjà atteint son nombre de tours";
  return null;
}

export async function runInterviewTurn(
  request: InterviewRequest,
  emit: (event: StageEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const parsedInputs = InterviewTurnInputSchema.safeParse(request.inputs);
  if (!parsedInputs.success) {
    emit({ type: "error", code: "bad_request", message: `Entrées invalides — ${describeIssues(parsedInputs.error.issues)}` });
    return;
  }
  const inputs = parsedInputs.data;
  const problem = inconsistency(inputs);
  if (problem) {
    emit({ type: "error", code: "bad_request", message: `Entretien incohérent — ${problem}.` });
    return;
  }
  const started = Date.now();
  emit({ type: "status", phase: "starting" });

  const engineRequest: EngineRequest = {
    systemPrompt: INTERVIEWER_SYSTEM_PROMPT,
    userMessage: buildTurnMessage(inputs),
    jsonSchema: interviewTurnJsonSchema(),
    effort: TURN_EFFORT,
    timeoutMs: TURN_TIMEOUT_MS,
    signal,
    emit,
  };

  try {
    const result = request.mock
      ? await runMockInterview(request.caseId, inputs.round, engineRequest)
      : await runLiveEngine(engineRequest);

    const parsed = InterviewTurnOutputSchema.safeParse(result.output);
    if (!parsed.success) {
      emit({
        type: "error",
        code: "invalid_output",
        message: `Sortie non conforme au schéma — ${describeIssues(parsed.error.issues)}`,
      });
      return;
    }
    const { data, notes, checks } = normalizeTurn(parsed.data, inputs);
    const ms = Date.now() - started;
    console.info(
      `[interview] round ${inputs.round}/${inputs.maxRounds} ${data.action} in ${(ms / 1000).toFixed(1)}s` +
        (result.model ? ` · ${result.model}` : "") +
        (result.costUsd != null ? ` · $${result.costUsd.toFixed(3)}` : ""),
    );
    emit({ type: "done", data, meta: { ms, model: result.model, costUsd: result.costUsd, notes, usage: result.usage ?? null, checks } });
  } catch (err) {
    const error =
      err instanceof EngineError
        ? err
        : new EngineError("engine_error", err instanceof Error ? err.message : String(err));
    if (error.code !== "aborted") console.warn(`[interview] round ${inputs.round} failed: ${error.code} — ${error.message}`);
    emit({ type: "error", code: error.code, message: error.message });
  }
}
