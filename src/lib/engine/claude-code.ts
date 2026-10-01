import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { engineEnv, MAX_CONCURRENT_RUNS } from "./config";
import { EngineError, type EngineRequest, type EngineResult, type RateLimitInfo } from "./types";

let cachedBin: string | null = null;
let lastRateLimit: RateLimitInfo | null = null;

export function getLastRateLimit() {
  return lastRateLimit;
}

export function resolveClaudeBin(): string | null {
  const configured = engineEnv().claudeBin;
  if (configured) return existsSync(/*turbopackIgnore: true*/ configured) ? configured : null;
  if (cachedBin && existsSync(/*turbopackIgnore: true*/ cachedBin)) return cachedBin;

  const isWindows = process.platform === "win32";
  const exe = isWindows ? "claude.exe" : "claude";
  const candidates: string[] = [];
  if (isWindows && process.env.APPDATA) {
    // A global npm install puts the CLI under its publisher's scope: node_modules/@<scope>/claude-code/bin/claude.exe.
    const modules = path.join(process.env.APPDATA, "npm", "node_modules");
    for (const scope of listDir(modules)) {
      if (scope.startsWith("@")) candidates.push(path.join(modules, scope, "claude-code", "bin", "claude.exe"));
    }
  }
  candidates.push(path.join(os.homedir(), ".local", "bin", exe));
  if (!isWindows) candidates.push(path.join(os.homedir(), ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude");
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, exe));
  }

  cachedBin = candidates.find((candidate) => existsSync(/*turbopackIgnore: true*/ candidate)) ?? null;
  return cachedBin;
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(/*turbopackIgnore: true*/ dir);
  } catch {
    return [];
  }
}

/** Provider credentials (`*_API_KEY`, `*_AUTH_TOKEN`) that the CLI would use instead of the Claude login. */
const API_CREDENTIAL = /_(API_KEY|AUTH_TOKEN)$/i;

export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (engineEnv().auth === "subscription") {
    // A user-level API key would otherwise take precedence over the Claude login. The child runs without tools,
    // so it needs none of these credentials.
    for (const name of Object.keys(env)) if (API_CREDENTIAL.test(name)) delete env[name];
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return env;
}

function workDir() {
  const dir = path.join(os.tmpdir(), "consultant-dots");
  mkdirSync(path.join(dir, "cwd"), { recursive: true });
  return dir;
}

function systemPromptFile(systemPrompt: string) {
  const dir = workDir();
  const file = path.join(dir, `system-${createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12)}.md`);
  if (!existsSync(file)) writeFileSync(file, systemPrompt, "utf8");
  return file;
}

let active = 0;
const waiting: (() => void)[] = [];

async function acquireSlot() {
  if (active < MAX_CONCURRENT_RUNS) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function releaseSlot() {
  active--;
  waiting.shift()?.();
}

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    child.kill("SIGTERM");
  }
}

function parseRateLimit(info: Record<string, unknown> | undefined): RateLimitInfo | null {
  if (!info) return null;
  const windows = (info.unifiedWindows ?? {}) as Record<string, { utilization?: number }>;
  return {
    status: String(info.status ?? "unknown"),
    rateLimitType: typeof info.rateLimitType === "string" ? info.rateLimitType : null,
    fiveHourUtilization: windows.five_hour?.utilization ?? null,
    sevenDayUtilization: windows.seven_day?.utilization ?? null,
    resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null,
  };
}

const clip = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

const NOT_LOGGED_IN = "Claude Code n'est pas connecté : lance `claude` dans un terminal puis /login.";

function mapResultError(result: Record<string, unknown>, stderr: string): EngineError {
  const status = typeof result.api_error_status === "number" ? result.api_error_status : null;
  const text = `${String(result.result ?? "")} ${stderr}`;
  if (status === 401 || status === 403 || /not logged in|\/login|invalid api key|authenticat|oauth/i.test(text)) {
    return new EngineError("not_logged_in", NOT_LOGGED_IN);
  }
  if (status === 429 || lastRateLimit?.status === "rejected" || /usage limit|rate limit|limit reached|quota/i.test(text)) {
    return new EngineError("usage_limit", "Limite d'usage Claude atteinte pour le moment. Réessaie plus tard ou change de modèle (CONSULTANT_DOTS_MODEL).");
  }
  if (status === 529 || /overloaded/i.test(text)) {
    return new EngineError("overloaded", "Claude est surchargé : réessaie dans un instant.");
  }
  if (status === 404) {
    return new EngineError("engine_error", `Modèle indisponible pour ce compte (${engineEnv().model}).`);
  }
  return new EngineError("engine_error", clip(String(result.result ?? "") || stderr || "Erreur Claude Code."));
}

function mapExitFailure(code: number | null, stderr: string): EngineError {
  if (/unrecognized_model/i.test(stderr)) {
    return new EngineError("engine_error", `Modèle non reconnu par Claude Code (${engineEnv().model}). Mets à jour le CLI : claude update.`);
  }
  if (/not logged in|\/login|authenticat/i.test(stderr)) {
    return new EngineError("not_logged_in", NOT_LOGGED_IN);
  }
  return new EngineError("engine_error", `Claude Code s'est arrêté (code ${code ?? "?"}). ${clip(stderr.trim())}`.trim());
}

export async function runClaudeCode(req: EngineRequest): Promise<EngineResult> {
  const bin = resolveClaudeBin();
  if (!bin) {
    throw new EngineError(
      "claude_not_found",
      "Claude Code introuvable. Installe le CLI Claude Code, lance `claude` puis /login, ou renseigne CONSULTANT_DOTS_CLAUDE_BIN.",
    );
  }
  if (req.signal.aborted) throw new EngineError("aborted", "Étape arrêtée.");

  await acquireSlot();
  try {
    return await spawnRun(bin, req);
  } finally {
    releaseSlot();
  }
}

function spawnRun(bin: string, req: EngineRequest): Promise<EngineResult> {
  const env = engineEnv();
  const dir = workDir();
  const args = [
    "-p",
    "--model",
    env.model,
    ...(env.fallbackModel && env.fallbackModel !== env.model ? ["--fallback-model", env.fallbackModel] : []),
    "--effort",
    req.effort,
    "--system-prompt-file",
    systemPromptFile(req.systemPrompt),
    "--json-schema",
    JSON.stringify(req.jsonSchema),
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
  ];

  return new Promise<EngineResult>((resolve, reject) => {
    if (req.signal.aborted) return reject(new EngineError("aborted", "Étape arrêtée."));

    const child = spawn(bin, args, {
      cwd: path.join(dir, "cwd"),
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutBuffer = "";
    let stderr = "";
    let result: Record<string, unknown> | null = null;
    let model: string | null = null;
    let structuredIndex: number | null = null;
    let aborted = false;
    let timedOut = false;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      fn();
    };

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    req.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, req.timeoutMs);

    const handleLine = (line: string) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === "stream_event") {
        const event = msg.event as Record<string, unknown>;
        if (event.type === "message_start") {
          model = ((event.message as Record<string, unknown>)?.model as string) ?? model;
        } else if (event.type === "content_block_start") {
          const block = event.content_block as Record<string, unknown>;
          if (block?.type === "thinking" || block?.type === "redacted_thinking") {
            req.emit({ type: "status", phase: "thinking" });
          } else if (block?.type === "tool_use" && block.name === "StructuredOutput") {
            structuredIndex = event.index as number;
            req.emit({ type: "status", phase: "writing" });
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta as Record<string, unknown>;
          if (delta?.type === "input_json_delta" && event.index === structuredIndex && typeof delta.partial_json === "string") {
            req.emit({ type: "delta", text: delta.partial_json });
          }
        }
      } else if (msg.type === "rate_limit_event") {
        lastRateLimit = parseRateLimit(msg.rate_limit_info as Record<string, unknown>) ?? lastRateLimit;
      } else if (msg.type === "result") {
        result = msg;
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 4000) stderr += chunk;
    });

    child.on("error", (err: NodeJS.ErrnoException) =>
      finish(() =>
        reject(
          err.code === "ENOENT"
            ? new EngineError("claude_not_found", "Claude Code introuvable (CONSULTANT_DOTS_CLAUDE_BIN ?).")
            : new EngineError("engine_error", `Impossible de lancer Claude Code : ${err.message}`),
        ),
      ),
    );

    child.on("close", (code) => {
      if (stdoutBuffer.trim()) handleLine(stdoutBuffer.trim());
      finish(() => {
        if (aborted) return reject(new EngineError("aborted", "Étape arrêtée."));
        if (timedOut) return reject(new EngineError("timeout", `Délai dépassé (${Math.round(req.timeoutMs / 1000)} s).`));
        const final = result as Record<string, unknown> | null;
        if (!final) return reject(mapExitFailure(code, stderr));
        if (final.is_error) return reject(mapResultError(final, stderr));
        if (final.structured_output == null) {
          return reject(new EngineError("invalid_output", "Claude n'a pas renvoyé de sortie structurée."));
        }
        const usageModels = Object.keys((final.modelUsage ?? {}) as Record<string, unknown>);
        resolve({
          output: final.structured_output,
          model: model ?? usageModels[0] ?? null,
          costUsd: typeof final.total_cost_usd === "number" ? final.total_cost_usd : null,
          rateLimit: lastRateLimit,
        });
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(req.userMessage, "utf8");
  });
}

export type ClaudeHealth = {
  ok: boolean;
  binFound: boolean;
  version: string | null;
  loggedIn: boolean | null;
  authMethod: string | null;
  subscriptionType: string | null;
  model: string;
  rateLimit: RateLimitInfo | null;
  error: string | null;
};

/** `keepOutput` resolves with stdout on a non-zero exit too: `auth status` prints its JSON then exits 1 when logged out. */
const run = (bin: string, args: string[], timeout: number, keepOutput = false) =>
  new Promise<string>((resolve, reject) =>
    execFile(bin, args, { timeout, env: childEnv(), windowsHide: true, cwd: path.join(workDir(), "cwd") }, (err, stdout) =>
      err && !(keepOutput && typeof err.code === "number") ? reject(err) : resolve(String(stdout)),
    ),
  );

function parseAuthStatus(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
  } catch {
    const loggedIn = /"loggedIn"\s*:\s*(true|false)/.exec(stdout)?.[1];
    return loggedIn ? { loggedIn: loggedIn === "true" } : {};
  }
}

export async function claudeHealth(): Promise<ClaudeHealth> {
  const env = engineEnv();
  const base: ClaudeHealth = {
    ok: false,
    binFound: false,
    version: null,
    loggedIn: null,
    authMethod: null,
    subscriptionType: null,
    model: env.model,
    rateLimit: lastRateLimit,
    error: null,
  };
  const bin = resolveClaudeBin();
  if (!bin) return { ...base, error: "Claude Code introuvable." };

  try {
    const version = (await run(bin, ["--version"], 15_000)).trim().split(/\s+/)[0] ?? null;
    let status: Record<string, unknown> = {};
    try {
      status = parseAuthStatus(await run(bin, ["auth", "status"], 20_000, true));
    } catch {
      status = {};
    }
    const loggedIn = typeof status.loggedIn === "boolean" ? status.loggedIn : null;
    return {
      ...base,
      binFound: true,
      version,
      loggedIn,
      authMethod: typeof status.authMethod === "string" ? status.authMethod : null,
      subscriptionType: typeof status.subscriptionType === "string" ? status.subscriptionType : null,
      ok: loggedIn === true,
      error:
        loggedIn === false
          ? NOT_LOGGED_IN
          : loggedIn === null
            ? "Statut de connexion Claude Code inconnu : vérifie avec `claude auth status` dans un terminal."
            : null,
    };
  } catch (err) {
    return { ...base, binFound: true, error: `Claude Code ne répond pas : ${err instanceof Error ? err.message : err}` };
  }
}
