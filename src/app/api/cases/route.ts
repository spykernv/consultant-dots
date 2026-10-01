import { listCases } from "@/lib/server/case-store";
import { rejectNonLocal } from "@/lib/server/guard";

export async function GET(request: Request) {
  const blocked = rejectNonLocal(request);
  if (blocked) return blocked;
  return Response.json(listCases(), { headers: { "Cache-Control": "no-store" } });
}
