import type { EngineErrorCode, StageEvent, TokenUsage } from "@/lib/schemas/api";
import type { JsonSchema } from "@/lib/schemas/strict-schema";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type EngineRequest = {
  systemPrompt: string;
  userMessage: string;
  jsonSchema: JsonSchema;
  effort: Effort;
  timeoutMs: number;
  signal: AbortSignal;
  emit: (event: StageEvent) => void;
};

export type RateLimitInfo = {
  status: string;
  rateLimitType: string | null;
  fiveHourUtilization: number | null;
  sevenDayUtilization: number | null;
  resetsAt: number | null;
};

export type EngineResult = {
  output: unknown;
  model: string | null;
  costUsd: number | null;
  rateLimit: RateLimitInfo | null;
  usage?: TokenUsage | null;
};

export class EngineError extends Error {
  constructor(
    public code: EngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}
