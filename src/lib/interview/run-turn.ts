import type { StageEvent } from "@/lib/schemas/api";
import { toStrictJsonSchema, type JsonSchema } from "@/lib/schemas/strict-schema";
import { engineEnv } from "@/lib/engine/config";
import { runLiveEngine } from "@/lib/engine/dispatch";
import { runMockInterview } from "@/lib/engine/mock";
import { EngineError, type Effort, type EngineRequest } from "@/lib/engine/types";
import { describeIssues } from "@/lib/pipeline/run-stage";
import {
  InterviewReplySchema,
  InterviewTurnInputSchema,
  InterviewTurnOutputSchema,
  MAX_CANDIDATE_CHARS,
  type InterviewRequest,
  type InterviewTurnInput,
  type InterviewTurnOutput,
  type InterviewTurnResult,
  type ToolTrace,
} from "./schema";
import { buildToolTurnMessage, buildTurnMessage, INTERVIEWER_SYSTEM_PROMPT, INTERVIEWER_TOOLS_SYSTEM_PROMPT } from "./prompt";
import { maskEmails, normalizeTurn, type NormalizedTurn } from "./normalize";
import { createInterviewTools, type InterviewToolSession } from "./tools";

/** A client's reply is short and the candidate is waiting: low effort, and a tighter timeout than a pipeline stage. */
export const TURN_EFFORT: Effort = "low";
export const TURN_TIMEOUT_MS = 90_000;
/** Tool mode: a reply may take a few round trips (an answer looked up, a weakness noted) before its JSON. */
export const TOOL_TURN_TIMEOUT_MS = 120_000;

let strictSchema: JsonSchema | null = null;
let strictReplySchema: JsonSchema | null = null;

export function interviewTurnJsonSchema(): JsonSchema {
  strictSchema ??= toStrictJsonSchema(InterviewTurnOutputSchema);
  return strictSchema;
}

/** Tool mode: no "reveal" to fill, since the code derives it from the get_client_answer calls. */
export function interviewReplyJsonSchema(): JsonSchema {
  strictReplySchema ??= toStrictJsonSchema(InterviewReplySchema);
  return strictReplySchema;
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

type ParsedTurn = { ok: true; output: InterviewTurnOutput } | { ok: false; issues: { path: PropertyKey[]; message: string }[] };

/** Tool mode: the reveal is what get_client_answer gave; a "reveal" the model still writes is dropped by the parse. */
function parseTurn(output: unknown, session: InterviewToolSession | null): ParsedTurn {
  if (!session) {
    const parsed = InterviewTurnOutputSchema.safeParse(output);
    return parsed.success ? { ok: true, output: parsed.data } : { ok: false, issues: parsed.error.issues };
  }
  const parsed = InterviewReplySchema.safeParse(output);
  return parsed.success
    ? { ok: true, output: { ...parsed.data, reveal: session.revealed() } }
    : { ok: false, issues: parsed.error.issues };
}

/**
 * The calls as the transcript shows them. A new answer the code dropped with the model's reply (empty, refused close,
 * questions only) was looked up but never given: its calls read as not ok. An answer recalled from an earlier turn stays.
 */
function tracedCalls(session: InterviewToolSession, reveal: string[]): ToolTrace[] {
  const dropped = new Set(session.revealed().filter((id) => !reveal.includes(id)));
  return session
    .trace()
    .map((call) => (call.name === "get_client_answer" && call.ok && dropped.has(call.target) ? { ...call, ok: false } : call));
}

/** The normalized turn with what the calls did. The calls ran first, so their notes come first. */
function withToolResults(turn: NormalizedTurn, session: InterviewToolSession, toolIterations: number) {
  let masked = 0;
  // The notes reach the debrief and the exports: same e-mail guard as the reply, counted but never announced.
  const observations = session.observations().map((o) => {
    const note = maskEmails(o.note);
    masked += note.count;
    return { ...o, note: note.text };
  });
  const data: InterviewTurnResult = { ...turn.data, observations, toolCalls: tracedCalls(session, turn.data.reveal) };
  return {
    data,
    notes: [...session.notes(), ...turn.notes],
    checks: { ...turn.checks, ...session.checks(), emailMasked: (turn.checks.emailMasked ?? 0) + masked, toolIterations },
  };
}

/** For the server log: how many calls of each tool, never their targets (a quote is the candidate's words). */
function describeToolCalls(trace: ToolTrace[]): string {
  if (!trace.length) return "no tool call";
  const counts = new Map<string, number>();
  for (const call of trace) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
  const refused = trace.filter((call) => !call.ok).length;
  return (
    `tools ${[...counts].map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(", ")}` +
    (refused ? ` (${refused} refused)` : "")
  );
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

  // Tool mode, live and demo alike: the client looks its answers up, and the code counts what it gave from the calls.
  const session = engineEnv().interviewTools ? createInterviewTools(inputs) : null;
  const engineRequest: EngineRequest = session
    ? {
        systemPrompt: INTERVIEWER_TOOLS_SYSTEM_PROMPT,
        userMessage: buildToolTurnMessage(inputs),
        jsonSchema: interviewReplyJsonSchema(),
        effort: TURN_EFFORT,
        timeoutMs: TOOL_TURN_TIMEOUT_MS,
        signal,
        emit,
        tools: session,
      }
    : {
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

    const parsed = parseTurn(result.output, session);
    if (!parsed.ok) {
      emit({
        type: "error",
        code: "invalid_output",
        message: `Sortie non conforme au schéma — ${describeIssues(parsed.issues)}`,
      });
      return;
    }
    const normalized = normalizeTurn(parsed.output, inputs);
    const { data, notes, checks } = session ? withToolResults(normalized, session, result.toolIterations ?? 0) : normalized;
    const ms = Date.now() - started;
    console.info(
      `[interview] round ${inputs.round}/${inputs.maxRounds} ${data.action} in ${(ms / 1000).toFixed(1)}s` +
        (session ? ` · ${describeToolCalls(session.trace())}` : "") +
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
