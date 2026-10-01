import { z } from "zod";
import { listOf } from "./common";

export const NODE_KINDS = [
  "actor",
  "system",
  "data",
  "process",
  "pain_point",
  "constraint",
  "control",
  "output",
] as const;
export const NodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const NODE_STATUSES = ["existing", "new", "changed", "retired", "assumption"] as const;
export const NodeStatusSchema = z.enum(NODE_STATUSES);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const DiagramSpecSchema = z.object({
  direction: z.enum(["LR", "TB"]).describe("LR unless the flow is clearly vertical"),
  groups: listOf(
    z.object({
      id: z.string(),
      label: z.string().describe("2-4 words"),
      kind: z
        .enum(["zone", "local_boundary"])
        .describe("local_boundary = data or systems that cannot leave this perimeter (regulation, sovereignty)"),
      parentId: z.string().nullable().describe("Id of an enclosing group, or null"),
    }),
    "0-6 groups for entities, sites, subsidiaries or zones",
  ),
  nodes: listOf(
    z.object({
      id: z.string(),
      label: z.string().describe("2-5 words"),
      kind: NodeKindSchema.describe(
        "actor = people/teams, system = application/tool, data = data store, process = activity, pain_point = problem, constraint = regulation/limit, control = governance/guardrail/validation, output = report/dashboard/result",
      ),
      groupId: z.string().nullable(),
      status: NodeStatusSchema.describe(
        "existing, new, changed or retired; assumption when it rests on an unconfirmed hypothesis",
      ),
    }),
    "8-16 nodes, whiteboard-simple",
  ),
  edges: listOf(
    z.object({
      from: z.string().describe("Node or group id"),
      to: z.string().describe("Node or group id"),
      label: z.string().nullable().describe("1-3 words or null"),
      style: z
        .enum(["solid", "dashed", "thick"])
        .describe("dashed = manual or uncertain flow, thick = main value flow"),
    }),
    "Main flows only",
  ),
});

export type DiagramSpec = z.infer<typeof DiagramSpecSchema>;

export const CurrentStateSchema = z.object({
  diagram: DiagramSpecSchema,
  bottlenecks: listOf(z.string(), "1-3 bottlenecks, one line each"),
});

export type CurrentState = z.infer<typeof CurrentStateSchema>;
