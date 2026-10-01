import { isStageId } from "@/lib/schemas";
import { StageRequestSchema, type StageEvent } from "@/lib/schemas/api";
import { runStage } from "@/lib/pipeline/run-stage";
import { rejectNonLocal } from "@/lib/server/guard";

export async function POST(request: Request, ctx: RouteContext<"/api/stage/[stage]">) {
  const blocked = rejectNonLocal(request, { requireJson: true });
  if (blocked) return blocked;

  const { stage } = await ctx.params;
  if (!isStageId(stage)) return Response.json({ error: "Étape inconnue." }, { status: 404 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Corps JSON invalide." }, { status: 400 });
  }
  const parsed = StageRequestSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Requête invalide." }, { status: 400 });

  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const emit = (event: StageEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          closed = true;
        }
      };
      void runStage(stage, parsed.data, emit, abort.signal).finally(() => {
        if (closed) return;
        closed = true;
        controller.close();
      });
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
