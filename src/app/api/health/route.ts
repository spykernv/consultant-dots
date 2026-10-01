import { claudeHealth, getLastRateLimit, type ClaudeHealth } from "@/lib/engine/claude-code";
import { apiHealth } from "@/lib/engine/claude-api";
import { engineEnv, type EngineKind } from "@/lib/engine/config";
import { rejectNonLocal } from "@/lib/server/guard";

type Health = ClaudeHealth & { engine: EngineKind };

let cache: { at: number; value: Health } | null = null;
const TTL_MS = 60_000;

export async function GET(request: Request) {
  const blocked = rejectNonLocal(request);
  if (blocked) return blocked;

  const fresh = new URL(request.url).searchParams.has("fresh");
  const { engine } = engineEnv();
  if (!cache || fresh || cache.value.engine !== engine || Date.now() - cache.at > TTL_MS || !cache.value.ok) {
    cache = { at: Date.now(), value: engine === "api" ? await apiStatus() : { ...(await claudeHealth()), engine } };
  }
  // The 5-hour quota belongs to the Claude login: it means nothing for an API key.
  return Response.json(
    { ...cache.value, rateLimit: cache.value.engine === "cli" ? getLastRateLimit() : null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** The API engine has no CLI or login to check: the key and the model are checked by a free model lookup. */
async function apiStatus(): Promise<Health> {
  const api = await apiHealth();
  return {
    engine: "api",
    ok: api.ok,
    binFound: false,
    version: null,
    loggedIn: null,
    authMethod: "api_key",
    subscriptionType: null,
    model: api.model,
    rateLimit: null,
    error: api.error,
  };
}
