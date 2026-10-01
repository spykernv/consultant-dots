"use client";

import dynamic from "next/dynamic";

const Workspace = dynamic(() => import("./Workspace"), {
  ssr: false,
  loading: () => <div className="min-h-dvh bg-slate-50" />,
});

export function ClientApp() {
  return <Workspace />;
}
