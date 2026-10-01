import type { Initiative, Verdict } from "@/lib/schemas/options";

export const QUADRANTS = ["quickWin", "structural", "bonus", "deprioritize"] as const;
export type Quadrant = (typeof QUADRANTS)[number];

export const QUADRANT_LABELS: Record<Quadrant, string> = {
  quickWin: "Quick wins",
  structural: "Chantiers structurants",
  bonus: "Gains d'appoint",
  deprioritize: "À déprioriser",
};

/** Fallback names when a narrow plot leaves no free corner for the full one. */
const QUADRANT_SHORT_LABELS: Record<Quadrant, string> = {
  quickWin: "Quick wins",
  structural: "Structurants",
  bonus: "D'appoint",
  deprioritize: "Déprioriser",
};

type Point = Pick<Initiative, "name" | "value" | "feasibility">;

/** Scores run from 1 to 5, so 3 is the fence: an initiative scored 3 on either axis sits on a line, in no quadrant. */
export function quadrantOf(point: Pick<Initiative, "value" | "feasibility">): Quadrant | null {
  if (point.value === 3 || point.feasibility === 3) return null;
  if (point.value > 3) return point.feasibility > 3 ? "quickWin" : "structural";
  return point.feasibility > 3 ? "bonus" : "deprioritize";
}

/** Initiatives sharing the same scores are spread around their common spot instead of hiding each other. */
export function spreadOffsets(points: Pick<Point, "value" | "feasibility">[], distance: number): { dx: number; dy: number }[] {
  const cells = new Map<string, number[]>();
  points.forEach((p, i) => {
    const key = `${p.value}:${p.feasibility}`;
    cells.set(key, [...(cells.get(key) ?? []), i]);
  });
  const offsets = points.map(() => ({ dx: 0, dy: 0 }));
  for (const members of cells.values()) {
    if (members.length < 2) continue;
    // Neighbours on the circle must stay `distance` apart: the chord 2·d·sin(π/n) ≥ distance.
    const radius = distance / (2 * Math.sin(Math.PI / members.length));
    members.forEach((index, k) => {
      const angle = Math.PI + (2 * Math.PI * k) / members.length;
      offsets[index] = { dx: radius * Math.cos(angle), dy: radius * Math.sin(angle) };
    });
  }
  return offsets;
}

// ── Plot geometry (pixels) ───────────────────────────────────────────────────

export type PlotFrame = { width: number; height: number; left: number; right: number; top: number; bottom: number };

export function plotFrame(width: number, height: number): PlotFrame {
  return { width, height, left: 40, right: width - 12, top: 12, bottom: height - 38 };
}

/** Scores 1-5 are drawn on a 0.5-5.5 domain so the extreme bubbles keep some air. */
export const scoreToX = (frame: PlotFrame, score: number) => frame.left + ((score - 0.5) / 5) * (frame.right - frame.left);
export const scoreToY = (frame: PlotFrame, score: number) => frame.bottom - ((score - 0.5) / 5) * (frame.bottom - frame.top);

export type LabelAnchor = "start" | "middle" | "end";
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type BubbleLayout = {
  index: number;
  cx: number;
  cy: number;
  label: { x: number; y: number; anchor: LabelAnchor; text: string; box: Box };
};

export const BUBBLE_RADIUS = 9;
const FONT_SIZE = 11;
const CHAR_WIDTH = 6.1;
/** Longer names fit when the plot is wide; a narrow zone keeps them short. */
export const maxLabelChars = (frame: PlotFrame) => Math.round(Math.min(44, Math.max(20, (frame.right - frame.left) / 16)));
const GAP = 5;

export function shortLabel(name: string, max: number): string {
  const text = name.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const area = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

function candidates(cx: number, cy: number, width: number) {
  const r = BUBBLE_RADIUS + GAP;
  const h = FONT_SIZE + 3;
  const baseline = (top: number) => top + FONT_SIZE - 1;
  const box = (x0: number, y0: number): Box => ({ x0, y0, x1: x0 + width, y1: y0 + h });
  return [
    { x: cx + r, y: baseline(cy - h / 2), anchor: "start" as const, box: box(cx + r, cy - h / 2) },
    { x: cx - r, y: baseline(cy - h / 2), anchor: "end" as const, box: box(cx - r - width, cy - h / 2) },
    { x: cx, y: baseline(cy - r - h + 2), anchor: "middle" as const, box: box(cx - width / 2, cy - r - h + 2) },
    { x: cx, y: baseline(cy + r - 2), anchor: "middle" as const, box: box(cx - width / 2, cy + r - 2) },
    { x: cx + r - 4, y: baseline(cy - r - h + 4), anchor: "start" as const, box: box(cx + r - 4, cy - r - h + 4) },
    { x: cx + r - 4, y: baseline(cy + r - 4), anchor: "start" as const, box: box(cx + r - 4, cy + r - 4) },
    { x: cx - r + 4, y: baseline(cy - r - h + 4), anchor: "end" as const, box: box(cx - r + 4 - width, cy - r - h + 4) },
    { x: cx - r + 4, y: baseline(cy + r - 4), anchor: "end" as const, box: box(cx - r + 4 - width, cy + r - 4) },
  ];
}

export type QuadrantName = { x: number; y: number; anchor: LabelAnchor; text: string; box: Box };

const QUADRANT_CHAR_WIDTH = 6.4;

/**
 * Each quadrant's name goes in the first of its corners that no bubble covers, starting with the plot's own
 * corner: a crowded top row pushes the name down to the midline instead of under a bubble.
 */
function placeQuadrantNames(frame: PlotFrame, bubbles: Box[]): Record<Quadrant, QuadrantName> {
  const xMid = scoreToX(frame, 3);
  const yMid = scoreToY(frame, 3);
  const rects: Record<Quadrant, Box> = {
    quickWin: { x0: xMid, y0: frame.top, x1: frame.right, y1: yMid },
    structural: { x0: frame.left, y0: frame.top, x1: xMid, y1: yMid },
    bonus: { x0: xMid, y0: yMid, x1: frame.right, y1: frame.bottom },
    deprioritize: { x0: frame.left, y0: yMid, x1: xMid, y1: frame.bottom },
  };
  const entries = QUADRANTS.map((quadrant) => {
    const q = rects[quadrant];
    const outerRight = quadrant === "quickWin" || quadrant === "bonus";
    const outerTop = quadrant === "quickWin" || quadrant === "structural";
    const corner = (label: string, right: boolean, top: boolean): QuadrantName => {
      const text = label.toUpperCase();
      const w = text.length * QUADRANT_CHAR_WIDTH;
      const x = right ? q.x1 - 6 : q.x0 + 6;
      const y = top ? q.y0 + 12 : q.y1 - 5;
      return {
        x,
        y,
        anchor: right ? "end" : "start",
        text,
        box: { x0: right ? x - w : x, y0: y - 9, x1: right ? x : x + w, y1: y + 2 },
      };
    };
    const options = [QUADRANT_LABELS[quadrant], QUADRANT_SHORT_LABELS[quadrant]].flatMap((label) => [
      corner(label, outerRight, outerTop),
      corner(label, !outerRight, outerTop),
      corner(label, outerRight, !outerTop),
      corner(label, !outerRight, !outerTop),
    ]);
    const clash = (name: QuadrantName) =>
      bubbles.reduce((sum, b) => sum + area(name.box, { x0: b.x0 - 2, y0: b.y0 - 2, x1: b.x1 + 2, y1: b.y1 + 2 }), 0);
    const best = options.find((name) => clash(name) === 0) ?? options.reduce((a, b) => (clash(b) < clash(a) ? b : a));
    return [quadrant, best] as const;
  });
  return Object.fromEntries(entries) as Record<Quadrant, QuadrantName>;
}

/**
 * Places every bubble and the quadrant names, then each bubble's label where it collides least with the
 * frame, the bubbles, the quadrant names and the labels already placed. The pilot is labelled first so it
 * gets the best spot.
 */
export function layoutBubbles(
  points: (Point & { verdict?: Verdict })[],
  frame: PlotFrame,
): { bubbles: BubbleLayout[]; quadrants: Record<Quadrant, QuadrantName> } {
  const offsets = spreadOffsets(points, 2 * BUBBLE_RADIUS + 3);
  const centers = points.map((p, i) => ({
    cx: scoreToX(frame, p.feasibility) + offsets[i].dx,
    cy: scoreToY(frame, p.value) + offsets[i].dy,
  }));
  const bubbleBoxes = centers.map(({ cx, cy }) => ({
    x0: cx - BUBBLE_RADIUS,
    y0: cy - BUBBLE_RADIUS,
    x1: cx + BUBBLE_RADIUS,
    y1: cy + BUBBLE_RADIUS,
  }));
  const quadrants = placeQuadrantNames(frame, bubbleBoxes);
  const order = points.map((_, i) => i).sort((a, b) => Number(points[b].verdict === "pilot") - Number(points[a].verdict === "pilot"));

  const placed: Box[] = Object.values(quadrants).map((q) => q.box);
  const labels = new Map<number, BubbleLayout["label"]>();
  for (const index of order) {
    const text = shortLabel(points[index].name, maxLabelChars(frame));
    const { cx, cy } = centers[index];
    let best: (ReturnType<typeof candidates>[number] & { cost: number }) | null = null;
    for (const candidate of candidates(cx, cy, text.length * CHAR_WIDTH)) {
      const b = candidate.box;
      const outside =
        Math.max(0, frame.left - b.x0) + Math.max(0, b.x1 - frame.right) + Math.max(0, frame.top - b.y0) + Math.max(0, b.y1 - frame.bottom);
      const cost =
        outside * 40 +
        placed.reduce((sum, other) => sum + area(b, other), 0) * 4 +
        bubbleBoxes.reduce((sum, other, j) => sum + (j === index ? 0 : area(b, other)), 0) * 2;
      if (!best || cost < best.cost) best = { ...candidate, cost };
      if (cost === 0) break;
    }
    placed.push(best!.box);
    labels.set(index, { x: best!.x, y: best!.y, anchor: best!.anchor, text, box: best!.box });
  }

  return {
    bubbles: points.map((_, index) => ({ index, ...centers[index], label: labels.get(index)! })),
    quadrants,
  };
}

/** Where the pilot sits, and which other quick wins could follow it. */
export function pilotReading(points: (Point & { verdict: Verdict })[]) {
  const pilot = points.find((p) => p.verdict === "pilot") ?? null;
  return {
    pilot: pilot ? { name: pilot.name, quadrant: quadrantOf(pilot) } : null,
    otherQuickWins: points.filter((p) => p !== pilot && quadrantOf(p) === "quickWin").map((p) => p.name),
  };
}

// ── Mermaid export ───────────────────────────────────────────────────────────

const quoted = (text: string) => `"${text.replace(/"/g, "'").replace(/\s+/g, " ").trim()}"`;
/** Mermaid's quadrant lexer only reads coordinates written as 1, 0 or 0.xx, so 0.996 must not be written 1.00. */
const coordinate = (value: number) => {
  const text = value.toFixed(2);
  return value >= 1 || text === "1.00" ? "1" : value <= 0 ? "0" : text;
};

export function priorityToMermaid(initiatives: (Point & { verdict: Verdict })[]): string {
  const offsets = spreadOffsets(initiatives, 0.05);
  const lines = [
    "quadrantChart",
    "  title Valeur × faisabilité",
    `  x-axis ${quoted("Difficile")} --> ${quoted("Facile")}`,
    `  y-axis ${quoted("Valeur faible")} --> ${quoted("Valeur forte")}`,
    `  quadrant-1 ${quoted(QUADRANT_LABELS.quickWin)}`,
    `  quadrant-2 ${quoted(QUADRANT_LABELS.structural)}`,
    `  quadrant-3 ${quoted(QUADRANT_LABELS.deprioritize)}`,
    `  quadrant-4 ${quoted(QUADRANT_LABELS.bonus)}`,
  ];
  initiatives.forEach((initiative, i) => {
    const x = (initiative.feasibility - 0.5) / 5 + offsets[i].dx;
    const y = (initiative.value - 0.5) / 5 - offsets[i].dy;
    // Mermaid rejects an empty point name and the whole chart with it.
    const name = initiative.name.trim() || "Initiative sans nom";
    lines.push(`  ${quoted(initiative.verdict === "pilot" ? `${name} (pilote)` : name)}: [${coordinate(x)}, ${coordinate(y)}]`);
  });
  return lines.join("\n");
}
