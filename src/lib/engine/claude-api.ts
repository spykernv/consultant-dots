import ClaudeApi from "@anthropic-ai/sdk";
import type { TokenUsage } from "@/lib/schemas/api";
import type { JsonSchema } from "@/lib/schemas/strict-schema";
import { engineEnv } from "./config";
import { EngineError, TOOL_LIMIT_TEXT, type EngineRequest, type EngineResult, type EngineToolResult, type EngineToolSet } from "./types";

/**
 * Optional engine: the Claude API with a key, billed per token. The default engine stays the Claude Code CLI,
 * which runs on the user's existing Claude login at no extra cost. Same contract as the CLI: same system prompt,
 * same strict JSON Schema, same NDJSON events. When the request carries tools, a manual loop runs their calls in
 * process (runToolLoop).
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

const NO_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});

type Billed = { usage: TokenUsage; costUsd: number | null };

/** What one run has spent and done so far, kept across the fallback-model rerun. */
type RunState = { billed: Billed[]; toolCalls: number };

/** One unknown price makes the whole cost unknown rather than understated. */
function sumBilled(parts: Billed[]): Billed {
  const usage = parts.reduce<TokenUsage>((t, p) => addUsage(t, p.usage), NO_USAGE);
  return { usage, costUsd: parts.every((p) => p.costUsd != null) ? parts.reduce<number>((n, p) => n + (p.costUsd as number), 0) : null };
}

/**
 * When the server-side fallback served the turn, `usage.iterations` lists every billed attempt with its own model;
 * the top-level usage covers only the attempt that answered.
 */
function usageAndCost(message: { model: string; usage: UsageLike & { iterations?: unknown } }, requested: string): Billed {
  const iterations = (Array.isArray(message.usage.iterations) ? message.usage.iterations : []) as (UsageLike & { type: string; model?: string | null })[];
  const billed = iterations.filter((i) => i.type === "message" || i.type === "fallback_message");
  if (!billed.length) {
    const usage = toUsage(message.usage);
    return { usage, costUsd: costOf(message.model, usage) };
  }
  return sumBilled(
    billed.map((i) => {
      const usage = toUsage(i);
      return { usage, costUsd: costOf(i.model ?? requested, usage) };
    }),
  );
}

type MessageParam = ClaudeApi.Beta.BetaMessageParam;
type FinalMessage = ClaudeApi.Beta.BetaMessage;
type ToolUseBlock = ClaudeApi.Beta.BetaToolUseBlock;
/** Tool runs only: the tool list and the tool_choice of one request. */
type Tooling = { tools: ClaudeApi.Beta.BetaToolUnion[]; tool_choice: ClaudeApi.Beta.BetaToolChoice };

/** The case prefix, when the message opens with one, is its own cached block. */
function firstMessage(userMessage: string): MessageParam {
  const parts = splitCasePrefix(userMessage);
  return {
    role: "user",
    content: parts.map((text, i) =>
      i === 0 && parts.length > 1 ? { type: "text" as const, text, cache_control: { type: "ephemeral" as const } } : { type: "text" as const, text },
    ),
  };
}

function openStream(client: ApiClient, model: string, req: EngineRequest, messages: MessageParam[], signal: AbortSignal, tooling?: Tooling) {
  // Thinking is left to the model's default (adaptive on the current models); effort sets its depth.
  return client.beta.messages.stream(
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
      messages,
      ...tooling,
    },
    { signal },
  );
}

/**
 * Relays the progress of one message. Live, its text deltas go straight to the client's JSON buffer; held (tool runs),
 * they wait until the message turns out to be the final answer, since a tool round's text is not that JSON.
 */
async function relayStream(stream: ReturnType<typeof openStream>, req: EngineRequest, live: boolean): Promise<string[]> {
  const held: string[] = [];
  // A server-side fallback continues the same JSON in a new text block: only the first one restarts the client buffer.
  let writing = false;
  for await (const event of stream) {
    if (event.type === "content_block_start") {
      if (event.content_block.type === "thinking" || event.content_block.type === "redacted_thinking") {
        if (!writing) req.emit({ type: "status", phase: "thinking" });
      } else if (event.content_block.type === "text" && !writing && live) {
        writing = true;
        req.emit({ type: "status", phase: "writing" });
      }
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      if (live) req.emit({ type: "delta", text: event.delta.text });
      else held.push(event.delta.text);
    }
  }
  return held;
}

/** Refusal and truncation end the run whatever the message holds: the tools it asked for never run. */
function checkStop(message: FinalMessage) {
  if (message.stop_reason === "refusal") {
    throw new EngineError("engine_error", "Claude a refusé de traiter cette étape. Reformule le case ou réessaie.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new EngineError("invalid_output", "Sortie tronquée : la limite de tokens a été atteinte.");
  }
}

function parseOutput(message: FinalMessage): unknown {
  const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError("invalid_output", "L'API n'a pas renvoyé de JSON valide.");
  }
}

async function streamOnce(client: ApiClient, model: string, req: EngineRequest, signal: AbortSignal): Promise<EngineResult> {
  const stream = openStream(client, model, req, [firstMessage(req.userMessage)], signal);
  await relayStream(stream, req, true);
  const message = await stream.finalMessage();
  checkStop(message);
  const output = parseOutput(message);
  const { usage, costUsd } = usageAndCost(message as never, model);
  return { output, model: message.model, costUsd, rateLimit: null, usage };
}

/**
 * Eager input streaming skips the server's validation of the tool input JSON, so the SDK rejects the stream when a
 * streamed input does not parse. That error comes from the SDK itself, with no HTTP status.
 */
const TOOL_INPUT_UNPARSABLE = /Unable to parse tool parameter JSON/i;
/** Re-issues of one request after an unparsable tool input, before the run fails. */
const TOOL_INPUT_RETRIES = 2;

const isToolInputParseError = (err: unknown) => err instanceof Error && statusOf(err) === undefined && TOOL_INPUT_UNPARSABLE.test(err.message);

async function streamToolRound(
  client: ApiClient,
  model: string,
  req: EngineRequest,
  messages: MessageParam[],
  tooling: Tooling,
  signal: AbortSignal,
  state: RunState,
) {
  for (let retry = 0; ; retry++) {
    // Tools ran since the last request: an abort or a timeout in the meantime ends the run here.
    signal.throwIfAborted();
    const stream = openStream(client, model, req, [...messages], signal, tooling);
    try {
      const held = await relayStream(stream, req, false);
      return { message: await stream.finalMessage(), held };
    } catch (err) {
      if (!isToolInputParseError(err)) throw err;
      // The abandoned request is billed too. Its snapshot holds the usage reported so far (the input, and the output
      // counted at message_start): a lower bound, since the final count never arrives.
      const partial = stream.currentMessage;
      if (partial) state.billed.push(usageAndCost(partial as never, model));
      stream.abort();
      if (retry >= TOOL_INPUT_RETRIES) {
        throw new EngineError("invalid_output", "L'API a renvoyé un appel d'outil illisible, même après deux nouvelles tentatives.");
      }
    }
  }
}

async function runTool(toolSet: EngineToolSet, block: ToolUseBlock, state: RunState): Promise<EngineToolResult> {
  // Counted before it runs: even a call that throws may have changed the tool session.
  state.toolCalls++;
  try {
    return await toolSet.call(block.name, block.input, { callId: block.id });
  } catch (err) {
    // call() is not supposed to throw; if it does, the model learns that the call failed and the reply goes on.
    return { text: `The tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

/** Where the content of the model that answered starts: after the last server-side fallback block, if any. */
const answeringFrom = (content: FinalMessage["content"]) => content.findLastIndex((block) => block.type === "fallback") + 1;

/**
 * An assistant message as it goes back into the history. After a server-side fallback, the declined model's
 * thinking, tool_use and other model-internal blocks are left out, as the API asks: only its text and its paired
 * server-tool blocks echo. The fallback blocks are kept (the API ignores them), and the answering model's content
 * echoes unchanged.
 */
function echoed(content: FinalMessage["content"]): FinalMessage["content"] {
  const start = answeringFrom(content);
  if (!start) return content;
  const declined = content.slice(0, start);
  const resultFor = new Set(declined.flatMap((block) => ("tool_use_id" in block ? [block.tool_use_id] : [])));
  const paired = new Set(
    declined.flatMap((block) => (block.type !== "tool_use" && "id" in block && resultFor.has(block.id) ? [block.id] : [])),
  );
  const kept = declined.filter(
    (block) =>
      block.type === "text" ||
      block.type === "fallback" ||
      ("id" in block && paired.has(block.id)) ||
      ("tool_use_id" in block && paired.has(block.tool_use_id)),
  );
  return [...kept, ...content.slice(start)];
}

/**
 * The manual tool loop: each message that stops on tool_use has its calls run in code and their results sent back,
 * until a message gives the final JSON. The history is append-only: every assistant message goes back unchanged,
 * thinking blocks included, which the API needs to keep the model's reasoning across the calls; only what a
 * server-side fallback declined is left out (echoed).
 */
async function runToolLoop(
  client: ApiClient,
  model: string,
  req: EngineRequest,
  toolSet: EngineToolSet,
  signal: AbortSignal,
  state: RunState,
): Promise<EngineResult> {
  // Same list, same order on every request: the tools open the cached prefix, ahead of the system prompt.
  const tools: ClaudeApi.Beta.BetaToolUnion[] = toolSet.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: forStructuredOutput(tool.inputSchema) as ClaudeApi.Beta.BetaTool.InputSchema,
    strict: true,
    eager_input_streaming: true,
  }));
  const messages: MessageParam[] = [firstMessage(req.userMessage)];
  /** Messages that called tools, refused rounds included, as the CLI engine counts them. */
  let rounds = 0;

  for (;;) {
    // Once the rounds are spent, "none" makes the model answer: forcing a tool ("any", "tool") is rejected by the
    // current models, and the tools must stay listed because the history holds tool_use blocks.
    const tool_choice: ClaudeApi.Beta.BetaToolChoice = rounds < toolSet.maxIterations ? { type: "auto" } : { type: "none" };
    const { message, held } = await streamToolRound(client, model, req, messages, { tools, tool_choice }, signal, state);
    state.billed.push(usageAndCost(message as never, model));
    checkStop(message);

    // After a server-side fallback, only the answering model's calls run: the declined model's never do.
    const calls = message.content
      .slice(answeringFrom(message.content))
      .filter((block): block is ToolUseBlock => block.type === "tool_use");
    if (message.stop_reason !== "tool_use" || !calls.length) {
      if (held.length) {
        req.emit({ type: "status", phase: "writing" });
        for (const text of held) req.emit({ type: "delta", text });
      }
      const output = parseOutput(message);
      const { usage, costUsd } = sumBilled(state.billed);
      return { output, model: message.model, costUsd, rateLimit: null, usage, toolIterations: rounds };
    }
    // One refused round is answered; calling tools again after it ends the run.
    if (rounds > toolSet.maxIterations) {
      throw new EngineError("invalid_output", "Claude a continué d'appeler des outils au lieu de répondre.");
    }

    messages.push({ role: "assistant", content: echoed(message.content) });
    // "none" should rule out calls past the limit; if some come anyway, they are answered without running, once.
    const withinLimit = rounds < toolSet.maxIterations;
    const results: ClaudeApi.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const result = withinLimit ? await runTool(toolSet, call, state) : { text: TOOL_LIMIT_TEXT, isError: true };
      results.push({ type: "tool_result", tool_use_id: call.id, content: result.text, is_error: result.isError });
    }
    messages.push({ role: "user", content: results });
    rounds++;
  }
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

  // One state for both attempts: the requests of an abandoned attempt are billed with the rerun's.
  const state: RunState = { billed: [], toolCalls: 0 };
  const attempt = async (model: string) => {
    try {
      return await (req.tools
        ? runToolLoop(client, model, req, req.tools, controller.signal, state)
        : streamOnce(client, model, req, controller.signal));
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
      // Not once a tool ran: the tool session keeps that attempt's reveals, budget and trace, and a rerun would add
      // to them. The overload goes back instead, and the client's Retry starts the turn with a fresh session.
      const canRerun = err instanceof EngineError && err.code === "overloaded" && state.toolCalls === 0;
      if (canRerun && env.fallbackModel && env.fallbackModel !== env.model) {
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
