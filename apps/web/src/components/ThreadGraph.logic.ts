import { isListedThreadLineage } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";

type GraphThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "id" | "projectId" | "lineage" | "delegatedFrom"
>;

export type ThreadGraphNodeKind = "thread" | "subagent";

export interface ThreadGraphNode<T> {
  readonly key: string;
  readonly kind: ThreadGraphNodeKind;
  /** The parent thread this one branches from, when that thread is in the graph. */
  readonly parentKey: string | null;
  /** The root thread's project, which the whole tree clusters with. */
  readonly projectKey: string;
  readonly thread: T;
}

const graphThreadKey = (thread: Pick<GraphThread, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

function graphParentKey(thread: GraphThread): string | null {
  if (thread.delegatedFrom)
    return `${thread.delegatedFrom.environmentId}:${thread.delegatedFrom.threadId}`;
  const parentId = thread.lineage.parentThreadId;
  return parentId === null ? null : `${thread.environmentId}:${parentId}`;
}

/**
 * Every thread `shows` accepts as a node under its parent thread, when that parent is in the
 * graph. Depth-first by project, so a parent always precedes its children. A subagent or side chat
 * needs its parent in the graph, and stays without `shows` while one below it is shown, so a
 * nested chain never breaks.
 */
export function buildThreadGraph<T extends GraphThread>(
  threads: readonly T[],
  shows: (thread: T) => boolean = () => true,
): ThreadGraphNode<T>[] {
  const byKey = new Map(threads.map((thread) => [graphThreadKey(thread), thread]));
  const childrenByParent = new Map<string, T[]>();
  const rootsByProject = new Map<string, T[]>();
  const push = (map: Map<string, T[]>, key: string, thread: T) => {
    const list = map.get(key);
    if (list) list.push(thread);
    else map.set(key, [thread]);
  };
  for (const thread of threads) {
    const parentKey = graphParentKey(thread);
    if (parentKey !== null && parentKey !== graphThreadKey(thread) && byKey.has(parentKey))
      push(childrenByParent, parentKey, thread);
    else push(rootsByProject, `${thread.environmentId}:${thread.projectId}`, thread);
  }
  const kept = new Map<string, boolean>();
  const keeps = (thread: T): boolean => {
    const key = graphThreadKey(thread);
    const known = kept.get(key);
    if (known !== undefined) return known;
    // Set before descending, so a lineage cycle ends here.
    kept.set(key, false);
    const keep =
      shows(thread) ||
      (childrenByParent.get(key) ?? []).some(
        (child) => !isListedThreadLineage(child.lineage) && keeps(child),
      );
    kept.set(key, keep);
    return keep;
  };
  const nodes: ThreadGraphNode<T>[] = [];
  // A node is emitted once, so a lineage cycle cannot loop; its threads are left out.
  const visit = (
    siblings: readonly T[],
    parent: { readonly key: string; readonly shown: boolean } | null,
    projectKey: string,
  ) => {
    for (const thread of siblings) {
      const key = graphThreadKey(thread);
      const shown = isListedThreadLineage(thread.lineage)
        ? shows(thread)
        : (parent === null || parent.shown) && keeps(thread);
      if (shown) {
        const parentKey = parent?.shown ? parent.key : null;
        nodes.push({
          key,
          kind: parentKey === null ? "thread" : "subagent",
          parentKey,
          projectKey,
          thread,
        });
      }
      visit(childrenByParent.get(key) ?? [], { key, shown }, projectKey);
    }
  };
  for (const [projectKey, roots] of rootsByProject) visit(roots, null, projectKey);
  return nodes;
}

/**
 * Plain text for a card preview. The server cuts previews at a character limit, so markers can
 * be unclosed. Emphasis markers inside words, such as snake_case, stay.
 */
export function plainPreviewText(markdown: string): string {
  return markdown
    .replace(/^\s*```.*$/gm, "")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)?/g, "$1")
    .replace(/`+/g, "")
    .replace(/~~/g, "")
    .replace(/(?<![\p{L}\p{N}])[*_]+(?=\S)|(?<=\S)[*_]+(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Node boxes in pixels. The layout keeps them from overlapping, so cards render at these sizes. */
export const GRAPH_NODE_SIZE = {
  thread: { width: 184, height: 76 },
  subagent: { width: 152, height: 72 },
} as const satisfies Record<ThreadGraphNodeKind, { width: number; height: number }>;

/**
 * Pixels per layout unit. Forces are isotropic in layout units, so the wider x scale spreads
 * the graph to the shape of a landscape viewport and of the cards themselves.
 */
export const GRAPH_UNIT = { x: 110, y: 85 } as const;
const NODE_GAP = { x: 8, y: 6 } as const;

export const GRAPH_FORCE_FIELDS = [
  { id: "linkDistance", min: 0.5, max: 3, step: 0.1 },
  { id: "repulsion", min: 0, max: 1.5, step: 0.05 },
  { id: "projectPull", min: 0, max: 1, step: 0.05 },
  { id: "centerPull", min: 0, max: 0.5, step: 0.01 },
] as const;

export type GraphForceId = (typeof GRAPH_FORCE_FIELDS)[number]["id"];
export type GraphForces = Readonly<Record<GraphForceId, number>>;

export const DEFAULT_GRAPH_FORCES: GraphForces = {
  linkDistance: 1,
  repulsion: 0.2,
  projectPull: 0.5,
  centerPull: 0.2,
};

const LINK_STRENGTH = 0.8;
const CHARGE: Record<ThreadGraphNodeKind, number> = { thread: 1, subagent: 0.5 };
const SAME_PROJECT_REPULSION = 0.3;
const REPULSION_RANGE = 8;
const VELOCITY_KEEP = 0.6;
const ALPHA_DECAY = 0.03;
const ALPHA_MIN = 0.003;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

interface SimNode {
  readonly key: string;
  readonly kind: ThreadGraphNodeKind;
  /** Index of the parent node, or -1 for a root thread. */
  readonly parent: number;
  /** Index of the root thread's project. */
  readonly project: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphSimulation {
  readonly nodes: SimNode[];
  readonly projectCount: number;
  alpha: number;
}

/**
 * Lays nodes out in layout units. A node keeps its `previous` position; a new one starts on
 * a spiral around its parent or its project, so the same graph always settles the same way.
 */
export function createGraphSimulation(
  graph: readonly Pick<ThreadGraphNode<unknown>, "key" | "kind" | "parentKey" | "projectKey">[],
  previous: ReadonlyMap<string, { x: number; y: number }> = new Map(),
): GraphSimulation {
  const indexByKey = new Map(graph.map((node, index) => [node.key, index]));
  const projectIndex = new Map<string, number>();
  const nodes: SimNode[] = [];
  const childrenPlaced: number[] = [];
  const rootsPlaced: number[] = [];
  for (const node of graph) {
    const parent = node.parentKey === null ? -1 : (indexByKey.get(node.parentKey) ?? -1);
    let project = projectIndex.get(node.projectKey);
    if (project === undefined) projectIndex.set(node.projectKey, (project = projectIndex.size));
    const size = GRAPH_NODE_SIZE[node.kind];
    const at = previous.get(node.key);
    let x = at?.x ?? 0;
    let y = at?.y ?? 0;
    const origin = nodes[parent];
    const turn = origin ? (childrenPlaced[parent] ?? 0) : (rootsPlaced[project] ?? 0);
    if (!at) {
      // Projects start apart on one spiral and their threads on a smaller one around each.
      const projectRadius = 3 * Math.sqrt(project);
      const originX = origin?.x ?? projectRadius * Math.cos(project * GOLDEN_ANGLE);
      const originY = origin?.y ?? projectRadius * Math.sin(project * GOLDEN_ANGLE);
      const radius = (origin ? 0.8 : 0) + 0.4 * Math.sqrt(turn);
      const angle = turn * GOLDEN_ANGLE + parent;
      x = originX + radius * Math.cos(angle);
      y = originY + radius * Math.sin(angle);
    }
    if (origin) childrenPlaced[parent] = turn + 1;
    else rootsPlaced[project] = turn + 1;
    nodes.push({
      key: node.key,
      kind: node.kind,
      parent,
      project,
      halfWidth: (size.width / 2 + NODE_GAP.x) / GRAPH_UNIT.x,
      halfHeight: (size.height / 2 + NODE_GAP.y) / GRAPH_UNIT.y,
      degree: 0,
      x,
      y,
      vx: 0,
      vy: 0,
    });
  }
  for (const node of nodes) {
    const parent = nodes[node.parent];
    if (!parent) continue;
    node.degree += 1;
    parent.degree += 1;
  }
  return { nodes, projectCount: projectIndex.size, alpha: 1 };
}

/** Parts overlapping cards. Returns whether any pair still overlapped. */
function separate(nodes: readonly SimNode[]): boolean {
  let overlapped = false;
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i]!;
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j]!;
      const dx = b.x - a.x;
      const reachX = a.halfWidth + b.halfWidth;
      const overlapX = reachX - Math.abs(dx);
      if (overlapX <= 0) continue;
      const dy = b.y - a.y;
      const reachY = a.halfHeight + b.halfHeight;
      const overlapY = reachY - Math.abs(dy);
      if (overlapY <= 0) continue;
      overlapped = true;
      // Part the pair along the axis it overlaps least on, relative to the cards' size, so
      // wide cards spread sideways as readily as they stack.
      if (overlapX / reachX < overlapY / reachY) {
        const shift = (dx < 0 ? -overlapX : overlapX) / 2;
        a.x -= shift;
        b.x += shift;
      } else {
        const shift = (dy < 0 || (dy === 0 && i % 2 === 0) ? -overlapY : overlapY) / 2;
        a.y -= shift;
        b.y += shift;
      }
    }
  }
  return overlapped;
}

/** Advances the layout one step. Returns false once it has settled. */
export function tickGraphSimulation(simulation: GraphSimulation, forces: GraphForces): boolean {
  const { nodes } = simulation;
  if (simulation.alpha < ALPHA_MIN) return false;
  const alpha = simulation.alpha;
  simulation.alpha -= alpha * ALPHA_DECAY;

  for (const node of nodes) {
    const parent = nodes[node.parent];
    if (!parent) continue;
    const dx = node.x + node.vx - parent.x - parent.vx || 1e-6;
    const dy = node.y + node.vy - parent.y - parent.vy;
    const distance = Math.hypot(dx, dy);
    const pull = ((distance - forces.linkDistance) / distance) * alpha * LINK_STRENGTH;
    // The end with more links moves less, so a parent holds still while its children gather.
    const parentShare = node.degree / (node.degree + parent.degree);
    node.vx -= dx * pull * (1 - parentShare);
    node.vy -= dy * pull * (1 - parentShare);
    parent.vx += dx * pull * parentShare;
    parent.vy += dy * pull * parentShare;
  }

  // Root threads gather at their project's center; their subagents follow through the links.
  const projectPull = forces.projectPull * alpha;
  if (projectPull > 0) {
    const sumX = new Float64Array(simulation.projectCount);
    const sumY = new Float64Array(simulation.projectCount);
    const count = new Uint32Array(simulation.projectCount);
    for (const node of nodes) {
      if (node.parent !== -1) continue;
      sumX[node.project]! += node.x;
      sumY[node.project]! += node.y;
      count[node.project]! += 1;
    }
    for (const node of nodes) {
      if (node.parent !== -1) continue;
      node.vx += (sumX[node.project]! / count[node.project]! - node.x) * projectPull;
      node.vy += (sumY[node.project]! / count[node.project]! - node.y) * projectPull;
    }
  }

  const repulsion = forces.repulsion * alpha;
  if (repulsion > 0) {
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]!;
        const dx = b.x - a.x || 1e-6;
        const dy = b.y - a.y;
        const squared = dx * dx + dy * dy;
        if (squared > REPULSION_RANGE * REPULSION_RANGE) continue;
        // Threads of one project push apart less, so each project packs into its own cluster.
        const push =
          (repulsion * (a.project === b.project ? SAME_PROJECT_REPULSION : 1)) /
          Math.max(squared, 0.25);
        a.vx -= dx * push * CHARGE[b.kind];
        a.vy -= dy * push * CHARGE[b.kind];
        b.vx += dx * push * CHARGE[a.kind];
        b.vy += dy * push * CHARGE[a.kind];
      }
    }
  }

  const center = forces.centerPull * alpha;
  for (const node of nodes) {
    node.vx = (node.vx - node.x * center) * VELOCITY_KEEP;
    node.vy = (node.vy - node.y * center) * VELOCITY_KEEP;
    node.x += node.vx;
    node.y += node.vy;
  }
  separate(nodes);
  separate(nodes);
  if (simulation.alpha >= ALPHA_MIN) return true;
  // Forces have faded out; finish parting any cards still touching.
  for (let pass = 0; pass < 200 && separate(nodes); pass += 1);
  return false;
}

/** The layout's bounding box in pixels, cards included. */
export function graphBounds(simulation: GraphSimulation) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of simulation.nodes) {
    const size = GRAPH_NODE_SIZE[node.kind];
    minX = Math.min(minX, node.x * GRAPH_UNIT.x - size.width / 2);
    maxX = Math.max(maxX, node.x * GRAPH_UNIT.x + size.width / 2);
    minY = Math.min(minY, node.y * GRAPH_UNIT.y - size.height / 2);
    maxY = Math.max(maxY, node.y * GRAPH_UNIT.y + size.height / 2);
  }
  return simulation.nodes.length === 0
    ? { x: 0, y: 0, width: 0, height: 0 }
    : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
