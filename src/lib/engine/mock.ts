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

  const output = JSON.parse(readFileSync(file, "utf8")) as unknown;
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
