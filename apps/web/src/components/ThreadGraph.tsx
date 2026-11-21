import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { isListedThreadLineage } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import type { SidebarThreadSummary } from "../types";
import { useUiStateStore } from "../uiStateStore";
import { ProjectFavicon } from "./ProjectFavicon";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "./Sidebar.logic";
import { FOLDER_DOT_CLASS_NAME, FOLDER_DOT_LABEL } from "./sidebar/SidebarProjectFolderHeader";
import { ThreadHoverCard, ThreadHoverCardPopup } from "./ThreadHoverCard";
import {
  createGraphSimulation,
  graphBounds,
  GRAPH_NODE_SIZE,
  GRAPH_UNIT,
  tickGraphSimulation,
  type GraphForces,
  type GraphSimulation,
  type ThreadGraphNode,
} from "./ThreadGraph.logic";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger } from "./ui/tooltip";

type GraphNode = ThreadGraphNode<SidebarThreadSummary>;

interface GraphView {
  x: number;
  y: number;
  scale: number;
}

const MIN_SCALE = 0.15;
const MAX_SCALE = 2;
// Below this zoom a card shows only its title, in larger type, so an overview stays legible.
const FAR_SCALE = 0.6;
const EDGE_WIDTH = 1.5;
const FIT_MARGIN = 32;
const DRAG_THRESHOLD = 4;
// More new threads than this at once are laid out before paint instead of animated in.
const BATCH_SIZE = 8;

// Outlives the route, so opening a thread and coming back returns to the same layout and view.
const memory: {
  simulation: GraphSimulation | null;
  /** Where each thread last sat, so one that leaves the graph and returns keeps its place. */
  positions: Map<string, { x: number; y: number }>;
  signature: string;
  forces: GraphForces | null;
  view: GraphView | null;
  /** Until the user pans or zooms, the view keeps the whole graph in frame. */
  autoFit: boolean;
} = {
  simulation: null,
  positions: new Map(),
  signature: "",
  forces: null,
  view: null,
  autoFit: true,
};

/** The start of the thread's latest agent or thinking message. */
function latestPreviewText(thread: SidebarThreadSummary) {
  return thread.source.recentActivityPreviews?.find((preview) => preview.kind !== "tool")?.text;
}

const ThreadGraphCard = memo(function ThreadGraphCard(props: {
  node: GraphNode;
  project: EnvironmentProject | undefined;
  register: (key: string, element: HTMLElement | null) => void;
  onOpen: (thread: SidebarThreadSummary) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { node, project } = props;
  const thread = node.thread;
  const localLastVisitedAt = useUiStateStore(
    (state) =>
      state.threadLastVisitedAtById[
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
      ],
  );
  const status = resolveSidebarFolderDot([
    {
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
    },
  ]);
  // A subagent is rarely opened, so every finished one would read as unread.
  const dot = status === "unread" && !isListedThreadLineage(thread.lineage) ? null : status;
  const preview = latestPreviewText(thread);
  const root = node.kind === "thread";
  const settled = thread.settledOverride === "settled";
  const size = GRAPH_NODE_SIZE[node.kind];
  const projectTitle = project?.title ?? gt("Unknown project");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            ref={(element) => props.register(node.key, element)}
            data-graph-node={node.key}
            style={{ width: size.width, height: size.height }}
            onClick={() => props.onOpen(thread)}
            // The canvas colour behind the text hides the edges that pass under a card.
            className="absolute top-0 left-0 flex cursor-pointer flex-col items-center justify-center rounded-lg bg-background px-2 text-center outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <span className="flex max-w-full items-center justify-center gap-1.5">
          {dot ? (
            <span
              aria-hidden
              className={cn("size-1.5 shrink-0 rounded-full", FOLDER_DOT_CLASS_NAME[dot])}
            />
          ) : null}
          <span
            className={cn(
              "min-w-0 truncate group-data-[zoom=far]/graph:line-clamp-2 group-data-[zoom=far]/graph:whitespace-normal",
              root
                ? "text-sm group-data-[zoom=far]/graph:text-base group-data-[zoom=far]/graph:leading-5"
                : "text-xs group-data-[zoom=far]/graph:text-sm group-data-[zoom=far]/graph:leading-4.5",
              settled ? "text-muted-foreground" : "font-medium text-foreground",
            )}
          >
            {thread.title}
          </span>
          {dot ? <span className="sr-only">{m(FOLDER_DOT_LABEL[dot])}</span> : null}
        </span>
        {preview ? (
          <span
            className={cn(
              "line-clamp-2 max-w-full leading-4 wrap-break-word text-muted-foreground group-data-[zoom=far]/graph:hidden",
              root ? "text-xs" : "text-2xs",
            )}
          >
            {preview}
          </span>
        ) : null}
      </TooltipTrigger>
      <ThreadHoverCardPopup side="top" sideOffset={6}>
        <ThreadHoverCard title={thread.title}>
          <div className="flex min-w-0 items-center gap-2">
            {project ? <ProjectFavicon project={project} className="size-3 shrink-0" /> : null}
            <div className="min-w-0 truncate text-foreground/75">{projectTitle}</div>
          </div>
          {preview ? <div className="wrap-break-word">{preview}</div> : null}
        </ThreadHoverCard>
      </ThreadHoverCardPopup>
    </Tooltip>
  );
});

/**
 * Every thread as a card in a force-directed graph: subagents branch out from their parent
 * and threads of one project settle near each other. Drag pans, the wheel zooms, and a click
 * opens the thread.
 */
export function ThreadGraph(props: {
  nodes: readonly GraphNode[];
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  forces: GraphForces;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const viewportRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const edgesRef = useRef<SVGPathElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const frame = useRef(0);
  const drag = useRef<{ x: number; y: number; panning: boolean } | null>(null);
  const suppressClick = useRef(false);

  const register = (key: string, element: HTMLElement | null) => {
    if (element) elements.current.set(key, element);
    else elements.current.delete(key);
  };

  const paint = () => {
    const simulation = memory.simulation;
    if (!simulation) return;
    let edges = "";
    for (const node of simulation.nodes) {
      const x = node.x * GRAPH_UNIT.x;
      const y = node.y * GRAPH_UNIT.y;
      const size = GRAPH_NODE_SIZE[node.kind];
      const element = elements.current.get(node.key);
      if (element)
        element.style.transform = `translate(${x - size.width / 2}px,${y - size.height / 2}px)`;
      const parent = simulation.nodes[node.parent];
      if (parent)
        edges += `M${x.toFixed(1)} ${y.toFixed(1)}L${(parent.x * GRAPH_UNIT.x).toFixed(1)} ${(parent.y * GRAPH_UNIT.y).toFixed(1)}`;
    }
    edgesRef.current?.setAttribute("d", edges);
  };

  const applyView = (view: GraphView) => {
    memory.view = view;
    const pan = panRef.current;
    const layer = layerRef.current;
    if (!pan || !layer) return;
    pan.style.transform = `translate(${Math.round(view.x)}px,${Math.round(view.y)}px)`;
    // CSS zoom lays the cards out again at the new size, so text renders crisp at every
    // scale. A transform scale would stretch a rasterized bitmap instead.
    layer.style.zoom = String(view.scale);
    // Zoom is not a transform, so non-scaling-stroke cannot hold the edge width.
    edgesRef.current?.setAttribute("stroke-width", String(EDGE_WIDTH / view.scale));
    layer.dataset.zoom = view.scale < FAR_SCALE ? "far" : "near";
  };

  const fitView = () => {
    const viewport = viewportRef.current;
    if (!viewport || !memory.simulation) return;
    const bounds = graphBounds(memory.simulation);
    const { width, height } = viewport.getBoundingClientRect();
    const scale = Math.min(
      1,
      Math.max(
        MIN_SCALE,
        Math.min(
          (width - FIT_MARGIN * 2) / Math.max(bounds.width, 1),
          (height - FIT_MARGIN * 2) / Math.max(bounds.height, 1),
        ),
      ),
    );
    applyView({
      x: width / 2 - (bounds.x + bounds.width / 2) * scale,
      y: height / 2 - (bounds.y + bounds.height / 2) * scale,
      scale,
    });
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const viewport = viewportRef.current;
    const view = memory.view;
    if (!viewport || !view) return;
    const rect = viewport.getBoundingClientRect();
    memory.autoFit = false;
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    applyView({
      x: px - ((px - view.x) / view.scale) * scale,
      y: py - ((py - view.y) / view.scale) * scale,
      scale,
    });
  };

  const zoomCentered = (factor: number) => {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (rect) zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  };

  const painted = useRef(false);
  const layout = useEffectEvent((nodes: readonly GraphNode[], forces: GraphForces) => {
    const signature = nodes
      .map((node) => `${node.key}>${node.parentKey ?? ""}@${node.projectKey}`)
      .join("|");
    const structureChanged = signature !== memory.signature;
    const forcesChanged = memory.forces !== forces;
    const first = memory.simulation === null;
    // A rebuilt simulation starts hot; it takes over the heat of the one it replaces instead.
    const heatBefore = memory.simulation?.alpha ?? 0;
    let added = 0;
    if (structureChanged) {
      for (const node of memory.simulation?.nodes ?? []) memory.positions.set(node.key, node);
      for (const node of nodes) if (!memory.positions.has(node.key)) added += 1;
      memory.simulation = createGraphSimulation(nodes, memory.positions);
      memory.signature = signature;
    }
    memory.forces = forces;
    const simulation = memory.simulation;
    if (!simulation) return;
    // Streaming re-renders the cards without moving them.
    if (painted.current && !structureChanged && !forcesChanged) return;
    painted.current = true;
    // A first layout or a batch of new threads (a family of subagents arriving) settles before
    // paint, so the graph never flies in from a tangle. Smaller changes animate into place.
    const settleNow = first || added > BATCH_SIZE;
    if (!first) {
      // Threads that leave or return to known places only need overlaps parted, not a new layout.
      const heat =
        forcesChanged || settleNow ? 0.5 : added > 0 ? 0.3 : structureChanged ? 0.004 : 0;
      simulation.alpha = Math.max(heatBefore, heat);
    }
    if (settleNow) while (tickGraphSimulation(simulation, forces));
    paint();
    if (memory.view === null || memory.autoFit) fitView();
    else applyView(memory.view);
    cancelAnimationFrame(frame.current);
    const step = () => {
      // Two steps a frame settle in about a second and a half; the loop ends with the layout.
      const moving =
        tickGraphSimulation(simulation, forces) && tickGraphSimulation(simulation, forces);
      paint();
      if (memory.autoFit) fitView();
      if (moving) frame.current = requestAnimationFrame(step);
    };
    if (!settleNow) frame.current = requestAnimationFrame(step);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The layout lives outside React: card positions are written to the DOM as the simulation steps.
  useLayoutEffect(() => layout(props.nodes, props.forces), [props.nodes, props.forces]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A layout still settling stops with the view.
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onWheel = useEffectEvent((event: WheelEvent) => {
    event.preventDefault();
    // A pinch arrives as a ctrl wheel with small deltas.
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002)));
  });
  const onResize = useEffectEvent(() => {
    if (memory.autoFit) fitView();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- React's onWheel is passive; zooming must cancel the page's own scroll and pinch zoom. The fit follows the pane's size.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const stopObserving = observeResize(viewport, onResize);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      stopObserving();
      viewport.removeEventListener("wheel", onWheel);
    };
  }, []);

  const openThread = (thread: SidebarThreadSummary) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });

  return (
    <div
      ref={viewportRef}
      role="group"
      aria-label={gt("Thread graph")}
      data-workspace-area="board"
      data-workspace-order={0.5}
      tabIndex={-1}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden bg-background outline-none select-none active:cursor-grabbing"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        drag.current = { x: event.clientX, y: event.clientY, panning: false };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        const view = memory.view;
        if (!state || !view) return;
        if (!state.panning) {
          if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD) return;
          state.panning = true;
          memory.autoFit = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }
        applyView({
          ...view,
          x: view.x + event.clientX - state.x,
          y: view.y + event.clientY - state.y,
        });
        state.x = event.clientX;
        state.y = event.clientY;
      }}
      onPointerUp={() => {
        suppressClick.current = drag.current?.panning === true;
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onClickCapture={(event) => {
        // The click that ends a pan must not open the card under the pointer.
        if (!suppressClick.current) return;
        suppressClick.current = false;
        event.stopPropagation();
        event.preventDefault();
      }}
      onScroll={(event) => {
        // Focusing an off-screen card scrolls the clipped viewport; turn that into a pan.
        const viewport = event.currentTarget;
        const view = memory.view;
        if (!view || (viewport.scrollLeft === 0 && viewport.scrollTop === 0)) return;
        applyView({ ...view, x: view.x - viewport.scrollLeft, y: view.y - viewport.scrollTop });
        viewport.scrollTo(0, 0);
      }}
    >
      <div ref={panRef} className="absolute top-0 left-0 size-0">
        <div ref={layerRef} className="group/graph absolute top-0 left-0 size-0">
          <svg
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 size-px overflow-visible"
          >
            <path ref={edgesRef} fill="none" className="stroke-muted-foreground/40" />
          </svg>
          {props.nodes.map((node) => (
            <ThreadGraphCard
              key={node.key}
              node={node}
              project={props.projectByKey.get(node.projectKey)}
              register={register}
              onOpen={openThread}
            />
          ))}
        </div>
      </div>
      <div
        className="absolute right-3 bottom-3 flex cursor-default gap-1"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={gt("Zoom out")}
          onClick={() => zoomCentered(1 / 1.3)}
        >
          <MinusIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={gt("Zoom in")}
          onClick={() => zoomCentered(1.3)}
        >
          <PlusIcon />
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={gt("Fit graph to view")}
          onClick={() => {
            memory.autoFit = true;
            fitView();
          }}
        >
          <MaximizeIcon />
        </Button>
      </div>
    </div>
  );
}
