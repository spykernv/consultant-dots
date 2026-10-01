import { afterEach, describe, expect, it, vi } from "vitest";
import { runStage } from "@/lib/pipeline/run-stage";
import { runClaudeApi } from "@/lib/engine/claude-api";
import { runClaudeCode } from "@/lib/engine/claude-code";
import type { StageEvent } from "@/lib/schemas/api";
import { fixture } from "./helpers";

vi.mock("@/lib/engine/claude-api", () => ({ runClaudeApi: vi.fn() }));
vi.mock("@/lib/engine/claude-code", () => ({ runClaudeCode: vi.fn() }));

const result = { output: fixture("classify"), model: "m", costUsd: 0.01, rateLimit: null, usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 } };

async function classify() {
  const events: StageEvent[] = [];
  const request = { runId: "r", mock: false, caseId: null, inputs: { caseText: "Un groupe industriel européen avec trois filiales." }, steer: null, previous: null, choices: null };
  await runStage("classify", request, (e) => events.push(e), new AbortController().signal);
  return events.at(-1);
}

describe("engine choice", () => {
  afterEach(() => {
    delete process.env.CONSULTANT_DOTS_ENGINE;
    vi.mocked(runClaudeApi).mockReset();
    vi.mocked(runClaudeCode).mockReset();
  });

  it("uses the Claude Code CLI unless the API engine is chosen", async () => {
    vi.mocked(runClaudeCode).mockResolvedValue(result);
    expect((await classify())?.type).toBe("done");
    expect(runClaudeCode).toHaveBeenCalledOnce();
    expect(runClaudeApi).not.toHaveBeenCalled();
  });

  it("uses the API engine when CONSULTANT_DOTS_ENGINE=api and reports its token usage", async () => {
    process.env.CONSULTANT_DOTS_ENGINE = "api";
    vi.mocked(runClaudeApi).mockResolvedValue(result);
    const done = await classify();
    expect(runClaudeApi).toHaveBeenCalledOnce();
    expect(runClaudeCode).not.toHaveBeenCalled();
    expect(done).toMatchObject({ type: "done", meta: { usage: result.usage, costUsd: 0.01 } });
  });
});
