import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadGraph,
  createGraphSimulation,
  DEFAULT_GRAPH_FORCES,
  tickGraphSimulation,
} from "./ThreadGraph.logic";

const environmentId = EnvironmentId.make("env");

function thread(
  id: string,
  options: {
    parent?: string;
    project?: string;
    fork?: boolean;
    delegatedFrom?: { environmentId: string; threadId: string };
  } = {},
) {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make(options.project ?? "project"),
    lineage: {
      parentThreadId: options.parent === undefined ? null : ThreadId.make(options.parent),
      relationshipToParent:
        options.parent === undefined
          ? null
          : options.fork
            ? ("fork" as const)
            : ("subagent" as const),
      rootThreadId: ThreadId.make(id),
    },
    delegatedFrom: options.delegatedFrom
      ? {
          environmentId: EnvironmentId.make(options.delegatedFrom.environmentId),
          threadId: ThreadId.make(options.delegatedFrom.threadId),
          title: "",
        }
      : null,
  };
}

const shape = (nodes: ReturnType<typeof buildThreadGraph>) =>
  nodes.map((node) => [node.key, node.kind, node.parentKey, node.projectKey]);

describe("buildThreadGraph", () => {
  it("nests subagents under their parents, depth-first by project", () => {
    const nodes = buildThreadGraph([
      thread("grandchild", { parent: "child" }),
      thread("other", { project: "second" }),
      thread("child", { parent: "root" }),
      thread("root"),
    ]);
    expect(shape(nodes)).toEqual([
      ["env:other", "thread", null, "env:second"],
      ["env:root", "thread", null, "env:project"],
      ["env:child", "subagent", "env:root", "env:project"],
      ["env:grandchild", "subagent", "env:child", "env:project"],
    ]);
  });

  it("roots a thread whose parent is not listed", () => {
    expect(shape(buildThreadGraph([thread("orphan", { parent: "archived" })]))).toEqual([
      ["env:orphan", "thread", null, "env:project"],
    ]);
  });

  it("places a delegated task under the thread that delegated it, in that thread's project", () => {
    const nodes = buildThreadGraph([
      thread("root"),
      thread("task", {
        project: "elsewhere",
        delegatedFrom: { environmentId: "env", threadId: "root" },
      }),
    ]);
    expect(shape(nodes)[1]).toEqual(["env:task", "subagent", "env:root", "env:project"]);
  });

  it("filters subagents with their parent, forks on their own, and keeps a chain to a shown subagent", () => {
    const hidden = new Set(["hidden", "done", "doneLeaf"]);
    const nodes = buildThreadGraph(
      [
        thread("hidden"),
        thread("child", { parent: "hidden" }),
        thread("fork", { parent: "hidden", fork: true }),
        thread("done", { parent: "fork" }),
        thread("live", { parent: "done" }),
        thread("doneLeaf", { parent: "fork" }),
      ],
      (thread) => !hidden.has(thread.id),
    );
    expect(shape(nodes)).toEqual([
      ["env:fork", "thread", null, "env:project"],
      ["env:done", "subagent", "env:fork", "env:project"],
      ["env:live", "subagent", "env:done", "env:project"],
    ]);
  });
});

describe("graph simulation", () => {
  const graph = buildThreadGraph([
    ...Array.from({ length: 12 }, (_, index) => thread(`a${index}`, { project: "a" })),
    ...Array.from({ length: 12 }, (_, index) => thread(`b${index}`, { project: "b" })),
    ...Array.from({ length: 10 }, (_, index) => thread(`child${index}`, { parent: "a0" })),
  ]);
  const simulation = createGraphSimulation(graph);
  while (tickGraphSimulation(simulation, DEFAULT_GRAPH_FORCES));
  const { nodes } = simulation;
  const distance = (a: (typeof nodes)[number], b: (typeof nodes)[number]) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  it("settles with no two cards overlapping", () => {
    const overlapping = nodes.flatMap((a, index) =>
      nodes
        .slice(index + 1)
        .filter(
          (b) =>
            Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth - 1e-6 &&
            Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight - 1e-6,
        )
        .map((b) => [a.key, b.key]),
    );
    expect(overlapping).toEqual([]);
  });

  it("keeps subagents nearer their parent, and roots nearer their project, than the rest", () => {
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    const parent = nodes.find((node) => node.key === "env:a0")!;
    const roots = nodes.filter((node) => node.parent === -1);
    const children = nodes.filter((node) => node.parent !== -1);
    expect(mean(children.map((node) => distance(node, parent)))).toBeLessThan(
      mean(roots.filter((node) => node !== parent).map((node) => distance(node, parent))),
    );
    const sameProject: number[] = [];
    const otherProject: number[] = [];
    for (const a of roots)
      for (const b of roots)
        if (a !== b) (a.project === b.project ? sameProject : otherProject).push(distance(a, b));
    expect(mean(sameProject)).toBeLessThan(mean(otherProject));
  });

  it("keeps a node's earlier position when the graph is rebuilt", () => {
    const rebuilt = createGraphSimulation(
      graph,
      new Map(nodes.map((node) => [node.key, { x: node.x, y: node.y }])),
    );
    expect(rebuilt.nodes.map((node) => [node.x, node.y])).toEqual(
      nodes.map((node) => [node.x, node.y]),
    );
  });
});
