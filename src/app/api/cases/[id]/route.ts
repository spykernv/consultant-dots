import { z } from "zod";
import { isCaseId, loadCase, saveCase, trashCase } from "@/lib/server/case-store";
import { rejectNonLocal } from "@/lib/server/guard";

const MAX_BODY_CHARS = 5_000_000;

const SaveSchema = z.object({
  session: z.object({ caseText: z.string(), stages: z.record(z.string(), z.unknown()) }).passthrough(),
  markdown: z.string(),
  label: z.string().max(200),
  baseRevision: z.number().int().nonnegative().nullish(),
  writeId: z.string().max(100).optional(),
  unconfirmed: z.array(z.string().max(100)).max(50).optional(),
});

async function caseId(ctx: RouteContext<"/api/cases/[id]">) {
  const { id } = await ctx.params;
  return isCaseId(id) ? id : null;
}

export async function GET(request: Request, ctx: RouteContext<"/api/cases/[id]">) {
  const blocked = rejectNonLocal(request);
  if (blocked) return blocked;
  const id = await caseId(ctx);
  const saved = id ? loadCase(id) : null;
  if (!saved) return Response.json({ error: "Case introuvable." }, { status: 404 });
  // The revision travels in a header so the body stays the session itself.
  return Response.json(saved.session, {
    headers: { "Cache-Control": "no-store", "X-Case-Revision": String(saved.revision) },
  });
}

export async function PUT(request: Request, ctx: RouteContext<"/api/cases/[id]">) {
  const blocked = rejectNonLocal(request, { requireJson: true });
  if (blocked) return blocked;
  const id = await caseId(ctx);
  if (!id) return Response.json({ error: "Identifiant invalide." }, { status: 400 });
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return Response.json({ error: "Case trop volumineux." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Corps JSON invalide." }, { status: 400 });
  }
  const parsed = SaveSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Requête invalide." }, { status: 400 });
  const saved = saveCase(id, parsed.data);
  if (saved.ok) return Response.json({ folder: saved.folder, revision: saved.revision });
  return saved.reason === "gone"
    ? Response.json({ error: "Ce case a été supprimé." }, { status: 410 })
    : Response.json({ error: "Ce case a été modifié dans un autre onglet." }, { status: 409 });
}

export async function DELETE(request: Request, ctx: RouteContext<"/api/cases/[id]">) {
  const blocked = rejectNonLocal(request);
  if (blocked) return blocked;
  const id = await caseId(ctx);
  if (!id || !trashCase(id)) return Response.json({ error: "Case introuvable." }, { status: 404 });
  return Response.json({ ok: true });
}
