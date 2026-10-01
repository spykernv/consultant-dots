import { STAGE_SCHEMAS, type StageId, type StageOutputs } from "@/lib/schemas";
import { STAGE_INPUT_SCHEMAS, type StageEvent, type StageInputs, type StageRequest } from "@/lib/schemas/api";
import { toStrictJsonSchema, type JsonSchema } from "@/lib/schemas/strict-schema";
import { SYSTEM_PROMPT } from "@/lib/prompts/system";
import { buildUserMessage, type Revision } from "@/lib/prompts/stages";
import { engineEnv, STAGE_EFFORT, STAGE_TIMEOUT_MS } from "@/lib/engine/config";
import { runLiveEngine } from "@/lib/engine/dispatch";
import { recordFixture, runMock } from "@/lib/engine/mock";
import { EngineError, type EngineRequest } from "@/lib/engine/types";
import { normalizeStage } from "./normalize";
import { stageChecks } from "./checks";

const strictSchemas = new Map<StageId, JsonSchema>();

export function strictSchemaFor(stage: StageId): JsonSchema {
  let schema = strictSchemas.get(stage);
  if (!schema) {
    schema = toStrictJsonSchema(STAGE_SCHEMAS[stage]);
    strictSchemas.set(stage, schema);
  }
  return schema;
}

export function describeIssues(issues: { path: PropertyKey[]; message: string }[]) {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(racine)"} : ${i.message}`)
    .join(" ; ");
}

export async function runStage<K extends StageId>(
  stage: K,
  request: StageRequest,
  emit: (event: StageEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const parsedInputs = STAGE_INPUT_SCHEMAS[stage].safeParse(request.inputs);
  if (!parsedInputs.success) {
    emit({ type: "error", code: "bad_request", message: `Entrées invalides — ${describeIssues(parsedInputs.error.issues)}` });
    return;
  }
  const inputs = parsedInputs.data as StageInputs[K];
  const started = Date.now();
  emit({ type: "status", phase: "starting" });

  const previous = request.previous != null ? STAGE_SCHEMAS[stage].safeParse(request.previous) : null;
  const revision: Revision | null =
    request.steer !== null || previous?.success
      ? { steer: request.steer, previous: previous?.success ? previous.data : null, choices: request.choices }
      : null;

  const engineRequest: EngineRequest = {
    systemPrompt: SYSTEM_PROMPT,
    userMessage: buildUserMessage(stage, inputs, revision, request.choices),
    jsonSchema: strictSchemaFor(stage),
    effort: STAGE_EFFORT[stage],
    timeoutMs: STAGE_TIMEOUT_MS,
    signal,
    emit,
  };

  try {
    const result = request.mock ? await runMock(stage, request.caseId, engineRequest) : await runLiveEngine(engineRequest);

    const parsed = STAGE_SCHEMAS[stage].safeParse(result.output);
    if (!parsed.success) {
      emit({
        type: "error",
        code: "invalid_output",
        message: `Sortie non conforme au schéma — ${describeIssues(parsed.error.issues)}`,
      });
      return;
    }
    const { data, notes } = normalizeStage(stage, parsed.data as StageOutputs[K], inputs);
    const checks = stageChecks(stage, parsed.data as StageOutputs[K], data, inputs);
    const ms = Date.now() - started;

    if (!request.mock && !revision && request.caseId && engineEnv().recordFixtures) {
      recordFixture(request.caseId, stage, data);
    }
    console.info(
      `[stage] ${stage} ok in ${(ms / 1000).toFixed(1)}s` +
        (result.model ? ` · ${result.model}` : "") +
        (result.costUsd != null ? ` · $${result.costUsd.toFixed(3)}` : ""),
    );
    emit({ type: "done", data, meta: { ms, model: result.model, costUsd: result.costUsd, notes, usage: result.usage ?? null, checks } });
  } catch (err) {
    const error =
      err instanceof EngineError
        ? err
        : new EngineError("engine_error", err instanceof Error ? err.message : String(err));
    if (error.code !== "aborted") console.warn(`[stage] ${stage} failed: ${error.code} — ${error.message}`);
    emit({ type: "error", code: error.code, message: error.message });
  }
}
