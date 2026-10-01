import type { StageEvent } from "@/lib/schemas/api";
import { InterviewRequestSchema } from "@/lib/interview/schema";
import { runInterviewTurn } from "@/lib/interview/run-turn";
import { rejectNonLocal } from "@/lib/server/guard";

/** One interviewer turn, streamed as NDJSON StageEvents like a pipeline stage. */
export async function POST(request: Request) {
  const blocked = rejectNonLocal(request, { requireJson: true });
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Corps JSON invalide." }, { status: 400 });
  }
  const parsed = InterviewRequestSchema.safeParse(body);
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
      void runInterviewTurn(parsed.data, emit, abort.signal).finally(() => {
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
