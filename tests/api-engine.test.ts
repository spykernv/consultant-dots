import { afterEach, describe, expect, it, vi } from "vitest";
import { apiHealth, costOf, forStructuredOutput, runClaudeApi, splitCasePrefix } from "@/lib/engine/claude-api";
import { EngineError, type EngineRequest } from "@/lib/engine/types";
import type { StageEvent } from "@/lib/schemas/api";
import type { JsonSchema } from "@/lib/schemas/strict-schema";

type Event = Record<string, unknown>;
type Final = { stop_reason: string; model: string; content: { type: string; text?: string }[]; usage: Record<string, number> };

const finalOk = (text: string, model = "claude-opus-5-5"): Final => ({
  stop_reason: "end_turn",
  model,
  content: [{ type: "thinking" }, { type: "text", text }],
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
});

/** A fake client whose stream replays `events` then resolves `final`, or throws `error`, per model. */
function fakeClient(plan: (model: string) => { events?: Event[]; final?: Final; error?: unknown; hang?: boolean }) {
  const calls: { params: Record<string, unknown>; options: { signal?: AbortSignal } }[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>, options: { signal?: AbortSignal }) {
          calls.push({ params, options });
          const step = plan(String(params.model));
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of step.events ?? []) yield event;
              if (step.hang) {
                await new Promise((_, reject) =>
                  options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted."))),
                );
              }
              if (step.error) throw step.error;
            },
            finalMessage: async () => step.final!,
          };
        },
      },
    },
    models: { retrieve: vi.fn(async () => ({ id: "claude-opus-5-5" })) },
  };
  return { client: client as never, calls, models: client.models };
}

function request(overrides: Partial<EngineRequest> = {}) {
  const events: StageEvent[] = [];
  const req: EngineRequest = {
    systemPrompt: "SYSTEM",
    userMessage: "<case>\nUn groupe industriel.\n</case>\n\n<step>\nFrame it.\n</step>",
    jsonSchema: { type: "object", properties: { note: { type: ["string", "null"] } }, required: ["note"], additionalProperties: false },
    effort: "medium",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    ...overrides,
  };
  return { req, events };
}

const textEvents = (json: string): Event[] => [
  { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  { type: "content_block_start", index: 1, content_block: { type: "text" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: json.slice(0, 5) } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: json.slice(5) } },
];

const apiError = (status: number) => Object.assign(new Error(`status ${status}`), { status });

afterEach(() => {
  delete process.env.CONSULTANT_DOTS_MODEL;
  delete process.env.CONSULTANT_DOTS_FALLBACK_MODEL;
});

describe("API engine", () => {
  it("writes nullable fields as anyOf for structured outputs, everywhere in the schema", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: ["string", "null"], description: "maybe" },
        list: { type: "array", items: { type: "object", properties: { b: { type: ["string", "null"], enum: ["x", "y", null] } } } },
        c: { type: "string" },
      },
    } as JsonSchema;
    const out = forStructuredOutput(schema) as { properties: Record<string, Record<string, unknown>> };
    expect(out.properties.a).toEqual({ description: "maybe", anyOf: [{ type: "string" }, { type: "null" }] });
    const items = (out.properties.list.items as { properties: Record<string, unknown> }).properties;
    expect(items.b).toEqual({ anyOf: [{ type: "string", enum: ["x", "y", null] }, { type: "null" }] });
    expect(out.properties.c).toEqual({ type: "string" });
    expect(JSON.stringify(out)).not.toContain('"type":["');
  });

  it("splits the shared case prefix from the stage-specific part", () => {
    expect(splitCasePrefix("<case>\nX\n</case>\n\n<step>\nY\n</step>")).toEqual(["<case>\nX\n</case>", "<step>\nY\n</step>"]);
    expect(splitCasePrefix("<context>\nno case first\n</context>")).toEqual(["<context>\nno case first\n</context>"]);
  });

  it("streams the JSON as deltas and returns the parsed output with usage and cost", async () => {
    const json = '{"note":"ok"}';
    const { client, calls } = fakeClient(() => ({ events: textEvents(json), final: finalOk(json) }));
    const { req, events } = request();
    const result = await runClaudeApi(req, client);

    expect(result.output).toEqual({ note: "ok" });
    expect(result.usage).toEqual({ input: 1000, output: 500, cacheRead: 2000, cacheWrite: 0 });
    expect(result.costUsd).toBeCloseTo(1000 * 4e-6 + 2000 * 0.2e-6 + 500 * 20e-6, 9);
    expect(events).toEqual([
      { type: "status", phase: "thinking" },
      { type: "status", phase: "writing" },
      { type: "delta", text: json.slice(0, 5) },
      { type: "delta", text: json.slice(5) },
    ]);

    const params = calls[0].params as {
      model: string;
      output_config: { effort: string; format: { type: string; schema: unknown } };
      system: { cache_control?: unknown }[];
      messages: { content: { text: string; cache_control?: unknown }[] }[];
      thinking?: unknown;
      fallbacks: unknown;
    };
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.thinking).toBeUndefined();
    expect(params.fallbacks).toBe("default");
    expect(params.output_config.effort).toBe("medium");
    expect(params.output_config.format.type).toBe("json_schema");
    expect(JSON.stringify(params.output_config.format.schema)).toContain('"anyOf"');
    expect(params.system[0].cache_control).toEqual({ type: "ephemeral" });
    const [prefix, rest] = params.messages[0].content;
    expect(prefix.text.startsWith("<case>")).toBe(true);
    expect(prefix.cache_control).toEqual({ type: "ephemeral" });
    expect(rest.cache_control).toBeUndefined();
  });

  it("maps refusals, truncation and non-JSON output to stage errors", async () => {
    for (const [final, code] of [
      [{ ...finalOk("{}"), stop_reason: "refusal" }, "engine_error"],
      [{ ...finalOk('{"note":'), stop_reason: "max_tokens" }, "invalid_output"],
      [finalOk("not json"), "invalid_output"],
    ] as const) {
      const { client } = fakeClient(() => ({ final }));
      await expect(runClaudeApi(request().req, client)).rejects.toMatchObject({ code });
    }
  });

  it("retries an overloaded model once on the fallback model", async () => {
    process.env.CONSULTANT_DOTS_FALLBACK_MODEL = "claude-opus-5";
    const json = '{"note":null}';
    const { client, calls } = fakeClient((model) =>
      model === "claude-opus-5-5" ? { error: apiError(529) } : { events: textEvents(json), final: finalOk(json, "claude-opus-5") },
    );
    const result = await runClaudeApi(request().req, client);
    expect(calls.map((c) => c.params.model)).toEqual(["claude-opus-5-5", "claude-opus-5"]);
    expect(result.model).toBe("claude-opus-5");
  });

  it("recognises errors raised inside the stream by their type, and falls back on an overload", async () => {
    process.env.CONSULTANT_DOTS_FALLBACK_MODEL = "claude-opus-5";
    const json = '{"note":"ok"}';
    const midStream = Object.assign(new Error('{"type":"error","error":{"type":"overloaded_error"}}'), { status: undefined, type: "overloaded_error" });
    const { client, calls } = fakeClient((model) =>
      model === "claude-opus-5-5" ? { events: textEvents(json).slice(0, 3), error: midStream } : { events: textEvents(json), final: finalOk(json, "claude-opus-5") },
    );
    expect((await runClaudeApi(request().req, client)).model).toBe("claude-opus-5");
    expect(calls).toHaveLength(2);
  });

  it("says which variable to set when no API key can be found", async () => {
    const { client } = fakeClient(() => ({ error: new Error("Could not resolve authentication method. Expected one of apiKey, authToken") }));
    await expect(runClaudeApi(request().req, client)).rejects.toMatchObject({ code: "not_logged_in", message: expect.stringContaining("CONSULTANT_DOTS_API_KEY") });
  });

  it("bills every attempt when a server-side fallback served the turn", async () => {
    const json = '{"note":"ok"}';
    const final = {
      ...finalOk(json, "claude-opus-4-8"),
      usage: {
        input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
        iterations: [
          { type: "message", model: "claude-opus-5-5", input_tokens: 105, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        ],
      },
    } as unknown as Final;
    const { client } = fakeClient(() => ({ events: textEvents(json), final }));
    const result = await runClaudeApi(request().req, client);
    expect(result.usage).toEqual({ input: 205, output: 15, cacheRead: 0, cacheWrite: 0 });
    expect(result.costUsd).toBeCloseTo(105 * 4e-6 + 5 * 20e-6 + 100 * 5e-6 + 10 * 25e-6, 9);
  });

  it("restarts the client buffer only once per attempt, even if the answer spans several text blocks", async () => {
    const json = '{"note":"ok"}';
    const events = [...textEvents(json), { type: "content_block_start", index: 2, content_block: { type: "text" } }];
    const { client } = fakeClient(() => ({ events, final: finalOk(json) }));
    const { req, events: emitted } = request();
    await runClaudeApi(req, client);
    expect(emitted.filter((e) => e.type === "status" && e.phase === "writing")).toHaveLength(1);
  });

  it("maps auth and rate-limit errors to the existing error codes", async () => {
    for (const [status, code] of [
      [401, "not_logged_in"],
      [429, "usage_limit"],
      [400, "engine_error"],
    ] as const) {
      const { client } = fakeClient(() => ({ error: apiError(status) }));
      await expect(runClaudeApi(request().req, client)).rejects.toMatchObject({ code });
    }
  });

  it("stops on abort and on its own timeout", async () => {
    const aborting = new AbortController();
    const { client } = fakeClient(() => ({ hang: true }));
    const pending = runClaudeApi(request({ signal: aborting.signal }).req, client);
    aborting.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });

    const slow = fakeClient(() => ({ hang: true }));
    await expect(runClaudeApi(request({ timeoutMs: 30 }).req, slow.client)).rejects.toMatchObject({ code: "timeout" });
  });

  it("prices known models and declines to guess the others", () => {
    expect(costOf("claude-opus-5-5", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 1_000_000 })).toBeCloseTo(4 + 5, 6);
    expect(costOf("some-future-model", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it("checks the key and the model with a free model lookup", async () => {
    const ok = fakeClient(() => ({}));
    expect(await apiHealth(ok.client)).toEqual({ ok: true, model: "claude-opus-5-5", error: null });
    ok.models.retrieve.mockRejectedValueOnce(apiError(401));
    const failed = await apiHealth(ok.client);
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/Clé API refusée/);
    expect(new EngineError("aborted", "x").code).toBe("aborted");
  });
});
