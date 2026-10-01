import { NODE_KIND_LABELS } from "@/lib/domain/labels";
import type { DiagramSpec, NodeKind, NodeStatus } from "@/lib/schemas/diagram";

const SHAPES: Record<NodeKind, [open: string, close: string]> = {
  actor: ['(["', '"])'],
  system: ['["', '"]'],
  data: ['[("', '")]'],
  process: ['("', '")'],
  pain_point: ['{{"', '"}}'],
  constraint: ['>"', '"]'],
  control: ['[["', '"]]'],
  output: ['[/"', '"/]'],
};

export const KIND_STYLES: Record<NodeKind, { fill: string; stroke: string; color: string }> = {
  actor: { fill: "#eef2ff", stroke: "#4f46e5", color: "#1e1b4b" },
  system: { fill: "#f8fafc", stroke: "#475569", color: "#0f172a" },
  data: { fill: "#ecfeff", stroke: "#0e7490", color: "#083344" },
  process: { fill: "#f1f5f9", stroke: "#64748b", color: "#0f172a" },
  pain_point: { fill: "#fef2f2", stroke: "#dc2626", color: "#7f1d1d" },
  constraint: { fill: "#fffbeb", stroke: "#d97706", color: "#78350f" },
  control: { fill: "#f5f3ff", stroke: "#7c3aed", color: "#2e1065" },
  output: { fill: "#f0fdf4", stroke: "#16a34a", color: "#14532d" },
};

const STATUS_STYLES: Partial<Record<NodeStatus, string>> = {
  assumption: "stroke-dasharray:5 4",
  new: "stroke-width:3px",
  changed: "stroke-width:2px",
  retired: "fill:#f4f4f5,stroke:#a1a1aa,color:#71717a,stroke-dasharray:2 3",
};

const GROUP_STYLES = {
  zone: "fill:#fafafa,stroke:#d4d4d8,color:#3f3f46",
  local_boundary: "fill:#fffbeb,stroke:#d97706,stroke-width:2px,stroke-dasharray:6 4,color:#78350f",
} as const;

const MAX_LABEL = 42;

/** Mermaid rejects an empty quoted label and the whole chart with it, so a blank one becomes `fallback`. */
export function escapeLabel(text: string, max = MAX_LABEL, fallback = "·"): string {
  let label = text.replace(/\s+/g, " ").trim() || fallback;
  if (label.length > max) label = `${label.slice(0, max - 1).trimEnd()}…`;
  return label
    .replace(/#/g, "#35;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/`/g, "'")
    .replace(/\|/g, "/");
}

const styleOf = (s: { fill: string; stroke: string; color: string }) =>
  `fill:${s.fill},stroke:${s.stroke},color:${s.color}`;

export function toMermaid(diagram: DiagramSpec): string {
  const nodeIds = new Map(diagram.nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const groupIds = new Map(diagram.groups.map((g, i) => [g.id, `g${i + 1}`]));
  const refOf = (id: string) => nodeIds.get(id) ?? (renderedGroups.has(id) ? groupIds.get(id) : undefined);

  const nodesByGroup = new Map<string | null, DiagramSpec["nodes"]>();
  for (const node of diagram.nodes) {
    const key = node.groupId && groupIds.has(node.groupId) ? node.groupId : null;
    nodesByGroup.set(key, [...(nodesByGroup.get(key) ?? []), node]);
  }
  const childGroups = new Map<string | null, DiagramSpec["groups"]>();
  for (const group of diagram.groups) {
    const parent = group.parentId && groupIds.has(group.parentId) && group.parentId !== group.id ? group.parentId : null;
    childGroups.set(parent, [...(childGroups.get(parent) ?? []), group]);
  }

  const lines: string[] = [`flowchart ${diagram.direction === "TB" ? "TB" : "LR"}`];
  const renderedGroups = new Set<string>();

  const nodeLine = (node: DiagramSpec["nodes"][number], indent: string) => {
    const [open, close] = SHAPES[node.kind] ?? SHAPES.system;
    return `${indent}${nodeIds.get(node.id)}${open}${escapeLabel(node.label, MAX_LABEL, NODE_KIND_LABELS[node.kind])}${close}`;
  };

  const hasContent = (groupId: string, seen = new Set<string>()): boolean => {
    if (seen.has(groupId)) return false;
    seen.add(groupId);
    if ((nodesByGroup.get(groupId) ?? []).length > 0) return true;
    return (childGroups.get(groupId) ?? []).some((g) => hasContent(g.id, seen));
  };

  const renderGroup = (group: DiagramSpec["groups"][number], depth: number) => {
    if (renderedGroups.has(group.id) || !hasContent(group.id)) return;
    renderedGroups.add(group.id);
    const indent = "  ".repeat(depth);
    const label =
      group.kind === "local_boundary" ? [group.label.trim(), "🔒 reste local"].filter(Boolean).join(" · ") : group.label;
    // An unnamed zone still frames its nodes, with a blank title.
    lines.push(`${indent}subgraph ${groupIds.get(group.id)}["${escapeLabel(label, 60, " ")}"]`);
    for (const node of nodesByGroup.get(group.id) ?? []) lines.push(nodeLine(node, `${indent}  `));
    for (const child of childGroups.get(group.id) ?? []) renderGroup(child, depth + 1);
    lines.push(`${indent}end`);
  };

  for (const group of childGroups.get(null) ?? []) renderGroup(group, 1);
  // Groups caught in a parent cycle are never reached from the roots; draw them at top level.
  for (const group of diagram.groups) renderGroup(group, 1);
  for (const node of nodesByGroup.get(null) ?? []) lines.push(nodeLine(node, "  "));

  for (const edge of diagram.edges) {
    const from = refOf(edge.from);
    const to = refOf(edge.to);
    if (!from || !to || from === to) continue;
    const arrow = edge.style === "dashed" ? "-.->" : edge.style === "thick" ? "==>" : "-->";
    const label = edge.label?.trim() ? `|"${escapeLabel(edge.label, 28)}"|` : "";
    lines.push(`  ${from} ${arrow}${label} ${to}`);
  }

  for (const [kind, style] of Object.entries(KIND_STYLES)) lines.push(`  classDef k_${kind} ${styleOf(style)}`);
  for (const [status, style] of Object.entries(STATUS_STYLES)) lines.push(`  classDef s_${status} ${style}`);
  lines.push(`  classDef g_zone ${GROUP_STYLES.zone}`, `  classDef g_local ${GROUP_STYLES.local_boundary}`);

  const byClass = new Map<string, string[]>();
  const addClass = (cls: string, id: string | undefined) => {
    if (id) byClass.set(cls, [...(byClass.get(cls) ?? []), id]);
  };
  for (const node of diagram.nodes) addClass(`k_${node.kind}`, nodeIds.get(node.id));
  for (const node of diagram.nodes) if (STATUS_STYLES[node.status]) addClass(`s_${node.status}`, nodeIds.get(node.id));
  for (const group of diagram.groups) {
    if (renderedGroups.has(group.id)) addClass(group.kind === "local_boundary" ? "g_local" : "g_zone", groupIds.get(group.id));
  }
  for (const [cls, ids] of byClass) lines.push(`  class ${ids.join(",")} ${cls}`);

  return lines.join("\n");
}
