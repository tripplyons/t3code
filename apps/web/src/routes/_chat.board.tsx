import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { isListedThreadLineage, isLiveSubagentShell } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { SlidersHorizontalIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { useSnoozeWakeClock } from "../components/Sidebar.logic";
import { ThreadGraph } from "../components/ThreadGraph";
import {
  buildThreadGraph,
  DEFAULT_GRAPH_FORCES,
  GRAPH_FORCE_FIELDS,
  type GraphForceId,
} from "../components/ThreadGraph.logic";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { SidebarInset } from "../components/ui/sidebar";
import { isElectron } from "../env";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useVisibleThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useThreadGraphStore } from "../threadGraphStore";

const FORCE_LABEL: Record<GraphForceId, string> = {
  linkDistance: msg("Link distance", { $context: "thread graph layout setting" }),
  repulsion: msg("Repulsion", { $context: "thread graph layout setting" }),
  projectPull: msg("Project grouping", { $context: "thread graph layout setting" }),
  centerPull: msg("Center pull", { $context: "thread graph layout setting" }),
};

function GraphSettings() {
  const gt = useGT();
  const m = useMessages();
  const forces = useThreadGraphStore((state) => state.forces);
  const setForce = useThreadGraphStore((state) => state.setForce);
  const resetForces = useThreadGraphStore((state) => state.resetForces);
  const isDefault = GRAPH_FORCE_FIELDS.every(
    (field) => forces[field.id] === DEFAULT_GRAPH_FORCES[field.id],
  );
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="icon-sm" variant="ghost" aria-label={gt("Graph settings")} />}
      >
        <SlidersHorizontalIcon />
      </PopoverTrigger>
      <PopoverPopup align="end" width="sm">
        <div className="flex flex-col gap-3">
          {GRAPH_FORCE_FIELDS.map((field) => {
            const value = forces[field.id];
            const ratio = (value - field.min) / (field.max - field.min);
            const id = `graph-force-${field.id}`;
            return (
              <div key={field.id} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor={id} className="font-medium text-foreground">
                    {m(FORCE_LABEL[field.id])}
                  </label>
                  <output htmlFor={id} className="font-mono text-muted-foreground tabular-nums">
                    {value.toFixed(2)}
                  </output>
                </div>
                <input
                  id={id}
                  type="range"
                  className="settings-slider w-full"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={value}
                  onChange={(event) => setForce(field.id, Number(event.currentTarget.value))}
                  style={
                    {
                      "--settings-slider-progress": `${ratio * 100}%`,
                      "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
                    } as CSSProperties
                  }
                />
              </div>
            );
          })}
          <Button size="xs" variant="outline" disabled={isDefault} onClick={resetForces}>
            <T>Reset layout</T>
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function ThreadGraphPage() {
  const gt = useGT();
  const threads = useVisibleThreadShells();
  const projects = useProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const forces = useThreadGraphStore((state) => state.forces);
  const [projectKey, setProjectKey] = useState("");
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const now = new Date(useSnoozeWakeClock(threads)).toISOString();
  const nodes = buildThreadGraph(
    threads.filter((thread) => thread.archivedAt === null),
    (thread) =>
      isListedThreadLineage(thread.lineage)
        ? thread.settledOverride !== "settled" &&
          !effectiveSnoozed(thread, { now }) &&
          // A thread nobody has sent a message to yet has nothing to show.
          (thread.latestRun !== null || thread.itemCount > 0) &&
          (projectKey === "" || `${thread.environmentId}:${thread.projectId}` === projectKey)
        : isLiveSubagentShell(thread.source),
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <h1 className="shrink-0 text-sm font-medium">
          <T>Graph</T>
        </h1>
        <div className="[-webkit-app-region:no-drag] ml-auto flex min-w-0 items-center gap-2">
          <GraphSettings />
          <div className="w-44 min-w-0 sm:w-64">
            <Select value={projectKey} onValueChange={(value) => setProjectKey(value ?? "")}>
              <SelectTrigger aria-label={gt("Filter graph by project")} className="w-full">
                <SelectValue>
                  {projectByKey.get(projectKey)?.title ?? gt("All projects")}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">
                  <T>All projects</T>
                </SelectItem>
                {projects.map((project) => (
                  <SelectItem
                    key={`${project.environmentId}:${project.id}`}
                    value={`${project.environmentId}:${project.id}`}
                  >
                    {project.title} ·{" "}
                    {environmentById.get(project.environmentId)?.label ?? project.environmentId}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
      </WorkspacePageHeader>
      {nodes.length === 0 ? (
        <p role="status" className="p-4 text-sm text-muted-foreground sm:p-6">
          {bootstrapped ? gt("No active threads found.") : gt("Loading threads…")}
        </p>
      ) : (
        <ThreadGraph nodes={nodes} projectByKey={projectByKey} forces={forces} />
      )}
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/board")({ component: ThreadGraphPage });
