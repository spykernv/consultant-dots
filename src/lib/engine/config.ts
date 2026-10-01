import type { StageId } from "@/lib/schemas";
import type { Effort } from "./types";

export const STAGE_EFFORT: Record<StageId, Effort> = {
  classify: "low",
  frame: "medium",
  questions: "medium",
  diagnose: "medium",
  currentState: "low",
  options: "medium",
  target: "medium",
  roadmap: "medium",
  oral: "low",
  challenge: "medium",
};

export const STAGE_TIMEOUT_MS = 150_000;
export const MAX_CONCURRENT_RUNS = 3;

export function engineEnv() {
  return {
    model: process.env.CONSULTANT_DOTS_MODEL?.trim() || "claude-opus-5-5",
    fallbackModel: process.env.CONSULTANT_DOTS_FALLBACK_MODEL?.trim() || "claude-opus-5",
    claudeBin: process.env.CONSULTANT_DOTS_CLAUDE_BIN?.trim() || null,
    auth: process.env.CONSULTANT_DOTS_CLAUDE_AUTH?.trim() === "inherit" ? ("inherit" as const) : ("subscription" as const),
    recordFixtures: process.env.CONSULTANT_DOTS_RECORD_FIXTURES === "1",
  };
}
