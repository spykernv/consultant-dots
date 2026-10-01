import ClaudeApi from "@anthropic-ai/sdk";
import type { TokenUsage } from "@/lib/schemas/api";
import type { JsonSchema } from "@/lib/schemas/strict-schema";
import { engineEnv } from "./config";
import { EngineError, type EngineRequest, type EngineResult } from "./types";

/**
 * Optional engine: the Claude API with a key, billed per token. The default engine stays the Claude Code CLI,
 * which runs on the user's existing Claude login at no extra cost. Same contract as the CLI: same system prompt,
 * same strict JSON Schema, same NDJSON events.
 */

const MAX_TOKENS = 32_000;
/** Routes a safety-classifier refusal to another model inside the same call instead of failing the stage. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** $ per million tokens; cache writes (5 min) cost 1.25x input. Unknown models report no cost rather than a guess. */
const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export function costOf(model: string, usage: TokenUsage): number | null {
  const price = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, "")];
  if (!price) return null;
  const perToken = (usd: number) => usd / 1_000_000;
  return (
    usage.input * perToken(price.input) +
    usage.cacheWrite * perToken(price.input * 1.25) +
    usage.cacheRead * perToken(price.cacheRead) +
    usage.output * perToken(price.output)
  );
}

/** Structured outputs take `anyOf` for nullable fields; the strict schema writes them as `type: [T, "null"]`. */
export function forStructuredOutput(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema)) return schema.map((item) => forStructuredOutput(item as JsonSchema)) as unknown as JsonSchema;
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    out[key] = value && typeof value === "object" ? forStructuredOutput(value as JsonSchema) : value;
  }
  if (Array.isArray(out.type) && out.type.includes("null") && out.type.length > 1) {
    const { type, description, ...rest } = out as { type: string[]; description?: string };
    const variants = type.map((t) => (t === "null" ? { type: "null" } : { ...rest, type: t }));
    return { ...(description ? { description } : {}), anyOf: variants } as JsonSchema;
  }
  return out as JsonSchema;
}

/**
 * The system prompt and the `<case>` block open every stage of a case: two cache breakpoints let the later stages
 * read that prefix from the cache instead of paying for it again.
 */
export function splitCasePrefix(userMessage: string): [string, string] | [string] {
  const end = userMessage.startsWith("<case>") ? userMessage.indexOf("</case>") : -1;
  if (end < 0) return [userMessage];
  const cut = end + "</case>".length;
  const rest = userMessage.slice(cut).replace(/^\s+/, "");
  return rest ? [userMessage.slice(0, cut), rest] : [userMessage.slice(0, cut)];
}

type ApiClient = Pick<ClaudeApi, "beta" | "models">;

let shared: { key: string | null; client: ApiClient } | null = null;

/**
 * Without CONSULTANT_DOTS_API_KEY the SDK resolves its own standard credentials (environment or CLI profile).
 * Keyed on the key so that a changed key takes effect without restarting the server.
 */
function defaultClient(): ApiClient {
  const key = engineEnv().apiKey;
  if (!shared || shared.key !== key) {
    shared = { key, client: new ClaudeApi({ apiKey: key ?? undefined, maxRetries: 2, timeout: 10 * 60_000 }) };
  }
  return shared.client;
}

/** Errors raised inside a stream arrive after the HTTP 200, with no status: their type tells what happened. */
const STATUS_BY_TYPE: Record<string, number> = {
  authentication_error: 401,
  permission_error: 403,
  invalid_request_error: 400,
  rate_limit_error: 429,
  overloaded_error: 529,
};

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: unknown; type?: unknown; error?: { error?: { type?: unknown } } } | null;
  if (typeof e?.status === "number") return e.status;
  const type = typeof e?.type === "string" ? e.type : e?.error?.error?.type;
  return typeof type === "string" ? STATUS_BY_TYPE[type] : undefined;
}

function mapApiError(err: unknown): EngineError {
  if (err instanceof EngineError) return err;
  const message = err instanceof Error ? err.message : String(err);
  // The SDK resolves credentials lazily and raises this plain error at request time when it finds none.
  if (/Could not resolve authentication method/i.test(message)) {
    return new EngineError("not_logged_in", "Aucune clé API trouvée : renseigne CONSULTANT_DOTS_API_KEY dans .env.local.");
  }
  switch (statusOf(err)) {
    case 401:
    case 403:
      return new EngineError("not_logged_in", "Clé API refusée : vérifie CONSULTANT_DOTS_API_KEY (ou repasse au moteur Claude Code).");
    case 429:
      return new EngineError("usage_limit", "Limite de débit de l'API atteinte. Réessaie dans un instant.");
    case 529:
      return new EngineError("overloaded", "L'API Claude est surchargée. Réessaie dans un instant.");
    case 400:
      return new EngineError("engine_error", `Requête refusée par l'API : ${message}`);
    default:
      return new EngineError("engine_error", `Erreur de l'API Claude : ${message}`);
  }
}

type UsageLike = { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

const toUsage = (u: UsageLike): TokenUsage => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cacheRead: u.cache_read_input_tokens ?? 0,
  cacheWrite: u.cache_creation_input_tokens ?? 0,
});

/**
 * When the server-side fallback served the turn, `usage.iterations` lists every billed attempt with its own model;
 * the top-level usage covers only the attempt that answered.
 */
function usageAndCost(message: { model: string; usage: UsageLike & { iterations?: unknown } }, requested: string) {
  const iterations = (Array.isArray(message.usage.iterations) ? message.usage.iterations : []) as (UsageLike & { type: string; model?: string | null })[];
  const billed = iterations.filter((i) => i.type === "message" || i.type === "fallback_message");
  if (!billed.length) {
    const usage = toUsage(message.usage);
    return { usage, costUsd: costOf(message.model, usage) };
  }
  const parts = billed.map((i) => ({ usage: toUsage(i), model: i.model ?? requested }));
  const usage = parts.reduce<TokenUsage>(
    (t, p) => ({ input: t.input + p.usage.input, output: t.output + p.usage.output, cacheRead: t.cacheRead + p.usage.cacheRead, cacheWrite: t.cacheWrite + p.usage.cacheWrite }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const costs = parts.map((p) => costOf(p.model, p.usage));
  return { usage, costUsd: costs.every((c) => c != null) ? costs.reduce<number>((n, c) => n + (c as number), 0) : null };
}

async function streamOnce(client: ApiClient, model: string, req: EngineRequest, signal: AbortSignal): Promise<EngineResult> {
  const parts = splitCasePrefix(req.userMessage);
  // Thinking is left to the model's default (adaptive on the current models); effort sets its depth.
  const stream = client.beta.messages.stream(
    {
      model,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: {
        effort: req.effort,
        format: { type: "json_schema", schema: forStructuredOutput(req.jsonSchema) as Record<string, unknown> },
      },
      system: [{ type: "text", text: req.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: parts.map((text, i) =>
            i === 0 && parts.length > 1 ? { type: "text" as const, text, cache_control: { type: "ephemeral" as const } } : { type: "text" as const, text },
          ),
        },
      ],
    },
    { signal },
  );

  // A server-side fallback continues the same JSON in a new text block: only the first one restarts the client buffer.
  let writing = false;
  for await (const event of stream) {
    if (event.type === "content_block_start") {
      if (event.content_block.type === "thinking" || event.content_block.type === "redacted_thinking") {
        if (!writing) req.emit({ type: "status", phase: "thinking" });
      } else if (event.content_block.type === "text" && !writing) {
        writing = true;
        req.emit({ type: "status", phase: "writing" });
      }
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      req.emit({ type: "delta", text: event.delta.text });
    }
  }

  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new EngineError("engine_error", "Claude a refusé de traiter cette étape. Reformule le case ou réessaie.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new EngineError("invalid_output", "Sortie tronquée : la limite de tokens a été atteinte.");
  }
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch {
    throw new EngineError("invalid_output", "L'API n'a pas renvoyé de JSON valide.");
  }
  const { usage, costUsd } = usageAndCost(message as never, model);
  return { output, model: message.model, costUsd, rateLimit: null, usage };
}

export async function runClaudeApi(req: EngineRequest, injected?: ApiClient): Promise<EngineResult> {
  if (req.signal.aborted) throw new EngineError("aborted", "Étape arrêtée.");
  const env = engineEnv();
  const client = injected ?? defaultClient();
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  req.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, req.timeoutMs);

  const attempt = async (model: string) => {
    try {
      return await streamOnce(client, model, req, controller.signal);
    } catch (err) {
      if (req.signal.aborted) throw new EngineError("aborted", "Étape arrêtée.");
      if (timedOut) throw new EngineError("timeout", `Délai dépassé (${Math.round(req.timeoutMs / 1000)} s).`);
      throw mapApiError(err);
    }
  };

  try {
    try {
      return await attempt(env.model);
    } catch (err) {
      // The SDK already retried the overload; one more try on the fallback model, as the CLI's --fallback-model does.
      if (err instanceof EngineError && err.code === "overloaded" && env.fallbackModel && env.fallbackModel !== env.model) {
        return await attempt(env.fallbackModel);
      }
      throw err;
    }
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener("abort", onAbort);
  }
}

export type ApiHealth = { ok: boolean; model: string; error: string | null };

/** A free call (model lookup) that checks the key and the model without spending tokens. */
export async function apiHealth(injected?: ApiClient): Promise<ApiHealth> {
  const { model } = engineEnv();
  try {
    await (injected ?? defaultClient()).models.retrieve(model);
    return { ok: true, model, error: null };
  } catch (err) {
    return { ok: false, model, error: mapApiError(err).message };
  }
}
