import { engineEnv } from "./config";
import { runClaudeApi } from "./claude-api";
import { runClaudeCode } from "./claude-code";
import type { EngineRequest, EngineResult } from "./types";

/** The live engine CONSULTANT_DOTS_ENGINE selects: the Claude Code CLI on the user's login unless the API is chosen. */
export function runLiveEngine(req: EngineRequest): Promise<EngineResult> {
  return engineEnv().engine === "api" ? runClaudeApi(req) : runClaudeCode(req);
}
