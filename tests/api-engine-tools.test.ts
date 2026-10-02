import { afterEach, describe, expect, it, vi } from "vitest";
import { costOf, runClaudeApi } from "@/lib/engine/claude-api";
import { TOOL_LIMIT_TEXT, type EngineRequest, type EngineTool, type EngineToolResult, type EngineToolSet } from "@/lib/engine/types";
import type { InterviewTurnInput } from "@/lib/interview/schema";
import { createInterviewTools } from "@/lib/interview/tools";
import type { StageEvent } from "@/lib/schemas/api";

type Event = Record<string, unknown>;
type Block = Record<string, unknown>;
type Final = { stop_reason: string | null; model: string; content: Block[]; usage: Record<string, unknown> };
/**
 * One request of the loop: the stream replays `events`, then throws `error`, hangs, or resolves `final`.
 * `snapshot` is the message the stream had accumulated when it failed (the SDK's currentMessage).
 */
type Step = { events?: Event[]; final?: Final; error?: unknown; finalError?: unknown; hang?: boolean; snapshot?: Final };
/** A request as it goes on the wire. */
type Params = {
  model: string;
  tools?: Block[];
  tool_choice?: { type: string };
  messages: { role: string; content: Block[] }[];
  [key: string]: unknown;
};

const TOOLS: EngineTool[] = [
  {
    name: "get_client_answer",
    description: "Look up an answer.",
    inputSchema: { type: "object", properties: { question_id: { type: "string" } }, required: ["question_id"], additionalProperties: false },
  },
  {
    name: "check_quote",
    description: "Check a quote.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  },
];

/** One interviewer turn, for the tests that need the real tool session and its reveal. */
const TURN: InterviewTurnInput = {
  caseText: "Un groupe industriel veut consolider ses chiffres en moins de dix jours.",
  factSheet: {
    facts: [{ id: "F1", text: "Trois filiales, trois ERP." }],
    clientAnswers: [
      { id: "Q1", question: "Quel budget ?", answer: "2 M€." },
      { id: "Q2", question: "Quel délai ?", answer: "Un an." },
    ],
  },
  transcript: [
    { role: "interviewer", text: "Bonjour, je vous écoute." },
    { role: "candidate", text: "Quel budget et quel délai avez-vous ?" },
  ],
  round: 1,
  maxRounds: 8,
  revealed: [],
};

const usageOf = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});

const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });

/** A message that thinks, optionally says something, then calls tools. */
function toolRound(calls: Block[], options: { text?: string; model?: string; usage?: Record<string, unknown>; stop?: string } = {}): Step {
  const thinking = { type: "thinking", thinking: "Je dois vérifier mes notes.", signature: "sig-1" };
  const text = options.text ? [{ type: "text", text: options.text, citations: null }] : [];
  const events: Event[] = [
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    ...(options.text
      ? [
          { type: "content_block_start", index: 1, content_block: { type: "text" } },
          { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: options.text } },
        ]
      : []),
    ...calls.map((call, i) => ({ type: "content_block_start", index: 2 + i, content_block: { ...call, input: {} } })),
  ];
  return {
    events,
    final: {
      stop_reason: options.stop ?? "tool_use",
      model: options.model ?? "claude-opus-5-5",
      content: [thinking, ...text, ...calls],
      usage: options.usage ?? usageOf(1000, 100),
    },
  };
}

/** The final message: the JSON, streamed in two deltas. */
function answer(json: string, options: { model?: string; usage?: Record<string, unknown> } = {}): Step {
  return {
    events: [
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_start", index: 1, content_block: { type: "text" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: json.slice(0, 4) } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: json.slice(4) } },
    ],
    final: {
      stop_reason: "end_turn",
      model: options.model ?? "claude-opus-5-5",
      content: [{ type: "thinking", thinking: "", signature: "sig-2" }, { type: "text", text: json }],
      usage: options.usage ?? usageOf(500, 50),
    },
  };
}

const JSON_ANSWER = '{"note":"ok"}';

/** What the SDK raises when an eagerly streamed tool input does not parse. */
const unparsable = () => new Error('Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: SyntaxError. JSON: {"question_id": Q');

const apiError = (status: number) => Object.assign(new Error(`status ${status}`), { status });

/** A fake client whose successive stream calls play the next scripted step; each request is recorded as serialised. */
function scriptedClient(script: Step[] | ((index: number, model: string) => Step)) {
  const calls: { params: Params; abort: ReturnType<typeof vi.fn> }[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>, options: { signal?: AbortSignal }) {
          const index = calls.length;
          const step = typeof script === "function" ? script(index, String(params.model)) : script[index];
          if (!step) throw new Error(`unexpected request #${index + 1}`);
          const abort = vi.fn();
          calls.push({ params: JSON.parse(JSON.stringify(params)) as Params, abort });
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
            finalMessage: async () => {
              if (step.finalError) throw step.finalError;
              return step.final!;
            },
            currentMessage: step.snapshot,
            abort,
          };
        },
      },
    },
    models: { retrieve: vi.fn(async () => ({ id: "claude-opus-5-5" })) },
  };
  return { client: client as never, calls };
}

function toolSet(options: { maxIterations?: number; results?: Record<string, EngineToolResult>; call?: EngineToolSet["call"] } = {}) {
  const call = vi.fn<EngineToolSet["call"]>(
    options.call ?? (async (name) => options.results?.[name] ?? { text: `${name}: done`, isError: false }),
  );
  const set: EngineToolSet = { serverName: "interview", tools: TOOLS, call, maxIterations: options.maxIterations ?? 4 };
  return { set, call };
}

function request(tools: EngineToolSet | undefined, overrides: Partial<EngineRequest> = {}) {
  const events: StageEvent[] = [];
  const req: EngineRequest = {
    systemPrompt: "SYSTEM",
    userMessage: "<case>\nUn groupe industriel.\n</case>\n\n<interview>\nRound 2.\n</interview>",
    jsonSchema: { type: "object", properties: { note: { type: ["string", "null"] } }, required: ["note"], additionalProperties: false },
    effort: "medium",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    tools,
    ...overrides,
  };
  return { req, events };
}

afterEach(() => {
  delete process.env.CONSULTANT_DOTS_MODEL;
  delete process.env.CONSULTANT_DOTS_FALLBACK_MODEL;
});

describe("API engine tool loop", () => {
  it("lists the tools strict and eagerly streamed, in their order, and lets the model call them until the rounds are spent", async () => {
    const { set } = toolSet({ maxIterations: 2 });
    const { client, calls } = scriptedClient([
      toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]),
      toolRound([toolUse("tu_2", "check_quote", { text: "dix jours" })]),
      answer(JSON_ANSWER),
    ]);
    const result = await runClaudeApi(request(set).req, client);

    expect(result.output).toEqual({ note: "ok" });
    expect(result.toolIterations).toBe(2);
    expect(calls.map((c) => c.params.tool_choice)).toEqual([{ type: "auto" }, { type: "auto" }, { type: "none" }]);
    const expectedTools = TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      strict: true,
      eager_input_streaming: true,
    }));
    for (const { params } of calls) {
      expect(params.tools).toEqual(expectedTools);
      // The rest of the request is laid out as for a single call: same model, betas, format and cache breakpoints.
      expect(params.model).toBe("claude-opus-5-5");
      expect(params.betas).toEqual(["server-side-fallback-2026-07-01"]);
      expect(params.fallbacks).toBe("default");
      expect(params.output_config).toMatchObject({ effort: "medium", format: { type: "json_schema" } });
      expect(JSON.stringify(params.output_config)).toContain('"anyOf"');
      expect(params.system).toEqual([{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }]);
      const [prefix, rest] = params.messages[0].content;
      expect(String(prefix.text).startsWith("<case>")).toBe(true);
      expect(prefix.cache_control).toEqual({ type: "ephemeral" });
      expect(rest.cache_control).toBeUndefined();
    }
  });

  it("passes the interviewer's own tool definitions through unchanged", async () => {
    const { INTERVIEW_TOOLS } = await import("@/lib/interview/tools");
    const set: EngineToolSet = { serverName: "interview", tools: INTERVIEW_TOOLS, call: vi.fn(), maxIterations: 4 };
    const { client, calls } = scriptedClient([answer(JSON_ANSWER)]);
    const result = await runClaudeApi(request(set).req, client);

    expect(result.toolIterations).toBe(0);
    expect(calls[0].params.tools?.map((t) => t.name)).toEqual(INTERVIEW_TOOLS.map((t) => t.name));
    expect(calls[0].params.tools?.map((t) => t.input_schema)).toEqual(INTERVIEW_TOOLS.map((t) => t.inputSchema));
  });

  it("sends each assistant message back unchanged and answers all its calls in one user message", async () => {
    const { set, call } = toolSet({
      results: {
        get_client_answer: { text: "Q2: le budget est de 2 M€.", isError: false },
        check_quote: { text: "Not found in the candidate's messages.", isError: true },
      },
    });
    const round = toolRound(
      [toolUse("tu_a", "get_client_answer", { question_id: "Q2" }), toolUse("tu_b", "check_quote", { text: "trois filiales" })],
      { text: "Je regarde." },
    );
    const { client, calls } = scriptedClient([round, answer(JSON_ANSWER)]);
    await runClaudeApi(request(set).req, client);

    expect(call.mock.calls).toEqual([
      ["get_client_answer", { question_id: "Q2" }, { callId: "tu_a" }],
      ["check_quote", { text: "trois filiales" }, { callId: "tu_b" }],
    ]);
    expect(calls[0].params.messages).toHaveLength(1);
    const [first, assistant, results] = calls[1].params.messages;
    expect(first).toEqual(calls[0].params.messages[0]);
    // Thinking block, signature and text included, exactly as received.
    expect(assistant).toEqual({ role: "assistant", content: round.final!.content });
    expect(results).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_a", content: "Q2: le budget est de 2 M€.", is_error: false },
        { type: "tool_result", tool_use_id: "tu_b", content: "Not found in the candidate's messages.", is_error: true },
      ],
    });
    expect(calls[1].params.messages).toHaveLength(3);
  });

  it("keeps the history append-only across several rounds", async () => {
    const { set } = toolSet();
    const first = toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]);
    const second = toolRound([toolUse("tu_2", "get_client_answer", { question_id: "Q3" })]);
    const { client, calls } = scriptedClient([first, second, answer(JSON_ANSWER)]);
    await runClaudeApi(request(set).req, client);

    const roles = calls.map((c) => c.params.messages.map((m) => m.role));
    expect(roles).toEqual([["user"], ["user", "assistant", "user"], ["user", "assistant", "user", "assistant", "user"]]);
    expect(calls[2].params.messages.slice(0, 3)).toEqual(calls[1].params.messages);
    expect(calls[2].params.messages[3]).toEqual({ role: "assistant", content: second.final!.content });
  });

  it("returns the final JSON with the usage and cost of every request, and the final message's model", async () => {
    const { set } = toolSet();
    const { client } = scriptedClient([
      toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })], { usage: usageOf(1000, 100, 2000, 500) }),
      answer(JSON_ANSWER, { model: "claude-opus-5", usage: usageOf(300, 60, 2500, 0) }),
    ]);
    const result = await runClaudeApi(request(set).req, client);

    expect(result.output).toEqual({ note: "ok" });
    expect(result.model).toBe("claude-opus-5");
    expect(result.rateLimit).toBeNull();
    expect(result.usage).toEqual({ input: 1300, output: 160, cacheRead: 4500, cacheWrite: 500 });
    const expected =
      costOf("claude-opus-5-5", { input: 1000, output: 100, cacheRead: 2000, cacheWrite: 500 })! +
      costOf("claude-opus-5", { input: 300, output: 60, cacheRead: 2500, cacheWrite: 0 })!;
    expect(result.costUsd).toBeCloseTo(expected, 9);
  });

  it("bills a server-side fallback inside the loop, and reports no cost when one part has no known price", async () => {
    const { set } = toolSet();
    const fallbackUsage = {
      ...usageOf(100, 10),
      iterations: [
        { type: "message", model: "claude-opus-5-5", ...usageOf(105, 5) },
        { type: "fallback_message", model: "claude-opus-4-8", ...usageOf(100, 10) },
      ],
    };
    const billed = scriptedClient([
      toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })], { model: "claude-opus-4-8", usage: fallbackUsage }),
      answer(JSON_ANSWER, { usage: usageOf(200, 20) }),
    ]);
    const result = await runClaudeApi(request(set).req, billed.client);
    expect(result.usage).toEqual({ input: 405, output: 35, cacheRead: 0, cacheWrite: 0 });
    expect(result.costUsd).toBeCloseTo(105 * 4e-6 + 5 * 20e-6 + 100 * 5e-6 + 10 * 25e-6 + 200 * 4e-6 + 20 * 20e-6, 9);

    const unknown = scriptedClient([
      toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })], { model: "some-future-model" }),
      answer(JSON_ANSWER),
    ]);
    const partial = await runClaudeApi(request(toolSet().set).req, unknown.client);
    expect(partial.costUsd).toBeNull();
    expect(partial.usage).toEqual({ input: 1500, output: 150, cacheRead: 0, cacheWrite: 0 });
  });

  it("streams only the final message's text to the client, after the tool rounds", async () => {
    const { set } = toolSet();
    const { client } = scriptedClient([
      toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })], { text: "Je regarde mes notes." }),
      answer(JSON_ANSWER),
    ]);
    const { req, events } = request(set);
    await runClaudeApi(req, client);

    expect(events).toEqual([
      { type: "status", phase: "thinking" },
      { type: "status", phase: "thinking" },
      { type: "status", phase: "writing" },
      { type: "delta", text: JSON_ANSWER.slice(0, 4) },
      { type: "delta", text: JSON_ANSWER.slice(4) },
    ]);
  });

  it("ends the run on a refusal or a truncation, without running the tools of that message", async () => {
    for (const [stop, code] of [
      ["refusal", "engine_error"],
      ["max_tokens", "invalid_output"],
    ] as const) {
      const { set, call } = toolSet();
      const { client, calls } = scriptedClient([toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })], { stop })]);
      await expect(runClaudeApi(request(set).req, client)).rejects.toMatchObject({ code });
      expect(call).not.toHaveBeenCalled();
      expect(calls).toHaveLength(1);
    }
  });

  it("fails on a final message that is not JSON, as without tools", async () => {
    const { set } = toolSet();
    const { client } = scriptedClient([toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]), answer("pas du JSON")]);
    await expect(runClaudeApi(request(set).req, client)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("re-issues the same request when a streamed tool input does not parse, at most twice", async () => {
    const { set, call } = toolSet();
    // What the stream had reported when the input failed to parse: the message_start usage.
    const snapshot: Final = { stop_reason: null, model: "claude-opus-5-5", content: [], usage: usageOf(1200, 2, 300, 0) };
    const { client, calls } = scriptedClient([
      toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]),
      { events: toolRound([toolUse("tu_2", "check_quote", { text: "x" })]).events, error: unparsable(), snapshot },
      { finalError: unparsable() },
      answer(JSON_ANSWER),
    ]);
    const { req, events } = request(set);
    const result = await runClaudeApi(req, client);

    expect(result.output).toEqual({ note: "ok" });
    expect(result.toolIterations).toBe(1);
    // The abandoned request is billed with what its stream reported; the one that failed before any chunk adds nothing.
    expect(result.usage).toEqual({ input: 2700, output: 152, cacheRead: 300, cacheWrite: 0 });
    expect(result.costUsd).toBeCloseTo(costOf("claude-opus-5-5", { input: 2700, output: 152, cacheRead: 300, cacheWrite: 0 })!, 9);
    expect(calls).toHaveLength(4);
    expect(calls[2].params).toEqual(calls[1].params);
    expect(calls[3].params).toEqual(calls[1].params);
    expect(calls[1].abort).toHaveBeenCalled();
    expect(calls[2].abort).toHaveBeenCalled();
    expect(calls[3].abort).not.toHaveBeenCalled();
    // The failed requests' calls never ran, and their text never reached the client.
    expect(call).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe(JSON_ANSWER);

    const failing = scriptedClient(() => ({ error: unparsable() }));
    await expect(runClaudeApi(request(toolSet().set).req, failing.client)).rejects.toMatchObject({ code: "invalid_output" });
    expect(failing.calls).toHaveLength(3);
  });

  it("does not take the API's own errors for unparsable tool input", async () => {
    for (const [error, code] of [
      [apiError(429), "usage_limit"],
      [Object.assign(new Error('{"type":"error","error":{"type":"rate_limit_error"}}'), { type: "rate_limit_error" }), "usage_limit"],
      [apiError(400), "engine_error"],
      [Object.assign(new Error("Unable to parse tool parameter JSON"), { status: 500 }), "engine_error"],
    ] as const) {
      const { set } = toolSet();
      const { client, calls } = scriptedClient([toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]), { error }]);
      await expect(runClaudeApi(request(set).req, client)).rejects.toMatchObject({ code });
      expect(calls).toHaveLength(2);
    }
  });

  it("returns the overload instead of rerunning on the fallback model once a tool ran", async () => {
    process.env.CONSULTANT_DOTS_FALLBACK_MODEL = "claude-opus-5";
    const session = createInterviewTools(TURN);
    // A rerun would reveal Q2 on top of Q1, with the same session.
    const { client, calls } = scriptedClient((index, model) => {
      if (model === "claude-opus-5-5") {
        return index === 0 ? toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]) : { error: apiError(529) };
      }
      return index === 2
        ? toolRound([toolUse("tu_9", "get_client_answer", { question_id: "Q2" })], { model })
        : answer(JSON_ANSWER, { model });
    });
    await expect(runClaudeApi(request(session).req, client)).rejects.toMatchObject({ code: "overloaded" });

    expect(calls.map((c) => c.params.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5"]);
    // The turn fails as a whole: the client's Retry starts it again with a fresh session.
    expect(session.revealed()).toEqual(["Q1"]);
    expect(session.trace()).toHaveLength(1);
  });

  it("reruns on the fallback model while no tool ran, and bills the abandoned attempt too", async () => {
    process.env.CONSULTANT_DOTS_FALLBACK_MODEL = "claude-opus-5";
    const session = createInterviewTools(TURN);
    const snapshot: Final = { stop_reason: null, model: "claude-opus-5-5", content: [], usage: usageOf(1200, 2) };
    const { client, calls } = scriptedClient((index, model) => {
      if (model === "claude-opus-5-5") {
        // An unparsable tool input (never run), then an overload on its re-issue.
        return index === 0 ? { error: unparsable(), snapshot } : { error: apiError(529) };
      }
      return index === 2
        ? toolRound([toolUse("tu_9", "get_client_answer", { question_id: "Q1" })], { model })
        : answer(JSON_ANSWER, { model });
    });
    const result = await runClaudeApi(request(session).req, client);

    expect(calls.map((c) => c.params.model)).toEqual(["claude-opus-5-5", "claude-opus-5-5", "claude-opus-5", "claude-opus-5"]);
    expect(calls[2].params.messages).toHaveLength(1);
    expect(result.output).toEqual({ note: "ok" });
    expect(result.model).toBe("claude-opus-5");
    expect(result.toolIterations).toBe(1);
    expect(session.revealed()).toEqual(["Q1"]);
    // Both attempts are billed: the abandoned request's reported usage, then the rerun's two requests.
    expect(result.usage).toEqual({ input: 2700, output: 152, cacheRead: 0, cacheWrite: 0 });
    const expected =
      costOf("claude-opus-5-5", { input: 1200, output: 2, cacheRead: 0, cacheWrite: 0 })! +
      costOf("claude-opus-5", { input: 1500, output: 150, cacheRead: 0, cacheWrite: 0 })!;
    expect(result.costUsd).toBeCloseTo(expected, 9);
  });

  it("runs only the answering model's calls after a server-side fallback, and echoes the declined part as the API asks", async () => {
    const { set, call } = toolSet();
    const pairedUse = { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "ERP" } };
    const pairedResult = { type: "web_search_tool_result", tool_use_id: "srv_1", content: [] };
    const partialText = { type: "text", text: "Je regarde", citations: null };
    const firstSwitch = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } };
    const secondSwitch = { type: "fallback", from: { model: "claude-opus-4-8" }, to: { model: "claude-opus-5" } };
    const answering = [{ type: "thinking", thinking: "", signature: "sig-kept" }, toolUse("tu_kept", "get_client_answer", { question_id: "Q2" })];
    const content: Block[] = [
      { type: "thinking", thinking: "", signature: "sig-declined" },
      pairedUse,
      pairedResult,
      partialText,
      toolUse("tu_declined", "get_client_answer", { question_id: "Q1" }),
      firstSwitch,
      { type: "redacted_thinking", data: "opaque" },
      { type: "server_tool_use", id: "srv_2", name: "web_search", input: { query: "OTD" } },
      toolUse("tu_declined_2", "check_quote", { text: "dix jours" }),
      secondSwitch,
      ...answering,
    ];
    const round: Step = { events: [], final: { stop_reason: "tool_use", model: "claude-opus-5", content, usage: usageOf(1000, 100) } };
    const { client, calls } = scriptedClient([round, answer(JSON_ANSWER)]);
    const result = await runClaudeApi(request(set).req, client);

    expect(result.output).toEqual({ note: "ok" });
    expect(call.mock.calls).toEqual([["get_client_answer", { question_id: "Q2" }, { callId: "tu_kept" }]]);
    const [, assistant, results] = calls[1].params.messages;
    // Before the last switch: text, paired server-tool blocks and the switches; no thinking, no call left unanswered.
    expect(assistant).toEqual({
      role: "assistant",
      content: [pairedUse, pairedResult, partialText, firstSwitch, secondSwitch, ...answering],
    });
    expect(results.content).toEqual([{ type: "tool_result", tool_use_id: "tu_kept", content: "get_client_answer: done", is_error: false }]);
  });

  it("stops between rounds and mid-stream on abort, and on its own timeout", async () => {
    const between = new AbortController();
    const { set: abortingSet } = toolSet({
      call: async (name) => {
        between.abort();
        return { text: `${name}: done`, isError: false };
      },
    });
    const first = scriptedClient([toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]), answer(JSON_ANSWER)]);
    await expect(runClaudeApi(request(abortingSet, { signal: between.signal }).req, first.client)).rejects.toMatchObject({ code: "aborted" });
    expect(first.calls).toHaveLength(1);

    const midStream = new AbortController();
    const second = scriptedClient([toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]), { hang: true }]);
    const pending = runClaudeApi(request(toolSet().set, { signal: midStream.signal }).req, second.client);
    await vi.waitFor(() => expect(second.calls).toHaveLength(2));
    midStream.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });

    const slow = scriptedClient([toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]), { hang: true }]);
    await expect(runClaudeApi(request(toolSet().set, { timeoutMs: 30 }).req, slow.client)).rejects.toMatchObject({ code: "timeout" });
    expect(slow.calls).toHaveLength(2);
  });

  it("asks for the answer at once when no tool round is allowed", async () => {
    const { set } = toolSet({ maxIterations: 0 });
    const { client, calls } = scriptedClient([answer(JSON_ANSWER)]);
    const result = await runClaudeApi(request(set).req, client);
    expect(calls[0].params.tool_choice).toEqual({ type: "none" });
    expect(calls[0].params.tools).toHaveLength(TOOLS.length);
    expect(result.toolIterations).toBe(0);
  });

  it("answers calls made past the limit without running them, once, then gives up", async () => {
    const { set, call } = toolSet({ maxIterations: 1 });
    const { client, calls } = scriptedClient([
      toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]),
      toolRound([toolUse("tu_2", "get_client_answer", { question_id: "Q2" }), toolUse("tu_3", "check_quote", { text: "x" })]),
      answer(JSON_ANSWER),
    ]);
    const result = await runClaudeApi(request(set).req, client);

    expect(result.output).toEqual({ note: "ok" });
    // The refused round counts, as on the CLI engine: two messages called tools.
    expect(result.toolIterations).toBe(2);
    expect(call).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.params.tool_choice)).toEqual([{ type: "auto" }, { type: "none" }, { type: "none" }]);
    expect(calls[2].params.messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_2", content: TOOL_LIMIT_TEXT, is_error: true },
        { type: "tool_result", tool_use_id: "tu_3", content: TOOL_LIMIT_TEXT, is_error: true },
      ],
    });

    const stubborn = scriptedClient(() => toolRound([toolUse("tu_x", "get_client_answer", { question_id: "Q1" })]));
    await expect(runClaudeApi(request(toolSet({ maxIterations: 1 }).set).req, stubborn.client)).rejects.toMatchObject({ code: "invalid_output" });
    expect(stubborn.calls).toHaveLength(3);
  });

  it("turns a tool that throws into an error result instead of failing the reply", async () => {
    const { set } = toolSet({
      call: async () => {
        throw new Error("boom");
      },
    });
    const { client, calls } = scriptedClient([toolRound([toolUse("tu_1", "get_client_answer", { question_id: "Q1" })]), answer(JSON_ANSWER)]);
    const result = await runClaudeApi(request(set).req, client);
    expect(result.output).toEqual({ note: "ok" });
    expect(calls[1].params.messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: expect.stringContaining("boom"), is_error: true },
    ]);
  });

  it("takes a tool_use stop without any call for the final message", async () => {
    const { set, call } = toolSet();
    const final = { ...answer(JSON_ANSWER).final!, stop_reason: "tool_use" };
    const { client } = scriptedClient([{ ...answer(JSON_ANSWER), final }]);
    const result = await runClaudeApi(request(set).req, client);
    expect(result.output).toEqual({ note: "ok" });
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps a request without tools exactly as before: no tool keys, live deltas", async () => {
    const { client, calls } = scriptedClient([answer(JSON_ANSWER)]);
    const { req, events } = request(undefined);
    const result = await runClaudeApi(req, client);

    expect(result.toolIterations).toBeUndefined();
    expect(JSON.stringify(calls[0].params)).toBe(
      JSON.stringify({
        model: "claude-opus-5-5",
        max_tokens: 32_000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: {
          effort: "medium",
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { note: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["note"], additionalProperties: false },
          },
        },
        system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "<case>\nUn groupe industriel.\n</case>", cache_control: { type: "ephemeral" } },
              { type: "text", text: "<interview>\nRound 2.\n</interview>" },
            ],
          },
        ],
      }),
    );
    expect(events).toEqual([
      { type: "status", phase: "thinking" },
      { type: "status", phase: "writing" },
      { type: "delta", text: JSON_ANSWER.slice(0, 4) },
      { type: "delta", text: JSON_ANSWER.slice(4) },
    ]);
  });
});
