import { z } from "zod";
import { listOf } from "./common";
import { DiagramSpecSchema } from "./diagram";

export const TargetStateSchema = z.object({
  principles: listOf(z.string(), "3-5 target principles (architecture, governance, operating model), one line each"),
  diagram: DiagramSpecSchema,
  keyChanges: listOf(
    z.object({ from: z.string().describe("Today, 2-6 words"), to: z.string().describe("Target, 2-6 words") }),
    "3-5 shifts from the current state to the target",
  ),
  operatingModel: listOf(
    z.string(),
    "2-4 non-technical changes: ownership, governance bodies, roles, skills, adoption",
  ),
});

export type TargetState = z.infer<typeof TargetStateSchema>;
