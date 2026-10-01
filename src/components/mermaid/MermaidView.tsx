"use client";

import { useEffect, useState } from "react";
import type { Mermaid } from "mermaid";

let mermaidPromise: Promise<Mermaid> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let renderCount = 0;

function loadMermaid() {
  mermaidPromise ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      look: "classic",
      layout: "dagre",
      fontFamily: "var(--font-sans), ui-sans-serif, system-ui, sans-serif",
      themeVariables: {
        fontSize: "14px",
        primaryColor: "#f8fafc",
        primaryBorderColor: "#475569",
        primaryTextColor: "#0f172a",
        lineColor: "#64748b",
        clusterBkg: "#fafafa",
        clusterBorder: "#d4d4d8",
        edgeLabelBackground: "#ffffff",
      },
      flowchart: { curve: "basis", padding: 10, nodeSpacing: 28, rankSpacing: 42, htmlLabels: true, useMaxWidth: false },
    });
    return mermaid;
  });
  return mermaidPromise;
}

/** Mermaid keeps global state while rendering, so renders are serialized. */
function enqueueRender(code: string) {
  const run = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    await mermaid.parse(code);
    return mermaid.render(`mmd-${++renderCount}`, code);
  });
  renderQueue = run.catch(() => undefined);
  return run;
}

export function MermaidView({ code, fit, className }: { code: string; fit: boolean; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    enqueueRender(code)
      .then(({ svg: rendered }) => {
        if (cancelled) return;
        setSvg(rendered);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSvg(null);
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
        <p className="font-medium">Le schéma n&apos;a pas pu être rendu.</p>
        <p className="mt-1 font-mono text-[10px] whitespace-pre-wrap">{error.slice(0, 400)}</p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-white p-2 text-[10px] text-slate-700">{code}</pre>
      </div>
    );
  }
  if (!svg) return <div className="h-48 animate-pulse rounded-lg bg-slate-100" />;
  return (
    <div
      className={`overflow-auto rounded-lg border border-slate-100 bg-white p-2 ${
        fit ? "[&_svg]:h-auto [&_svg]:max-w-full" : "max-h-[70vh] [&_svg]:max-w-none"
      } ${className ?? ""}`}
      // Mermaid output is sanitized with securityLevel "strict"; labels come from our own compiler.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
