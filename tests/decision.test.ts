import { describe, expect, it } from "vitest";
import { pivotsToMermaid } from "@/lib/diagram/pivots";
import {
  BUBBLE_RADIUS,
  layoutBubbles,
  pilotReading,
  plotFrame,
  priorityToMermaid,
  quadrantOf,
  spreadOffsets,
  type Box,
} from "@/lib/diagram/priority";
import type { Initiative, OptionsAnalysis } from "@/lib/schemas/options";
import { fixture } from "./helpers";

const initiative = (name: string, value: number, feasibility: number, verdict: Initiative["verdict"] = "next") =>
  ({ name, value, feasibility, risk: 2, timeToValue: 3, reuse: 3, verdict, comment: "" }) as Initiative;

const overlap = (a: Box, b: Box) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

describe("value × feasibility matrix", () => {
  it("puts scores above 3 in the top-right quick wins and leaves the 3s on the fence", () => {
    expect(quadrantOf({ value: 4, feasibility: 5 })).toBe("quickWin");
    expect(quadrantOf({ value: 5, feasibility: 2 })).toBe("structural");
    expect(quadrantOf({ value: 2, feasibility: 4 })).toBe("bonus");
    expect(quadrantOf({ value: 1, feasibility: 1 })).toBe("deprioritize");
    expect(quadrantOf({ value: 3, feasibility: 5 })).toBeNull();
  });

  it("spreads initiatives that share the same scores", () => {
    const offsets = spreadOffsets(
      [
        { value: 4, feasibility: 4 },
        { value: 4, feasibility: 4 },
        { value: 2, feasibility: 1 },
      ],
      20,
    );
    expect(Math.hypot(offsets[0].dx - offsets[1].dx, offsets[0].dy - offsets[1].dy)).toBeCloseTo(20);
    expect(offsets[2]).toEqual({ dx: 0, dy: 0 });
  });

  it.each(
    ["data-platform", "genai-assurance", "cloud-industriel"].flatMap((caseId) =>
      [
        [403, 250],
        [460, 285],
        [620, 380],
      ].map(([width, height]) => ({ caseId, width, height })),
    ),
  )("keeps labels and quadrant names inside the plot, off the bubbles and off each other ($caseId, $width×$height)", ({ caseId, width, height }) => {
    const frame = plotFrame(width, height);
    const { bubbles, quadrants } = layoutBubbles(fixture("options", caseId).initiatives, frame);
    const circles = bubbles.map((b) => ({
      x0: b.cx - BUBBLE_RADIUS,
      y0: b.cy - BUBBLE_RADIUS,
      x1: b.cx + BUBBLE_RADIUS,
      y1: b.cy + BUBBLE_RADIUS,
    }));
    const texts = [...bubbles.map((b) => ({ name: b.label.text, box: b.label.box })), ...Object.values(quadrants).map((q) => ({ name: q.text, box: q.box }))];
    for (const { name, box } of texts) {
      expect(box.x0, name).toBeGreaterThanOrEqual(frame.left);
      expect(box.x1, name).toBeLessThanOrEqual(frame.right);
      expect(box.y0, name).toBeGreaterThanOrEqual(frame.top);
      expect(box.y1, name).toBeLessThanOrEqual(frame.bottom);
    }
    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        expect(overlap(texts[i].box, texts[j].box), `${texts[i].name} / ${texts[j].name}`).toBe(false);
      }
    }
    for (const q of Object.values(quadrants)) {
      expect(circles.some((c) => overlap(q.box, c)), q.text).toBe(false);
    }
  });

  it("does not stack twin bubbles", () => {
    const { bubbles } = layoutBubbles([initiative("A", 4, 4), initiative("B", 4, 4)], plotFrame(400, 260));
    expect(Math.hypot(bubbles[0].cx - bubbles[1].cx, bubbles[0].cy - bubbles[1].cy)).toBeGreaterThan(2 * BUBBLE_RADIUS);
  });

  it("reads where the pilot sits and which quick wins could follow", () => {
    const reading = pilotReading([initiative("Pilote", 5, 2, "pilot"), initiative("Rapide", 4, 4), initiative("Lent", 2, 2)]);
    expect(reading.pilot).toEqual({ name: "Pilote", quadrant: "structural" });
    expect(reading.otherQuickWins).toEqual(["Rapide"]);
    expect(pilotReading([initiative("Seul", 4, 4)]).pilot).toBeNull();
  });

  it("exports a Mermaid quadrant chart with 0-1 coordinates and quoted names", () => {
    const code = priorityToMermaid([initiative('Le "pilote"', 5, 5, "pilot"), initiative("Bas", 1, 1)]);
    expect(code).toMatch(/^quadrantChart\n/);
    expect(code).toContain(`"Le 'pilote' (pilote)": [0.90, 0.90]`);
    expect(code).toContain(`"Bas": [0.10, 0.10]`);
    expect(code).not.toMatch(/\[1\.00|0\.\d+\.\d/);
  });
});

describe("pivots tree", () => {
  const options = fixture("options");
  const analysis = (pivots: OptionsAnalysis["recommendation"]["pivots"]) => ({
    options: options.options,
    recommendation: { ...options.recommendation, optionId: "O3", pivots },
  });
  const pivot = (question: string, thenOptionId: string | null) => ({
    basis: "Q2",
    question,
    assumed: "Oui",
    ifInstead: "Non",
    thenOptionId,
    consequence: "Gouvernance à renforcer",
  });

  it("draws nothing without pivots", () => {
    expect(pivotsToMermaid(analysis([]))).toBeNull();
  });

  it("splits each point into today's answer, leading to the recommendation, and the other one, leading elsewhere", () => {
    const code = pivotsToMermaid(analysis([pivot("A ?", "O1"), pivot("B ?", "O1"), pivot("C ?", null)]))!;
    expect(code).toContain('reco(["★ O3 · ');
    expect(code).toContain('p1("Q2 · A ?")');
    expect(code).toContain('p1a["Oui"]');
    expect(code).toContain('p1b["Non"]');
    expect(code).toContain("p1a ==> reco");
    // Two points leading to O1 share one O1 node; the third keeps the recommendation, adapted.
    expect(code.match(/^\s+o\d\[/gm)).toHaveLength(1);
    expect(code).toContain("p2b -.-> o1");
    expect(code).toContain('x3["O3 adaptée"]');
    expect(code).toContain("p3b -.-> x3");
    expect(code).toContain("linkStyle 0,2,4,6,8,10 stroke:#4f46e5");
  });
});
