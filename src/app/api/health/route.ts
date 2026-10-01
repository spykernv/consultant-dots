import { claudeHealth, getLastRateLimit, type ClaudeHealth } from "@/lib/engine/claude-code";
import { rejectNonLocal } from "@/lib/server/guard";

let cache: { at: number; value: ClaudeHealth } | null = null;
const TTL_MS = 60_000;

export async function GET(request: Request) {
  const blocked = rejectNonLocal(request);
  if (blocked) return blocked;

  const fresh = new URL(request.url).searchParams.has("fresh");
  if (!cache || fresh || Date.now() - cache.at > TTL_MS || !cache.value.ok) {
    cache = { at: Date.now(), value: await claudeHealth() };
  }
  return Response.json({ ...cache.value, rateLimit: getLastRateLimit() }, { headers: { "Cache-Control": "no-store" } });
}
