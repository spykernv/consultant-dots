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

/** The scripted client of the demo: round N replays the Nth recorded turn, and the last one once the script runs out. */
export async function runMockInterview(caseId: string | null, round: number, req: EngineRequest): Promise<EngineResult> {
  const file = [caseId, DEFAULT_DEMO_CASE]
    .filter((id): id is string => Boolean(id))
    .map(interviewFixturePath)
    .find((candidate) => existsSync(candidate));
  const turns = file ? (JSON.parse(readFileSync(file, "utf8")) as unknown) : null;
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new EngineError("engine_error", "Aucun entretien de démo enregistré pour ce case.");
  }
  return replay(turns[Math.min(Math.max(round, 1), turns.length) - 1], req);
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
