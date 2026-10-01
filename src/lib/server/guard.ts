const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostnameOf(value: string, withScheme: boolean): string | null {
  try {
    return new URL(withScheme ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

const deny = (status: number, message: string) => Response.json({ error: message }, { status });

/**
 * The stage API spends the user's Claude plan: only same-origin requests from this machine may call it.
 * The Host check blocks DNS rebinding, Origin / Sec-Fetch-Site block cross-site pages, and requiring
 * application/json forces a CORS preflight that we never answer.
 */
export function rejectNonLocal(request: Request, options: { requireJson?: boolean } = {}): Response | null {
  const host = request.headers.get("host");
  const hostname = host ? hostnameOf(host, false) : null;
  if (!hostname || !LOCAL_HOSTNAMES.has(hostname)) return deny(403, "Hôte non autorisé.");

  const origin = request.headers.get("origin");
  if (origin) {
    const originHost = hostnameOf(origin, true);
    if (!originHost || !LOCAL_HOSTNAMES.has(originHost)) return deny(403, "Origine non autorisée.");
  }

  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return deny(403, "Requête inter-sites refusée.");

  if (options.requireJson && !(request.headers.get("content-type") ?? "").includes("application/json")) {
    return deny(415, "Content-Type application/json requis.");
  }
  return null;
}
