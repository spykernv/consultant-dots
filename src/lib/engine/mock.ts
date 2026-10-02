import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StageId } from "@/lib/schemas";
import { EngineError, type EngineRequest, type EngineResult } from "./types";

export const DEFAULT_DEMO_CASE = "data-platform";

const CHUNK = 48;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function fixturePath(caseId: string, stage: StageId) {
  return path.join(process.cwd(), "fixtures", "mock", caseId, `${stage}.json`);
}

export function recordFixture(caseId: string, stage: StageId, data: unknown) {
  const file = fixturePath(caseId, stage);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function runMock(stage: StageId, caseId: string | null, req: EngineRequest): Promise<EngineResult> {
  const file = [caseId, DEFAULT_DEMO_CASE]
    .filter((id): id is string => Boolean(id))
    .map((id) => fixturePath(id, stage))
    .find((candidate) => existsSync(candidate));
  if (!file) throw new EngineError("engine_error", `Aucune sortie de démo enregistrée pour l'étape « ${stage} ».`);
  return replay(JSON.parse(readFileSync(file, "utf8")) as unknown, req);
}

export function interviewFixturePath(caseId: string) {
  return path.join(process.cwd(), "fixtures", "mock", caseId, "interview.json");
}

type ScriptedCall = { name: string; input: unknown };

/** A recorded turn's tool calls: its "toolCalls" when it has them, else one get_client_answer per answer it reveals. */
function scriptedCalls(turn: Record<string, unknown>): ScriptedCall[] {
  if (Array.isArray(turn.toolCalls)) {
    return turn.toolCalls
      .filter((call): call is Record<string, unknown> => Boolean(call) && typeof call === "object")
      .filter((call) => typeof call.name === "string")
      .map((call) => ({ name: call.name as string, input: call.input }));
  }
  const reveal = Array.isArray(turn.reveal) ? turn.reveal : [];
  return reveal
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({ name: "get_client_answer", input: { question_id: id } }));
}

/**
 * The scripted client of the demo: round N replays the Nth recorded turn, and the last one once the script runs out.
 * With tools, the turn's calls go through them first, as one round, so the code decides what they give exactly as in
 * a live run; the replayed JSON then holds only what a tool-mode model returns.
 */
export async function runMockInterview(caseId: string | null, round: number, req: EngineRequest): Promise<EngineResult> {
  const file = [caseId, DEFAULT_DEMO_CASE]
    .filter((id): id is string => Boolean(id))
    .map(interviewFixturePath)
    .find((candidate) => existsSync(candidate));
  const turns = file ? (JSON.parse(readFileSync(file, "utf8")) as unknown) : null;
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new EngineError("engine_error", "Aucun entretien de démo enregistré pour ce case.");
  }
  const recorded = turns[Math.min(Math.max(round, 1), turns.length) - 1] as unknown;
  const turn = recorded && typeof recorded === "object" && !Array.isArray(recorded) ? (recorded as Record<string, unknown>) : null;
  if (!req.tools) {
    // The tool script is not part of a structured turn's output.
    const scripted = turn && "toolCalls" in turn;
    return replay(scripted ? Object.fromEntries(Object.entries(turn).filter(([key]) => key !== "toolCalls")) : recorded, req);
  }

  if (req.signal.aborted) throw new EngineError("aborted", "Étape arrêtée.");
  const calls = turn ? scriptedCalls(turn) : [];
  for (const [i, call] of calls.entries()) {
    await req.tools.call(call.name, call.input, { callId: `mock-${round}-${i}` });
  }
  const result = await replay({ reply: turn?.reply, action: turn?.action, done: turn?.done }, req);
  return { ...result, toolIterations: calls.length ? 1 : 0 };
}

/** Streams a recorded output with the same events and rhythm as a live run. */
async function replay(output: unknown, req: EngineRequest): Promise<EngineResult> {
  const text = JSON.stringify(output);

  req.emit({ type: "status", phase: "thinking" });
  await sleep(350);
  req.emit({ type: "status", phase: "writing" });
  for (let i = 0; i < text.length; i += CHUNK) {
    if (req.signal.aborted) throw new EngineError("aborted", "Étape arrêtée.");
    req.emit({ type: "delta", text: text.slice(i, i + CHUNK) });
    await sleep(10);
  }
  return { output, model: "démo (sorties enregistrées)", costUsd: 0, rateLimit: null };
}
