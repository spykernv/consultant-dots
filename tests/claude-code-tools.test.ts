import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_SENT_TEXT, buildArgs, childEnv, createIterationGuard, runClaudeCode } from "@/lib/engine/claude-code";
import { startMcpHost, type McpHost } from "@/lib/engine/mcp-host";
import { EngineError, TOOL_LIMIT_TEXT, type EngineRequest, type EngineToolSet } from "@/lib/engine/types";
import { INTERVIEW_TOOL_SERVER, INTERVIEW_TOOLS } from "@/lib/interview/tools";
import type { StageEvent } from "@/lib/schemas/api";

/** Every MCP host a run started, with a spy on its close(). */
const hosts = vi.hoisted(() => [] as { url: string; close: ReturnType<typeof vi.fn>; callCount: () => number }[]);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
  // killTree would run taskkill on Windows: the fake CLI has no pid, so it never should.
  execFile: vi.fn(),
}));

vi.mock("@/lib/engine/mcp-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/engine/mcp-host")>();
  return {
    ...actual,
    startMcpHost: vi.fn(async (toolset: EngineToolSet) => {
      const host = await actual.startMcpHost(toolset);
      const close = vi.fn(host.close);
      hosts.push({ url: host.url, close, callCount: host.callCount });
      return { ...host, close };
    }),
  };
});

const SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false };

function toolset(maxIterations = 4) {
  return {
    serverName: INTERVIEW_TOOL_SERVER,
    tools: INTERVIEW_TOOLS,
    maxIterations,
    call: vi.fn<EngineToolSet["call"]>(async (name, input) => ({ text: `${name} ${JSON.stringify(input)}`, isError: false })),
  } satisfies EngineToolSet;
}

function request(tools?: EngineToolSet, overrides: Partial<EngineRequest> = {}) {
  const events: StageEvent[] = [];
  const req: EngineRequest = {
    systemPrompt: "SYSTEM",
    userMessage: "<case>\nUn groupe industriel.\n</case>\n\n<interview>\nRound 1.\n</interview>",
    jsonSchema: SCHEMA,
    effort: "low",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    tools,
    ...overrides,
  };
  return { req, events };
}

const saved = { ...process.env };

function restoreEnv() {
  for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
}

beforeEach(() => {
  Object.assign(process.env, { CONSULTANT_DOTS_MODEL: "claude-opus-5-5", CONSULTANT_DOTS_FALLBACK_MODEL: "claude-opus-5" });
  delete process.env.CONSULTANT_DOTS_CLAUDE_AUTH;
});

afterEach(() => {
  restoreEnv();
  vi.useRealTimers();
});

describe("CLI arguments", () => {
  const files = { systemPromptFile: "/work/system-abc.md" };

  it("keeps a pipeline stage's arguments exactly as they were, --safe-mode included", () => {
    expect(buildArgs(request().req, files)).toEqual([
      "-p",
      "--model",
      "claude-opus-5-5",
      "--fallback-model",
      "claude-opus-5",
      "--effort",
      "low",
      "--system-prompt-file",
      "/work/system-abc.md",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--tools",
      "",
      "--safe-mode",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]);
  });

  it("leaves out the fallback model when it is the main one, and ignores an MCP config without tools", () => {
    process.env.CONSULTANT_DOTS_FALLBACK_MODEL = "claude-opus-5-5";
    const args = buildArgs(request().req, { ...files, mcpConfigFile: "/work/mcp.json" });
    expect(args).not.toContain("--fallback-model");
    expect(args).not.toContain("--mcp-config");
    expect(args).toContain("--safe-mode");
  });

  it("swaps --safe-mode for settings-free, MCP-only flags on a tool run", () => {
    const args = buildArgs(request(toolset()).req, { ...files, mcpConfigFile: "/work/mcp-1.json" });
    expect(args).toEqual([
      "-p",
      "--model",
      "claude-opus-5-5",
      "--fallback-model",
      "claude-opus-5",
      "--effort",
      "low",
      "--system-prompt-file",
      "/work/system-abc.md",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      "/work/mcp-1.json",
      "--allowedTools",
      "mcp__interview__get_client_answer,mcp__interview__lookup_fact,mcp__interview__check_quote,mcp__interview__record_observation",
      "--max-turns",
      "7",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]);
    expect(args).not.toContain("--safe-mode");
  });

  it("names the tools after the toolset's server and sets the backstop from its iterations", () => {
    const tools = { ...toolset(1), serverName: "other", tools: INTERVIEW_TOOLS.slice(0, 2) };
    const args = buildArgs(request(tools).req, { ...files, mcpConfigFile: "/work/mcp-2.json" });
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__other__get_client_answer,mcp__other__lookup_fact");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("4");
  });

  it("refuses to build a tool run without its MCP config file", () => {
    expect(() => buildArgs(request(toolset()).req, files)).toThrow(/--mcp-config/);
  });
});

describe("CLI environment", () => {
  const TOOL_FLAGS = ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"];

  it("disables CLAUDE.md and auto memory on a tool run only", () => {
    for (const name of TOOL_FLAGS) delete process.env[name];
    const tools = childEnv({ tools: true });
    expect(tools.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
    expect(tools.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(tools.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    for (const env of [childEnv(), childEnv({}), childEnv({ tools: false })]) {
      for (const name of TOOL_FLAGS) expect(env[name], name).toBeUndefined();
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    }
  });

  it("still drops provider credentials on a tool run in subscription mode, and keeps them in inherit mode", () => {
    Object.assign(process.env, { PROVIDER_API_KEY: "k", PROVIDER_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o" });
    const env = childEnv({ tools: true });
    expect(env.PROVIDER_API_KEY).toBeUndefined();
    expect(env.PROVIDER_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("o");

    process.env.CONSULTANT_DOTS_CLAUDE_AUTH = "inherit";
    expect(childEnv({ tools: true })).toMatchObject({ PROVIDER_API_KEY: "k", CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" });
  });
});

// Stream-json lines as the CLI writes them with --include-partial-messages.
const streamEvent = (event: Record<string, unknown>) => ({ type: "stream_event", event });
const messageStart = (id?: string) => streamEvent({ type: "message_start", message: { ...(id ? { id } : {}), model: "claude-opus-5-5" } });
const blockStart = (index: number, content_block: Record<string, unknown>) => streamEvent({ type: "content_block_start", index, content_block });
const toolUse = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
const serverTool = (id: string, tool = "lookup_fact", input: unknown = {}) => toolUse(id, `mcp__interview__${tool}`, input);

describe("iteration guard", () => {
  /** Feeds one whole assistant message per entry, each calling the given tool ids. */
  function feedRounds(guard: ReturnType<typeof createIterationGuard>, ...rounds: string[][]) {
    rounds.forEach((ids, i) => {
      guard.observe(messageStart(`msg_${i + 1}`));
      ids.forEach((id, index) => guard.observe(blockStart(index, serverTool(id))));
      guard.observe(streamEvent({ type: "message_stop" }));
    });
  }

  it("counts one round per assistant message that calls the server's tools, parallel calls included", () => {
    const guard = createIterationGuard("interview", 4);
    expect(guard.rounds()).toBe(0);
    feedRounds(guard, ["a", "b", "c"]);
    expect(guard.rounds()).toBe(1);

    // Thinking, text, the answer itself and other servers' tools are no round.
    guard.observe(messageStart("msg_x"));
    guard.observe(blockStart(0, { type: "thinking" }));
    guard.observe(blockStart(1, { type: "text" }));
    guard.observe(blockStart(2, toolUse("s", "StructuredOutput")));
    guard.observe(blockStart(3, toolUse("o", "mcp__other__lookup_fact")));
    guard.observe(blockStart(4, toolUse("p", "mcp__interviewer__lookup_fact")));
    guard.observe({ type: "result", subtype: "success" });
    expect(guard.rounds()).toBe(1);

    guard.observe(messageStart("msg_y"));
    guard.observe(blockStart(0, serverTool("d")));
    // The same block seen twice counts once.
    guard.observe(blockStart(0, serverTool("d")));
    guard.observe(blockStart(1, serverTool("e")));
    expect(guard.rounds()).toBe(2);
  });

  it("counts a tool block seen before any message_start", () => {
    const guard = createIterationGuard("interview", 4);
    guard.observe(blockStart(0, serverTool("a")));
    guard.observe(blockStart(1, serverTool("b")));
    expect(guard.rounds()).toBe(1);
  });

  it("refuses a call from round 5 with maxIterations 4, without running it", async () => {
    const tools = toolset(4);
    const guard = createIterationGuard("interview", 4);
    const guarded = guard.wrap(tools);
    feedRounds(guard, ["t1"], ["t2"], ["t3"], ["t4a", "t4b"], ["t5"]);
    expect(guard.rounds()).toBe(5);

    expect(guarded).toMatchObject({ serverName: "interview", tools: INTERVIEW_TOOLS, maxIterations: 4 });
    expect(await guarded.call("lookup_fact", { fact_id: "F1" }, { callId: "t4b" })).toEqual({
      text: 'lookup_fact {"fact_id":"F1"}',
      isError: false,
    });
    expect(await guarded.call("lookup_fact", { fact_id: "F2" }, { callId: "t5" })).toEqual({ text: TOOL_LIMIT_TEXT, isError: true });
    expect(tools.call).toHaveBeenCalledOnce();
    expect(tools.call).toHaveBeenCalledWith("lookup_fact", { fact_id: "F1" }, { callId: "t4b" });
  });

  it("waits for a call id the stream has not shown yet, and judges it by its round", async () => {
    vi.useFakeTimers();
    const tools = toolset(1);
    const guard = createIterationGuard("interview", 1);
    const guarded = guard.wrap(tools);

    const early = guarded.call("lookup_fact", { fact_id: "F1" }, { callId: "a" });
    await vi.advanceTimersByTimeAsync(300);
    expect(tools.call).not.toHaveBeenCalled();
    feedRounds(guard, ["a"]);
    expect(await early).toMatchObject({ isError: false });

    const late = guarded.call("lookup_fact", { fact_id: "F2" }, { callId: "b" });
    await vi.advanceTimersByTimeAsync(450);
    guard.observe(messageStart("msg_2"));
    guard.observe(blockStart(0, serverTool("b")));
    expect(await late).toEqual({ text: TOOL_LIMIT_TEXT, isError: true });
    expect(tools.call).toHaveBeenCalledOnce();
  });

  it("runs a call whose id is still unknown after 500 ms, or missing (fail open)", async () => {
    vi.useFakeTimers();
    const tools = toolset(1);
    const guard = createIterationGuard("interview", 1);
    const guarded = guard.wrap(tools);
    feedRounds(guard, ["a"], ["b"]);

    let settled = false;
    const unknown = guarded.call("check_quote", { text: "x" }, { callId: "ghost" }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await unknown).toMatchObject({ isError: false });

    // No id to wait for: the call runs at once, past the cap or not.
    expect(await guarded.call("check_quote", { text: "y" })).toMatchObject({ isError: false });
    expect(await guarded.call("check_quote", { text: "z" }, {})).toMatchObject({ isError: false });
    expect(tools.call).toHaveBeenCalledTimes(3);

    // A late registration after the timeout changes nothing for the call already answered.
    guard.observe(messageStart("msg_3"));
    guard.observe(blockStart(0, serverTool("ghost")));
    expect(tools.call).toHaveBeenCalledTimes(3);
  });

  it("falls back on the full assistant messages, counting each message once", async () => {
    const tools = toolset(1);
    const guard = createIterationGuard("interview", 1);
    const guarded = guard.wrap(tools);
    const assistant = (id: string | undefined, content: unknown[]) => ({ type: "assistant", message: { id, role: "assistant", content } });

    // No partial events for this message; the CLI writes one assistant event per block.
    guard.observe(assistant("msg_1", [{ type: "thinking", thinking: "" }, serverTool("a")]));
    guard.observe(assistant("msg_1", [serverTool("b")]));
    expect(guard.rounds()).toBe(1);

    // Partial events registered c; the full message adds d, which the stream missed, to the same round.
    guard.observe(messageStart("msg_2"));
    guard.observe(blockStart(0, serverTool("c")));
    guard.observe(assistant("msg_2", [serverTool("c"), serverTool("d")]));
    guard.observe(assistant("msg_2", [toolUse("s", "StructuredOutput"), { type: "text", text: "…" }]));
    expect(guard.rounds()).toBe(2);

    expect(await guarded.call("lookup_fact", {}, { callId: "b" })).toMatchObject({ isError: false });
    expect(await guarded.call("lookup_fact", {}, { callId: "d" })).toEqual({ text: TOOL_LIMIT_TEXT, isError: true });

    // Malformed lines are ignored.
    guard.observe({ type: "assistant" });
    guard.observe({ type: "assistant", message: { content: "nope" } });
    guard.observe({ type: "stream_event" });
    guard.observe(blockStart(0, { type: "tool_use", name: "mcp__interview__lookup_fact" }));
    expect(guard.rounds()).toBe(2);
  });

  const ANSWER_SENT = { text: ANSWER_SENT_TEXT, isError: true };

  it("refuses a call made in the same message as the answer when the answer's block comes first, at once", async () => {
    const tools = toolset(4);
    const guard = createIterationGuard("interview", 4);
    const guarded = guard.wrap(tools);
    guard.observe(messageStart("msg_1"));
    guard.observe(blockStart(0, toolUse("out", "StructuredOutput")));
    guard.observe(blockStart(1, serverTool("a", "get_client_answer")));

    // The message has not even ended: the answer in it already settles the call.
    expect(await guarded.call("get_client_answer", { question_id: "Q1" }, { callId: "a" })).toEqual(ANSWER_SENT);
    expect(tools.call).not.toHaveBeenCalled();
    // Still a round of the server's tools, as any refused one.
    expect(guard.rounds()).toBe(1);
  });

  it("holds a call until its message ends, then refuses it if the answer's block came after the call's", async () => {
    vi.useFakeTimers();
    const tools = toolset(4);
    const guard = createIterationGuard("interview", 4);
    const guarded = guard.wrap(tools);
    guard.observe(messageStart("msg_1"));
    guard.observe(blockStart(0, serverTool("a", "get_client_answer")));
    guard.observe(streamEvent({ type: "content_block_stop", index: 0 }));

    // The call reaches the server while the rest of the message is still in the pipe.
    const pending = guarded.call("get_client_answer", { question_id: "Q1" }, { callId: "a" });
    await vi.advanceTimersByTimeAsync(200);
    expect(tools.call).not.toHaveBeenCalled();
    guard.observe(blockStart(1, toolUse("out", "StructuredOutput")));
    guard.observe(streamEvent({ type: "message_stop" }));
    expect(await pending).toEqual(ANSWER_SENT);
    expect(tools.call).not.toHaveBeenCalled();
  });

  it.each([
    ["message_delta", streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } })],
    ["message_stop", streamEvent({ type: "message_stop" })],
    ["the next message_start", messageStart("msg_2")],
    ["a full message with its stop_reason", { type: "assistant", message: { id: "msg_1", stop_reason: "tool_use", content: [serverTool("b")] } }],
    ["the result", { type: "result", subtype: "success" }],
  ])("runs a call once its message ends without the answer: %s", async (_, end) => {
    vi.useFakeTimers();
    const tools = toolset(4);
    const guard = createIterationGuard("interview", 4);
    const guarded = guard.wrap(tools);
    guard.observe(messageStart("msg_1"));
    guard.observe(blockStart(0, serverTool("a", "get_client_answer")));

    const pending = guarded.call("get_client_answer", { question_id: "Q1" }, { callId: "a" });
    await vi.advanceTimersByTimeAsync(100);
    guard.observe(blockStart(1, serverTool("b")));
    expect(tools.call).not.toHaveBeenCalled();
    guard.observe(end);
    expect(await pending).toEqual({ text: 'get_client_answer {"question_id":"Q1"}', isError: false });
    expect(tools.call).toHaveBeenCalledOnce();
  });

  it("gives the name and the end of the message 500 ms in all, then runs the call unless the answer showed up", async () => {
    vi.useFakeTimers();
    const tools = toolset(4);
    const guard = createIterationGuard("interview", 4);
    const guarded = guard.wrap(tools);

    let settled = false;
    const pending = guarded.call("lookup_fact", { fact_id: "F1" }, { callId: "a" }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(300);
    guard.observe(messageStart("msg_1"));
    guard.observe(blockStart(0, serverTool("a")));
    // Named at 300 ms: the end of the message gets the 200 ms left, not a fresh wait.
    await vi.advanceTimersByTimeAsync(199);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ isError: false });

    // Same budget, but the answer came before it ran out: refused, even though the message never ended.
    const late = guarded.call("lookup_fact", { fact_id: "F2" }, { callId: "b" });
    guard.observe(messageStart("msg_2"));
    guard.observe(blockStart(0, serverTool("b")));
    await vi.advanceTimersByTimeAsync(400);
    guard.observe(blockStart(1, toolUse("out", "StructuredOutput")));
    expect(await late).toEqual(ANSWER_SENT);
    expect(tools.call).toHaveBeenCalledOnce();
  });

  it("finds the answer in the full assistant messages too, and holds only the calls of that message", async () => {
    const tools = toolset(4);
    const guard = createIterationGuard("interview", 4);
    const guarded = guard.wrap(tools);
    const assistant = (id: string, content: unknown[]) => ({ type: "assistant", message: { id, role: "assistant", content } });

    feedRounds(guard, ["a"]);
    // No partial events for the next message; the CLI writes one assistant event per block.
    guard.observe(assistant("msg_2", [serverTool("b", "get_client_answer")]));
    guard.observe(assistant("msg_2", [toolUse("out", "StructuredOutput")]));
    expect(await guarded.call("get_client_answer", {}, { callId: "b" })).toEqual(ANSWER_SENT);
    // A call of an earlier message runs: the answer is not in it.
    expect(await guarded.call("lookup_fact", {}, { callId: "a" })).toMatchObject({ isError: false });
    expect(tools.call).toHaveBeenCalledOnce();
    expect(guard.rounds()).toBe(2);
  });
});

/** A spawned `claude -p` played by the test: stdio streams, exit and kill, no real process (no pid). */
class FakeCli extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }

  line(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    // As a real child: "close" comes once stdout is drained.
    this.stdout.once("end", () => setImmediate(() => this.emit("close", code, signal)));
    this.stdout.end();
    this.stderr.end();
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    this.exit(null, signal);
    return true;
  }

  arg(flag: string) {
    const index = this.args.indexOf(flag);
    return index < 0 ? undefined : this.args[index + 1];
  }
}

type ToolCallResult = { content: { type: string; text: string }[]; isError: boolean };

/** Connects to the run's MCP server the way the CLI does, from the --mcp-config file it was given. */
async function connect(cli: FakeCli) {
  const file = cli.arg("--mcp-config") as string;
  const config = JSON.parse(readFileSync(file, "utf8")) as McpHost["config"];
  const server = config.mcpServers.interview;
  const headers = { ...server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  let nextId = 0;
  const post = (body: unknown, extra: Record<string, string> = {}) =>
    fetch(server.url, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const rpc = async (method: string, params: unknown) =>
    (await (await post({ jsonrpc: "2.0", id: nextId++, method, params })).json()) as {
      result?: Record<string, unknown>;
      error?: { code: number };
    };

  expect((await rpc("server/discover", {})).error?.code).toBe(-32601);
  const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fake-cli", version: "0" } });
  expect(init.result?.protocolVersion).toBe("2025-11-25");
  const version = { "MCP-Protocol-Version": "2025-11-25" };
  expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, version)).status).toBe(202);
  expect((await fetch(server.url, { headers: { ...server.headers, ...version, Accept: "text/event-stream" } })).status).toBe(405);
  const listed = (await rpc("tools/list", {})).result?.tools as { name: string }[];

  return {
    file,
    url: server.url,
    toolNames: listed.map((tool) => tool.name),
    async call(name: string, args: unknown, toolUseId: string) {
      const body = await rpc("tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } });
      return body.result as ToolCallResult;
    },
  };
}

/** One assistant message as the CLI streams it, then the full message, before it runs any tool. */
function writeMessage(cli: FakeCli, id: string, blocks: Record<string, unknown>[]) {
  cli.line(messageStart(id));
  blocks.forEach((block, index) => {
    cli.line(blockStart(index, block.type === "tool_use" ? { ...block, input: {} } : { type: block.type }));
    if (block.type === "tool_use") {
      cli.line(streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }));
    }
    cli.line(streamEvent({ type: "content_block_stop", index }));
  });
  cli.line(streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }));
  cli.line(streamEvent({ type: "message_stop" }));
  cli.line({ type: "assistant", message: { id, model: "claude-opus-5-5", role: "assistant", content: blocks } });
}

/** The final message: StructuredOutput streamed in pieces, then the result line. */
function writeAnswer(cli: FakeCli, id: string, output: unknown, pieces = 2) {
  const json = JSON.stringify(output);
  const size = Math.ceil(json.length / pieces);
  cli.line(messageStart(id));
  cli.line(blockStart(0, toolUse(`${id}_out`, "StructuredOutput")));
  for (let i = 0; i < json.length; i += size) {
    cli.line(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + size) } }));
  }
  cli.line(streamEvent({ type: "content_block_stop", index: 0 }));
  cli.line({
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: output,
    total_cost_usd: 0.021,
    modelUsage: { "claude-opus-5-5": {} },
  });
}

describe("CLI tool run", () => {
  let script: (cli: FakeCli) => Promise<void>;
  let clis: FakeCli[];
  let scriptErrors: unknown[];

  beforeEach(() => {
    process.env.CONSULTANT_DOTS_CLAUDE_BIN = process.execPath;
    clis = [];
    scriptErrors = [];
    hosts.length = 0;
    vi.mocked(startMcpHost).mockClear();
    vi.mocked(execFile).mockReset();
    vi.mocked(spawn)
      .mockReset()
      .mockImplementation(((_bin: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
        const cli = new FakeCli(args, options.env);
        clis.push(cli);
        // The CLI starts once spawn has returned, as a real process would.
        setImmediate(() =>
          script(cli).catch((err) => {
            scriptErrors.push(err);
            cli.exit(1);
          }),
        );
        return cli;
      }) as unknown as typeof spawn);
  });

  afterEach(() => {
    expect(scriptErrors).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  /** The run left nothing behind: its private config directory deleted, its server closed and no longer listening. */
  async function expectCleanedUp(file: string) {
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.dirname(file))).toBe(false);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].close).toHaveBeenCalled();
    await expect(fetch(hosts[0].url, { method: "POST" })).rejects.toThrow();
  }

  it("serves the tools to the CLI over MCP and returns the answer with the rounds counted", async () => {
    const tools = toolset();
    const { req, events } = request(tools);
    const seen: { file?: string; results: ToolCallResult[]; toolNames?: string[] } = { results: [] };

    script = async (cli) => {
      const mcp = await connect(cli);
      seen.file = mcp.file;
      seen.toolNames = mcp.toolNames;
      cli.line({ type: "system", subtype: "init", model: "claude-opus-5-5" });
      writeMessage(cli, "msg_1", [{ type: "thinking" }, serverTool("toolu_1", "get_client_answer", { question_id: "Q1" })]);
      seen.results.push(await mcp.call("get_client_answer", { question_id: "Q1" }, "toolu_1"));
      // Two calls in one message: one round.
      writeMessage(cli, "msg_2", [
        serverTool("toolu_2", "lookup_fact", { fact_id: "F1" }),
        serverTool("toolu_3", "check_quote", { text: "trois filiales" }),
      ]);
      seen.results.push(
        ...(await Promise.all([
          mcp.call("lookup_fact", { fact_id: "F1" }, "toolu_2"),
          mcp.call("check_quote", { text: "trois filiales" }, "toolu_3"),
        ])),
      );
      writeAnswer(cli, "msg_3", { reply: "Bonjour, je vous écoute." });
      cli.exit(0);
    };

    const result = await runClaudeCode(req);

    expect(result).toEqual({
      output: { reply: "Bonjour, je vous écoute." },
      model: "claude-opus-5-5",
      costUsd: 0.021,
      rateLimit: null,
      toolIterations: 2,
    });
    expect(seen.toolNames).toEqual(INTERVIEW_TOOLS.map((tool) => tool.name));
    // The two parallel calls may reach the server in either order.
    expect(tools.call).toHaveBeenCalledTimes(3);
    expect(tools.call.mock.calls[0]).toEqual(["get_client_answer", { question_id: "Q1" }, { callId: "toolu_1" }]);
    expect(tools.call).toHaveBeenCalledWith("lookup_fact", { fact_id: "F1" }, { callId: "toolu_2" });
    expect(tools.call).toHaveBeenCalledWith("check_quote", { text: "trois filiales" }, { callId: "toolu_3" });
    expect(seen.results).toEqual([
      { content: [{ type: "text", text: 'get_client_answer {"question_id":"Q1"}' }], isError: false },
      { content: [{ type: "text", text: 'lookup_fact {"fact_id":"F1"}' }], isError: false },
      { content: [{ type: "text", text: 'check_quote {"text":"trois filiales"}' }], isError: false },
    ]);

    // Only the answer streams to the client: the tools' inputs are not its JSON.
    const deltas = events.flatMap((e) => (e.type === "delta" ? [e.text] : []));
    expect(deltas.join("")).toBe(JSON.stringify({ reply: "Bonjour, je vous écoute." }));
    expect(events).toContainEqual({ type: "status", phase: "thinking" });
    expect(events).toContainEqual({ type: "status", phase: "writing" });

    // The CLI got the tool-run flags, a config file in a directory of its own, and the tool environment.
    const cli = clis[0];
    expect(cli.args).not.toContain("--safe-mode");
    expect(cli.arg("--setting-sources")).toBe("");
    expect(cli.arg("--max-turns")).toBe("7");
    expect(cli.arg("--allowedTools")).toBe(INTERVIEW_TOOLS.map((tool) => `mcp__interview__${tool.name}`).join(","));
    expect(path.dirname(path.dirname(seen.file as string))).toBe(os.tmpdir());
    expect(path.basename(seen.file as string)).toBe("mcp.json");
    expect(cli.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
    expect(cli.stdin.read()?.toString("utf8")).toBe(req.userMessage);

    await expectCleanedUp(seen.file as string);
  });

  it("refuses over MCP a call from a round past maxIterations, without running the tool", async () => {
    const tools = toolset(1);
    const { req } = request(tools);
    const seen: { file?: string; results: ToolCallResult[] } = { results: [] };

    script = async (cli) => {
      const mcp = await connect(cli);
      seen.file = mcp.file;
      writeMessage(cli, "msg_1", [serverTool("toolu_1", "lookup_fact", { fact_id: "F1" })]);
      seen.results.push(await mcp.call("lookup_fact", { fact_id: "F1" }, "toolu_1"));
      writeMessage(cli, "msg_2", [serverTool("toolu_2", "lookup_fact", { fact_id: "F2" })]);
      seen.results.push(await mcp.call("lookup_fact", { fact_id: "F2" }, "toolu_2"));
      writeAnswer(cli, "msg_3", { reply: "Voici." });
      cli.exit(0);
    };

    const result = await runClaudeCode(req);
    expect(result).toMatchObject({ output: { reply: "Voici." }, toolIterations: 2 });
    expect(clis[0].arg("--max-turns")).toBe("4");
    expect(seen.results[0].isError).toBe(false);
    expect(seen.results[1]).toEqual({ content: [{ type: "text", text: TOOL_LIMIT_TEXT }], isError: true });
    expect(tools.call).toHaveBeenCalledOnce();
    await expectCleanedUp(seen.file as string);
  });

  it.each(["before", "after"] as const)(
    "refuses over MCP a call made in the same message as the answer (answer block %s the call's), without running it",
    async (order) => {
      const tools = toolset();
      const { req } = request(tools);
      const output = { reply: "Voici." };
      const seen: { file?: string; result?: ToolCallResult } = {};

      script = async (cli) => {
        const mcp = await connect(cli);
        seen.file = mcp.file;
        const call = serverTool("toolu_1", "get_client_answer", { question_id: "Q1" });
        const answer = toolUse("toolu_out", "StructuredOutput", output);
        if (order === "before") {
          writeMessage(cli, "msg_1", [answer, call]);
          seen.result = await mcp.call("get_client_answer", { question_id: "Q1" }, "toolu_1");
        } else {
          cli.line(messageStart("msg_1"));
          cli.line(blockStart(0, { ...call, input: {} }));
          cli.line(streamEvent({ type: "content_block_stop", index: 0 }));
          // The call reaches the server while the rest of the message is still in the pipe.
          const pending = mcp.call("get_client_answer", { question_id: "Q1" }, "toolu_1");
          await vi.waitFor(() => expect(hosts[0].callCount()).toBe(1), { interval: 5 });
          cli.line(blockStart(1, { ...answer, input: {} }));
          cli.line(streamEvent({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(output) } }));
          cli.line(streamEvent({ type: "content_block_stop", index: 1 }));
          cli.line(streamEvent({ type: "message_stop" }));
          seen.result = await pending;
        }
        // The CLI ran both blocks; the answer ends the turn.
        cli.line({ type: "result", subtype: "success", is_error: false, structured_output: output, total_cost_usd: 0.01 });
        cli.exit(0);
      };

      const result = await runClaudeCode(req);
      expect(result).toMatchObject({ output, toolIterations: 1 });
      expect(seen.result).toEqual({ content: [{ type: "text", text: ANSWER_SENT_TEXT }], isError: true });
      // Never run, so never a reveal.
      expect(tools.call).not.toHaveBeenCalled();
      await expectCleanedUp(seen.file as string);
    },
  );

  it("writes the token config into a private directory of its own, created for the run and removed with it", async () => {
    const seen: { dir: string; entries: string[]; dirMode: number; fileMode: number }[] = [];

    script = async (cli) => {
      const file = cli.arg("--mcp-config") as string;
      const dir = path.dirname(file);
      seen.push({ dir, entries: readdirSync(dir), dirMode: statSync(dir).mode & 0o777, fileMode: statSync(file).mode & 0o777 });
      writeAnswer(cli, `msg_${seen.length}`, { reply: "ok" });
      cli.exit(0);
    };

    await runClaudeCode(request(toolset()).req);
    await runClaudeCode(request(toolset()).req);

    expect(seen).toHaveLength(2);
    for (const run of seen) {
      // A fresh mkdtemp name beside the shared work dir, never inside it, holding this run's config only.
      expect(path.dirname(run.dir)).toBe(os.tmpdir());
      expect(path.basename(run.dir)).toMatch(/^consultant-dots-mcp-\w{6}$/);
      expect(run.entries).toEqual(["mcp.json"]);
      if (process.platform !== "win32") {
        expect(run.dirMode).toBe(0o700);
        expect(run.fileMode).toBe(0o600);
      }
      expect(existsSync(run.dir)).toBe(false);
    }
    expect(seen[1].dir).not.toBe(seen[0].dir);
    expect(hosts.map((host) => host.close.mock.calls.length)).toEqual([1, 1]);
  });

  it("restarts the StructuredOutput index with each message, so a tool's input never streams as the answer", async () => {
    const { req, events } = request(toolset());
    let file = "";

    script = async (cli) => {
      const mcp = await connect(cli);
      file = mcp.file;
      // A first attempt at the answer, at index 0, that the CLI turned down…
      cli.line(messageStart("msg_1"));
      cli.line(blockStart(0, toolUse("toolu_0", "StructuredOutput")));
      cli.line(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }));
      // …then a tool call at the same index in the next message.
      writeMessage(cli, "msg_2", [serverTool("toolu_1", "get_client_answer", { question_id: "Q2" })]);
      await mcp.call("get_client_answer", { question_id: "Q2" }, "toolu_1");
      writeAnswer(cli, "msg_3", { reply: "Entendu." });
      cli.exit(0);
    };

    const result = await runClaudeCode(req);
    expect(result).toMatchObject({ output: { reply: "Entendu." }, toolIterations: 1 });
    const deltas = events.flatMap((e) => (e.type === "delta" ? [e.text] : []));
    expect(deltas.join("")).not.toContain("question_id");
    expect(deltas.join("")).toBe(`{}${JSON.stringify({ reply: "Entendu." })}`);
    await expectCleanedUp(file);
  });

  it("maps error_max_turns to invalid_output, and cleans up", async () => {
    const { req } = request(toolset());
    let file = "";

    script = async (cli) => {
      const mcp = await connect(cli);
      file = mcp.file;
      writeMessage(cli, "msg_1", [serverTool("toolu_1")]);
      await mcp.call("lookup_fact", {}, "toolu_1");
      cli.line({ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 7, result: "" });
      cli.exit(1);
    };

    const error = await runClaudeCode(req).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(EngineError);
    expect(error).toMatchObject({ code: "invalid_output", message: expect.stringMatching(/trop d'appels d'outils.*réessaie/) });
    await expectCleanedUp(file);
  });

  it("still maps other result errors as before", async () => {
    const { req } = request(toolset());
    let file = "";

    script = async (cli) => {
      file = (await connect(cli)).file;
      cli.line({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "Usage limit reached" });
      cli.exit(1);
    };

    await expect(runClaudeCode(req)).rejects.toMatchObject({ code: "usage_limit" });
    await expectCleanedUp(file);
  });

  it("closes the server and deletes its config on abort", async () => {
    const controller = new AbortController();
    const { req } = request(toolset(), { signal: controller.signal });
    let file = "";

    script = async (cli) => {
      file = (await connect(cli)).file;
      cli.line(messageStart("msg_1"));
      // The model thinks; the user stops the turn.
      controller.abort();
    };

    await expect(runClaudeCode(req)).rejects.toMatchObject({ code: "aborted" });
    expect(clis[0].signalCode).toBe("SIGTERM");
    await expectCleanedUp(file);
  });

  it("closes the server and deletes its config on timeout", async () => {
    const { req } = request(toolset(), { timeoutMs: 1_000 });
    let file = "";

    script = async (cli) => {
      file = (await connect(cli)).file;
    };

    await expect(runClaudeCode(req)).rejects.toMatchObject({ code: "timeout" });
    expect(clis[0].signalCode).toBe("SIGTERM");
    await expectCleanedUp(file);
  });

  it("closes the server and deletes its config when the CLI cannot start", async () => {
    const { req } = request(toolset());
    let file = "";

    script = async (cli) => {
      file = cli.arg("--mcp-config") as string;
      expect(existsSync(file)).toBe(true);
      cli.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
    };

    await expect(runClaudeCode(req)).rejects.toMatchObject({ code: "claude_not_found" });
    await expectCleanedUp(file);
  });

  it("closes the server and deletes its config when the CLI exits without a result", async () => {
    const { req } = request(toolset());
    let file = "";

    script = async (cli) => {
      file = (await connect(cli)).file;
      cli.stderr.write("boom");
      cli.exit(2);
    };

    await expect(runClaudeCode(req)).rejects.toMatchObject({ code: "engine_error", message: expect.stringContaining("code 2") });
    await expectCleanedUp(file);
  });

  it("fails cleanly when the tool server cannot start, without spawning the CLI", async () => {
    vi.mocked(startMcpHost).mockRejectedValueOnce(new Error("listen EACCES"));
    const { req } = request(toolset());

    await expect(runClaudeCode(req)).rejects.toMatchObject({ code: "engine_error", message: expect.stringContaining("listen EACCES") });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("leaves a pipeline stage as it was: --safe-mode, no server, no tool environment", async () => {
    for (const name of ["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]) delete process.env[name];
    const { req, events } = request();

    script = async (cli) => {
      writeAnswer(cli, "msg_1", { reply: "ok" });
      cli.exit(0);
    };

    const result = await runClaudeCode(req);
    expect(result).toEqual({ output: { reply: "ok" }, model: "claude-opus-5-5", costUsd: 0.021, rateLimit: null });
    expect(result).not.toHaveProperty("toolIterations");
    expect(startMcpHost).not.toHaveBeenCalled();
    const cli = clis[0];
    expect(cli.args).toContain("--safe-mode");
    expect(cli.args).not.toContain("--mcp-config");
    expect(cli.args).not.toContain("--setting-sources");
    expect(cli.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBeUndefined();
    expect(events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("")).toBe('{"reply":"ok"}');
  });
});
