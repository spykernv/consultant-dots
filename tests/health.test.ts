import { execFile } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childEnv, claudeHealth } from "@/lib/engine/claude-code";
import { GET } from "@/app/api/health/route";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: vi.fn(),
}));

type Reply = { code?: number; stdout?: string; timedOut?: boolean };

/** Answers each CLI call (`--version`, `auth status`) like execFile would, exit code included. */
function fakeCli(replies: Record<string, Reply>) {
  vi.mocked(execFile).mockClear().mockImplementation(((_bin: string, args: string[], _options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
    const reply = replies[args.join(" ")] ?? { code: 1 };
    const err = reply.timedOut
      ? Object.assign(new Error("Command failed"), { code: null, killed: true, signal: "SIGTERM" })
      : reply.code
        ? Object.assign(new Error("Command failed"), { code: reply.code })
        : null;
    callback(err, reply.stdout ?? "", "");
  }) as unknown as typeof execFile);
}

const version = { stdout: "2.1.283 (Claude Code)\n" };
const loggedIn = { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }, null, 2) };
const loggedOut = { code: 1, stdout: JSON.stringify({ loggedIn: false, authMethod: "none" }, null, 2) };

describe("claude health", () => {
  beforeEach(() => {
    process.env.CONSULTANT_DOTS_CLAUDE_BIN = process.execPath;
  });
  afterEach(() => {
    delete process.env.CONSULTANT_DOTS_CLAUDE_BIN;
    vi.mocked(execFile).mockReset();
  });

  it("reports a logged-out CLI as not OK even though `auth status` exits 1", async () => {
    fakeCli({ "--version": version, "auth status": loggedOut });
    expect(await claudeHealth()).toMatchObject({
      ok: false,
      binFound: true,
      version: "2.1.283",
      loggedIn: false,
      error: "Claude Code n'est pas connecté : lance `claude` dans un terminal puis /login.",
    });
  });

  it("reports a logged-in CLI as OK with its subscription", async () => {
    fakeCli({ "--version": version, "auth status": loggedIn });
    expect(await claudeHealth()).toMatchObject({ ok: true, loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", error: null });
  });

  it("reads the status through terminal noise and line wrapping", async () => {
    fakeCli({ "--version": version, "auth status": { stdout: `\u001b[?25l${loggedIn.stdout}\n\u001b[?25h` } });
    expect(await claudeHealth()).toMatchObject({ ok: true, subscriptionType: "max" });

    fakeCli({ "--version": version, "auth status": { code: 1, stdout: '{\n  "loggedIn": false,\n  "orgName": "Example\nOrganization"\n}' } });
    expect(await claudeHealth()).toMatchObject({ ok: false, loggedIn: false });
  });

  it.each([
    ["garbage output", { stdout: "Usage: claude [options]" }],
    ["empty output with an error exit", { code: 2 }],
    ["a timeout", { timedOut: true }],
  ])("does not report an unreadable status as healthy (%s)", async (_label, reply) => {
    fakeCli({ "--version": version, "auth status": reply });
    const health = await claudeHealth();
    expect(health).toMatchObject({ ok: false, binFound: true, loggedIn: null });
    expect(health.error).toMatch(/inconnu.*claude auth status/);
  });

  it("caches only a healthy status in /api/health", async () => {
    const get = (query = "") => GET(new Request(`http://127.0.0.1:3000/api/health${query}`, { headers: { host: "127.0.0.1:3000" } }));
    fakeCli({ "--version": version, "auth status": loggedOut });
    expect(await (await get()).json()).toMatchObject({ ok: false, loggedIn: false });

    fakeCli({ "--version": version, "auth status": loggedIn });
    expect(await (await get()).json()).toMatchObject({ ok: true, loggedIn: true });

    fakeCli({ "--version": version, "auth status": loggedOut });
    expect(await (await get()).json()).toMatchObject({ ok: true });
    expect(execFile).not.toHaveBeenCalled();
    expect(await (await get("?fresh")).json()).toMatchObject({ ok: false, loggedIn: false });
  });
});

describe("child environment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
  });

  it("drops provider credentials in subscription mode so the Claude login is used", () => {
    Object.assign(process.env, { PROVIDER_API_KEY: "k", Other_Api_Key: "k", PROVIDER_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", KEEP_ME: "1" });
    const env = childEnv();
    expect(env.PROVIDER_API_KEY).toBeUndefined();
    expect(env.Other_Api_Key).toBeUndefined();
    expect(env.PROVIDER_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("o");
    expect(env.KEEP_ME).toBe("1");
  });

  it("passes the environment through in inherit mode", () => {
    Object.assign(process.env, { PROVIDER_API_KEY: "k", CONSULTANT_DOTS_CLAUDE_AUTH: "inherit" });
    expect(childEnv().PROVIDER_API_KEY).toBe("k");
  });
});
