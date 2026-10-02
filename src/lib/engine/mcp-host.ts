import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { EngineToolResult, EngineToolSet } from "./types";

/**
 * A minimal MCP server over Streamable HTTP, inside the app's own process: the Claude Code CLI connects to it with
 * --mcp-config, so the interviewer's tools run in the same code as on the API engine. It listens on 127.0.0.1 only,
 * on a random port, behind a random bearer token, for the length of one run. JSON responses only, no SSE stream.
 */

/** Protocol versions this server speaks, newest first; an initialize asking for another one gets the newest. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const MAX_MCP_BODY_BYTES = 64 * 1024;

export type McpServerConfig = { type: "http"; url: string; headers: Record<string, string> };

export type McpHost = {
  /** Where the server listens, as server.address() reports it: 127.0.0.1, on a random port. */
  address: AddressInfo;
  /** http://127.0.0.1:<port>/mcp, built from address. */
  url: string;
  /** What --mcp-config takes: { mcpServers: { [toolset.serverName]: { type: "http", url, headers } } }. */
  config: { mcpServers: Record<string, McpServerConfig> };
  /** tools/call requests served so far, refused ones included. */
  callCount(): number;
  /** Stops listening and drops open connections; safe to call twice. */
  close(): Promise<void>;
};

const MCP_PATH = "/mcp";
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

/** Browsers send an Origin; the CLI sends none. A page on any other origin is a DNS-rebinding attempt. */
const LOCAL_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;

type JsonRpcId = string | number | null;
type RpcOutcome = { result: unknown } | { error: { code: number; message: string } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rpcError = (code: number, message: string): RpcOutcome => ({ error: { code, message } });

/** JSON-RPC answers a request it cannot identify with id null. */
const idOf = (message: unknown): JsonRpcId =>
  isRecord(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;

function sendText(res: ServerResponse, status: number, text: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

function sendRpc(res: ServerResponse, id: JsonRpcId, outcome: RpcOutcome) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, ...outcome }));
}

/**
 * Resolves null as soon as the body passes the cap. The rest is drained, never buffered: closing the socket on unread
 * bytes resets the connection, and the client would get that reset instead of its 413.
 */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MCP_BODY_BYTES) {
        req.off("data", onData);
        req.resume();
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Starts the server for one toolset. JSON-RPC handled: initialize, ping, tools/list (the toolset's tools, with
 * inputSchema), tools/call (passes params._meta["claudecode/toolUseId"] as context.callId; answers
 * { content: [{ type: "text", text }], isError }), notifications (202, no body). Anything else: JSON-RPC error
 * -32601 (method) or -32600 (invalid request, batches included). HTTP: POST only (GET and others 405), a missing or
 * wrong bearer token 401, a body over MAX_MCP_BODY_BYTES 413, invalid JSON a -32700 error, a non-local Origin 403.
 */
export async function startMcpHost(toolset: EngineToolSet): Promise<McpHost> {
  const token = randomBytes(24).toString("base64url");
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const tools = toolset.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  let calls = 0;

  const authorized = (header: string | undefined) => {
    const given = Buffer.from(header ?? "");
    return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth);
  };

  // toolset.call promises never to throw; a broken one still answers the model instead of failing the request.
  const runTool = async (name: string, input: unknown, callId: string | undefined): Promise<EngineToolResult> => {
    try {
      return await toolset.call(name, input, { callId });
    } catch (err) {
      return { text: `The tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  };

  const dispatch = async (method: string, params: Record<string, unknown>): Promise<RpcOutcome> => {
    switch (method) {
      case "initialize": {
        const protocolVersion = MCP_PROTOCOL_VERSIONS.find((v) => v === params.protocolVersion) ?? MCP_PROTOCOL_VERSIONS[0];
        return {
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: toolset.serverName, version: "1.0.0" },
          },
        };
      }
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools } };
      case "tools/call": {
        calls++;
        if (typeof params.name !== "string") return rpcError(INVALID_PARAMS, "tools/call needs a string params.name.");
        const meta = params._meta;
        const callId = isRecord(meta) && typeof meta["claudecode/toolUseId"] === "string" ? meta["claudecode/toolUseId"] : undefined;
        const { text, isError } = await runTool(params.name, params.arguments ?? {}, callId);
        return { result: { content: [{ type: "text", text }], isError } };
      }
      default:
        // "server/discover" lands here too: the CLI then falls back to initialize.
        return rpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split("?")[0] !== MCP_PATH) return sendText(res, 404, "Not found");
    const origin = req.headers.origin;
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) return sendText(res, 403, "Forbidden origin");
    if (!authorized(req.headers.authorization)) return sendText(res, 401, "Unauthorized");
    // The CLI opens an SSE stream with GET; 405 tells it this server answers in the POST response only.
    if (req.method !== "POST") return sendText(res, 405, "Method not allowed", { Allow: "POST" });

    // A declared length over the cap is refused unread (node drains the body once the response is sent).
    if (Number(req.headers["content-length"]) > MAX_MCP_BODY_BYTES) return sendText(res, 413, "Payload too large");
    const body = await readBody(req);
    if (body === null) return sendText(res, 413, "Payload too large");

    let message: unknown;
    try {
      message = JSON.parse(body.toString("utf8"));
    } catch {
      return sendRpc(res, null, rpcError(PARSE_ERROR, "Parse error"));
    }
    if (Array.isArray(message)) return sendRpc(res, null, rpcError(INVALID_REQUEST, "Batches are not supported."));
    if (
      !isRecord(message) ||
      message.jsonrpc !== "2.0" ||
      typeof message.method !== "string" ||
      ("id" in message && message.id !== null && idOf(message) === null)
    ) {
      return sendRpc(res, idOf(message), rpcError(INVALID_REQUEST, "Invalid request"));
    }
    // A notification (no id) expects no answer: notifications/initialized, notifications/cancelled…
    if (!("id" in message)) {
      res.writeHead(202);
      return void res.end();
    }

    const params = isRecord(message.params) ? message.params : {};
    sendRpc(res, idOf(message), await dispatch(message.method, params));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      // Only a failed request stream gets here (the client left, or close() dropped it): answer if the socket still can.
      if (res.headersSent) res.destroy();
      else sendText(res, 500, "Internal error");
    });
  });
  // The model can think for minutes between two calls: an idle socket the server closed just as the CLI reuses it
  // would fail that tool call. Idle sockets stay open for the run instead, and close() drops them.
  server.keepAliveTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  // The URL comes from the socket actually bound, so what the CLI dials is where the server listens: loopback only.
  const address = { ...(server.address() as AddressInfo) };
  const url = `http://${address.address}:${address.port}${MCP_PATH}`;
  let closing: Promise<void> | null = null;

  return {
    address,
    url,
    config: {
      mcpServers: { [toolset.serverName]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } },
    },
    callCount: () => calls,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() alone waits for keep-alive sockets and in-flight tool calls; the run is over, drop them.
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
