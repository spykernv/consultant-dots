import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_MCP_BODY_BYTES, MCP_PROTOCOL_VERSIONS, startMcpHost, type McpHost } from "@/lib/engine/mcp-host";
import type { EngineTool, EngineToolSet } from "@/lib/engine/types";

const TOOLS: EngineTool[] = [
  {
    name: "echo",
    description: "Say the text back.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "What to say back." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "noop",
    description: "Do nothing.",
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
];

/** A toolset whose call() answers with what it was given, unless the test passes its own. */
function fakeToolset(call?: EngineToolSet["call"]) {
  return {
    serverName: "interview",
    tools: TOOLS,
    maxIterations: 4,
    call: vi.fn<EngineToolSet["call"]>(call ?? (async (name, input) => ({ text: `${name}: ${JSON.stringify(input)}`, isError: false }))),
  } satisfies EngineToolSet;
}

const hosts: McpHost[] = [];

async function start(toolset: EngineToolSet = fakeToolset()) {
  const host = await startMcpHost(toolset);
  hosts.push(host);
  return host;
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

const auth = (host: McpHost) => host.config.mcpServers.interview.headers;

/** A POST as the CLI sends it: bearer token from the config, JSON body, both content types accepted. */
function post(host: McpHost, body: unknown, headers: Record<string, string> = {}, url = host.url) {
  return fetch(url, {
    method: "POST",
    headers: { ...auth(host), "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type RpcResponse = { jsonrpc: string; id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };

async function rpcBody(response: Response): Promise<RpcResponse> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/json");
  const body = (await response.json()) as RpcResponse;
  expect(body.jsonrpc).toBe("2.0");
  return body;
}

const rpc = async (host: McpHost, method: string, params?: unknown, id: unknown = 1) =>
  rpcBody(await post(host, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));

const callTool = (host: McpHost, params: unknown, id: unknown = 1) => rpc(host, "tools/call", params, id);

describe("MCP host: HTTP", () => {
  it("listens on 127.0.0.1 behind a random bearer token, in the shape --mcp-config takes", async () => {
    const [a, b] = [await start(), await start()];

    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(a.config).toEqual({
      mcpServers: { interview: { type: "http", url: a.url, headers: { Authorization: expect.stringMatching(/^Bearer [\w-]{32}$/) } } },
    });
    expect(b.url).not.toBe(a.url);
    expect(auth(b).Authorization).not.toBe(auth(a).Authorization);
  });

  it("binds the IPv4 loopback address only, as the socket reports it, and builds its URL from it", async () => {
    const host = await start();
    const { port } = host.address;

    // From server.address(): what the server is really bound to, not what the URL says.
    expect(host.address).toEqual({ address: "127.0.0.1", family: "IPv4", port: expect.any(Number) });
    expect(port).toBeGreaterThan(0);
    expect(host.url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(host.config.mcpServers.interview.url).toBe(host.url);
    // Not on the IPv6 loopback either (an unspecified "::" bind would answer there).
    await expect(fetch(`http://[::1]:${port}/mcp`, { method: "POST", headers: auth(host), body: "{}" })).rejects.toThrow();
  });

  it("keys the config by the toolset's server name", async () => {
    const host = await start({ ...fakeToolset(), serverName: "other" });
    expect(Object.keys(host.config.mcpServers)).toEqual(["other"]);
  });

  it("refuses a missing or wrong token with a plain 401, before anything runs", async () => {
    const toolset = fakeToolset();
    const host = await start(toolset);
    const other = await start();
    const token = auth(host).Authorization;
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "noop", arguments: {} } };

    const noAuth = await fetch(host.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(call) });
    const refused = [
      noAuth,
      await post(host, call, { Authorization: auth(other).Authorization }),
      await post(host, call, { Authorization: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}` }),
      await post(host, call, { Authorization: token.slice(0, -1) }),
      await post(host, call, { Authorization: `${token}x` }),
      await post(host, call, { Authorization: token.replace("Bearer", "bearer") }),
      await post(host, call, { Authorization: "" }),
    ];

    for (const response of refused) {
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await response.text()).toBe("Unauthorized");
    }
    expect(toolset.call).not.toHaveBeenCalled();
    expect(host.callCount()).toBe(0);
    expect((await post(host, call)).status).toBe(200);
  });

  it("accepts no Origin or a local one, and refuses any other with 403", async () => {
    const toolset = fakeToolset();
    const host = await start(toolset);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

    for (const origin of ["http://127.0.0.1:3000", "http://localhost:3000", "https://localhost", "http://LocalHost:8080", "https://127.0.0.1"]) {
      expect((await post(host, ping, { Origin: origin })).status, origin).toBe(200);
    }
    for (const origin of [
      "https://example.com",
      "http://localhost.example.com",
      "http://127.0.0.1.example.com",
      "http://localhost:3000.example.com",
      "http://example.com/http://localhost",
      "file://localhost",
      "http://[::1]:3000",
      "null",
      "",
    ]) {
      const response = await post(host, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "noop" } }, { Origin: origin });
      expect(response.status, origin).toBe(403);
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    }
    expect(toolset.call).not.toHaveBeenCalled();
  });

  it("answers GET and every other method but POST with 405 Allow: POST", async () => {
    const host = await start();
    for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
      const response = await fetch(host.url, { method, headers: { ...auth(host), Accept: "text/event-stream" } });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
  });

  it("answers 404 on any other path, and serves /mcp whatever its query string", async () => {
    const host = await start();
    const origin = new URL(host.url).origin;
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

    for (const path of ["/", "/mcp/", "/mcp/tools", "/MCP", "/other"]) {
      expect((await post(host, ping, {}, `${origin}${path}`)).status, path).toBe(404);
    }
    expect((await post(host, ping, {}, `${host.url}?session=1`)).status).toBe(200);
  });

  it("accepts a notification with 202 and an empty body", async () => {
    const toolset = fakeToolset();
    const host = await start(toolset);

    for (const method of ["notifications/initialized", "notifications/cancelled", "tools/call"]) {
      const response = await post(host, { jsonrpc: "2.0", method, params: { name: "noop" } });
      expect(response.status, method).toBe(202);
      expect(await response.text()).toBe("");
    }
    // A tools/call without an id is a notification too: nothing runs, nothing is counted.
    expect(toolset.call).not.toHaveBeenCalled();
    expect(host.callCount()).toBe(0);
  });

  it("refuses a body over the cap with 413, whether its length is declared or streamed", async () => {
    const toolset = fakeToolset();
    const host = await start(toolset);
    const call = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } });
    const padded = (size: number) => call + " ".repeat(size - call.length);

    // Exactly at the cap: still a valid request.
    expect(await callTool(host, { name: "noop" })).toMatchObject({ result: { isError: false } });
    expect((await post(host, padded(MAX_MCP_BODY_BYTES))).status).toBe(200);

    for (const size of [MAX_MCP_BODY_BYTES + 1, 4 * 1024 * 1024]) {
      const response = await post(host, padded(size));
      expect(response.status, String(size)).toBe(413);
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    }

    // No Content-Length: the cap is checked while reading.
    const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(call));
        for (let i = 0; i < 8; i++) controller.enqueue(chunk);
        controller.close();
      },
    });
    const streamed = await fetch(host.url, {
      method: "POST",
      headers: { ...auth(host), "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);

    expect(toolset.call).toHaveBeenCalledTimes(2);
    // The host still serves after refusing.
    expect(await rpc(host, "ping")).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
});

describe("MCP host: JSON-RPC", () => {
  it("negotiates the protocol version on initialize: a known one is echoed, any other gets the newest", async () => {
    const host = await start();

    for (const version of MCP_PROTOCOL_VERSIONS) {
      const { result } = await rpc(host, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "cli", version: "2" } });
      expect(result?.protocolVersion).toBe(version);
    }
    for (const params of [{ protocolVersion: "2024-11-05" }, { protocolVersion: 20251125 }, {}, undefined]) {
      const { result } = await rpc(host, "initialize", params);
      expect(result?.protocolVersion, JSON.stringify(params)).toBe(MCP_PROTOCOL_VERSIONS[0]);
    }
    expect(await rpc(host, "initialize", { protocolVersion: "2025-11-25" }, "init-1")).toEqual({
      jsonrpc: "2.0",
      id: "init-1",
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "interview", version: "1.0.0" },
      },
    });
  });

  it("answers ping with an empty result", async () => {
    const host = await start();
    expect(await rpc(host, "ping", undefined, 7)).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("lists the toolset's tools in order, each with its input schema", async () => {
    const host = await start();
    expect(await rpc(host, "tools/list", {}, 2)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    });
  });

  it("passes a tools/call's name, arguments and tool-use id to the toolset, and its result back", async () => {
    const toolset = fakeToolset(async (name) =>
      name === "echo" ? { text: "Q2: answer", isError: false } : { text: "Unknown question id Q9.", isError: true },
    );
    const host = await start(toolset);

    const ok = await callTool(
      host,
      { name: "echo", arguments: { text: "hi" }, _meta: { "claudecode/toolUseId": "toolu_01", progressToken: 3 } },
      "call-1",
    );
    expect(ok).toEqual({ jsonrpc: "2.0", id: "call-1", result: { content: [{ type: "text", text: "Q2: answer" }], isError: false } });
    expect(toolset.call).toHaveBeenLastCalledWith("echo", { text: "hi" }, { callId: "toolu_01" });

    const refused = await callTool(host, { name: "noop", arguments: { question_id: "Q9" } }, 2);
    expect(refused.result).toEqual({ content: [{ type: "text", text: "Unknown question id Q9." }], isError: true });
  });

  it("defaults the arguments to {} and leaves the call id out when the CLI gives none", async () => {
    const toolset = fakeToolset();
    const host = await start(toolset);

    await callTool(host, { name: "noop" });
    await callTool(host, { name: "noop", arguments: null, _meta: { "claudecode/toolUseId": 42 } });
    await callTool(host, { name: "noop", _meta: "toolu_01" });
    // Arguments of the wrong shape reach the toolset as they are: its own validation answers the model.
    await callTool(host, { name: "echo", arguments: "hi" });

    expect(toolset.call.mock.calls).toEqual([
      ["noop", {}, { callId: undefined }],
      ["noop", {}, { callId: undefined }],
      ["noop", {}, { callId: undefined }],
      ["echo", "hi", { callId: undefined }],
    ]);
  });

  it("turns a toolset that throws into an error result, never a failed request", async () => {
    const toolset = fakeToolset(async (name) => {
      if (name === "echo") throw new Error("boom");
      throw "bare string";
    });
    const host = await start(toolset);

    const thrown = await callTool(host, { name: "echo", arguments: { text: "hi" } });
    expect(thrown.result?.isError).toBe(true);
    expect(thrown.result?.content).toEqual([{ type: "text", text: expect.stringContaining("boom") }]);
    const bare = await callTool(host, { name: "noop" }, 2);
    expect(bare).toMatchObject({ id: 2, result: { isError: true, content: [{ type: "text", text: expect.stringContaining("bare string") }] } });
    expect(await rpc(host, "ping")).toMatchObject({ result: {} });
  });

  it("answers a tools/call without a string name with -32602, and runs nothing", async () => {
    const toolset = fakeToolset();
    const host = await start(toolset);

    for (const params of [{}, { name: 3 }, { arguments: { text: "hi" } }, undefined, ["echo"]]) {
      const body = await callTool(host, params, "bad");
      expect(body.id).toBe("bad");
      expect(body.result).toBeUndefined();
      expect(body.error?.code, JSON.stringify(params)).toBe(-32602);
    }
    expect(toolset.call).not.toHaveBeenCalled();
  });

  it("answers unknown methods with -32601, server/discover included", async () => {
    const host = await start();
    for (const method of ["server/discover", "resources/list", "prompts/list", "tools/List", ""]) {
      const body = await rpc(host, method, {}, 5);
      expect(body.id).toBe(5);
      expect(body.error?.code, method).toBe(-32601);
    }
  });

  it("refuses a batch with -32600 and runs none of it", async () => {
    const toolset = fakeToolset();
    const host = await start(toolset);
    const batch = [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "noop" } },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ];

    expect(await rpcBody(await post(host, batch))).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: expect.any(String) } });
    expect(await rpcBody(await post(host, []))).toMatchObject({ id: null, error: { code: -32600 } });
    expect(toolset.call).not.toHaveBeenCalled();
  });

  it("refuses a message that is not a JSON-RPC 2.0 request with -32600, echoing a usable id", async () => {
    const host = await start();
    const cases: [unknown, unknown][] = [
      [{ jsonrpc: "1.0", id: 1, method: "ping" }, 1],
      [{ id: 2, method: "ping" }, 2],
      [{ jsonrpc: "2.0", id: 3 }, 3],
      [{ jsonrpc: "2.0", id: "r", result: {} }, "r"],
      [{ jsonrpc: "2.0", id: 4, method: 42 }, 4],
      [{ jsonrpc: "2.0", id: { a: 1 }, method: "ping" }, null],
      [{ jsonrpc: "2.0", id: true, method: "ping" }, null],
      ["ping", null],
      [42, null],
      [null, null],
    ];

    for (const [message, id] of cases) {
      const body = await rpcBody(await post(host, JSON.stringify(message)));
      expect(body, JSON.stringify(message)).toMatchObject({ id, error: { code: -32600 } });
    }
  });

  it("answers a request with an explicit null id, which is not a notification", async () => {
    const host = await start();
    expect(await rpc(host, "ping", undefined, null)).toEqual({ jsonrpc: "2.0", id: null, result: {} });
  });

  it("answers invalid JSON with -32700 and id null", async () => {
    const host = await start();
    for (const body of ["{not json", "", '{"jsonrpc":"2.0","id":1,', "ÿ"]) {
      expect(await rpcBody(await post(host, body)), JSON.stringify(body)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: expect.any(String) },
      });
    }
  });

  it("goes through the CLI's handshake: discover, initialize, initialized, GET, list, call", async () => {
    const toolset = fakeToolset();
    const host = await start(toolset);

    expect((await rpc(host, "server/discover", {}, 0)).error?.code).toBe(-32601);
    expect((await rpc(host, "initialize", { protocolVersion: "2025-11-25", capabilities: {} }, 1)).result?.protocolVersion).toBe("2025-11-25");
    const headers = { "MCP-Protocol-Version": "2025-11-25" };
    expect((await post(host, { jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status).toBe(202);
    expect((await fetch(host.url, { headers: { ...auth(host), ...headers, Accept: "text/event-stream" } })).status).toBe(405);
    expect((await rpc(host, "tools/list", {}, 2)).result?.tools).toHaveLength(2);
    const call = await callTool(host, { name: "echo", arguments: { text: "hi" }, _meta: { "claudecode/toolUseId": "toolu_9" } }, 3);
    expect(call.result).toEqual({ content: [{ type: "text", text: 'echo: {"text":"hi"}' }], isError: false });
    expect(toolset.call).toHaveBeenCalledWith("echo", { text: "hi" }, { callId: "toolu_9" });
  });
});

describe("MCP host: lifecycle", () => {
  it("counts the tools/call requests it served, refused ones included", async () => {
    const toolset = fakeToolset(async (name) => ({ text: name, isError: name !== "echo" }));
    const host = await start(toolset);
    expect(host.callCount()).toBe(0);

    await callTool(host, { name: "echo", arguments: { text: "hi" } });
    await callTool(host, { name: "unknown_tool" });
    await callTool(host, {});
    await rpc(host, "tools/list");
    await rpc(host, "ping");
    await post(host, { jsonrpc: "2.0", method: "tools/call", params: { name: "echo" } });
    await post(host, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "echo" } }, { Authorization: "Bearer nope" });

    expect(host.callCount()).toBe(3);
  });

  it("serves concurrent calls, each with its own answer", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const toolset = fakeToolset(async (name, input) => {
      await gate;
      return { text: `${name}:${(input as { text: string }).text}`, isError: false };
    });
    const host = await start(toolset);

    const pending = ["a", "b", "c"].map((text, i) =>
      callTool(host, { name: "echo", arguments: { text }, _meta: { "claudecode/toolUseId": `toolu_${text}` } }, i),
    );
    await vi.waitFor(() => expect(toolset.call).toHaveBeenCalledTimes(3));
    expect(host.callCount()).toBe(3);
    release();

    const answers = await Promise.all(pending);
    expect(answers.map((a) => [a.id, (a.result?.content as { text: string }[])[0].text])).toEqual([
      [0, "echo:a"],
      [1, "echo:b"],
      [2, "echo:c"],
    ]);
  });

  it("keeps idle connections open for the run instead of timing them out between two calls", async () => {
    const host = await start();
    const response = await post(host, { jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.headers.get("connection")).toBe("keep-alive");
    // Node advertises "timeout=5" by default, and closes the idle socket after it.
    expect(response.headers.get("keep-alive")).toBeNull();
  });

  it("closes once even when called twice, and stops serving", async () => {
    const host = await start();
    await rpc(host, "ping");

    await Promise.all([host.close(), host.close()]);
    await host.close();
    await expect(fetch(host.url, { method: "POST", headers: auth(host), body: "{}" })).rejects.toThrow();
  });

  it("closes without waiting for a call in flight, which then fails on the client side", async () => {
    const toolset = fakeToolset(() => new Promise(() => undefined));
    const host = await start(toolset);

    const pending = callTool(host, { name: "noop" });
    await vi.waitFor(() => expect(toolset.call).toHaveBeenCalled());
    await host.close();
    await expect(pending).rejects.toThrow();
  });
});
