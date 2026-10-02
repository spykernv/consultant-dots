import type { EngineErrorCode, StageEvent, TokenUsage } from "@/lib/schemas/api";
import type { JsonSchema } from "@/lib/schemas/strict-schema";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A tool the model may call during one run. Both live engines expose the same set, so the code runs it once. */
export type EngineTool = {
  name: string;
  description: string;
  /** Strict JSON Schema of the input: an object, every property required, additionalProperties false. */
  inputSchema: JsonSchema;
};

/** What a call returns to the model. An error result tells the model the call failed or was refused, and why. */
export type EngineToolResult = { text: string; isError: boolean };

/** Identifies one call when the engine can: the tool_use id the model gave it. */
export type EngineToolCallContext = { callId?: string };

export type EngineToolSet = {
  /** Server name on the CLI engine, where the tools reach the model as mcp__<serverName>__<tool>. */
  serverName: string;
  /** Fixed order and content: the tool list is part of the cached prompt prefix. */
  tools: EngineTool[];
  /** Validates and runs one call. Never throws: a bad input or a refused call is an error result. */
  call(name: string, input: unknown, context?: EngineToolCallContext): Promise<EngineToolResult>;
  /** Model round trips that may call tools before the final answer; each engine enforces it in code. */
  maxIterations: number;
};

/** What an engine answers to a call past maxIterations, instead of running it. */
export const TOOL_LIMIT_TEXT =
  "No more tool calls for this reply: answer the candidate now, as JSON matching the provided schema.";

export type EngineRequest = {
  systemPrompt: string;
  userMessage: string;
  jsonSchema: JsonSchema;
  effort: Effort;
  timeoutMs: number;
  signal: AbortSignal;
  emit: (event: StageEvent) => void;
  /** Tools the model may call before it returns the JSON; absent for the pipeline stages. */
  tools?: EngineToolSet;
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
  /** Tool runs only: the model round trips that called at least one tool. */
  toolIterations?: number;
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
