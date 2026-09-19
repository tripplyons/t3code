import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { buildThreadBoard } from "../components/threadBoard";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SidebarInset } from "../components/ui/sidebar";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { isElectron } from "../env";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";

function ThreadBoard() {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const [projectKey, setProjectKey] = useState("");
  const [wakeTime, setWakeTime] = useState(Date.now);
  const columns = useMemo(() => {
    return buildThreadBoard(threads, {
      projectKey,
      serverConfigs,
      now: new Date(wakeTime).toISOString(),
    });
  }, [threads, projectKey, serverConfigs, wakeTime]);
  // Wake snoozed cards at their deadline without a continuously ticking board.
  useEffect(() => {
    const now = Math.max(wakeTime, Date.now());
    const wakeTimes = threads
      .map((thread) => Date.parse(thread.snoozedUntil ?? ""))
      .filter((time) => time > wakeTime);
    if (wakeTimes.length === 0) return;
    const timer = window.setTimeout(
      () => setWakeTime(Date.now()),
      Math.min(Math.max(0, Math.min(...wakeTimes) - now) + 50, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [threads, wakeTime]);
  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <h1 className="shrink-0 text-sm font-medium">Board</h1>
        <div className="[-webkit-app-region:no-drag] ml-auto min-w-0 w-44 sm:w-64">
          <Select value={projectKey} onValueChange={(value) => setProjectKey(value ?? "")}>
            <SelectTrigger aria-label="Filter board by project" className="w-full">
              <SelectValue>{projectByKey.get(projectKey)?.title ?? "All projects"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">All projects</SelectItem>
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
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-auto bg-background p-4 sm:p-6">
        {!bootstrapped && (
          <p role="status" className="mb-4 text-sm text-muted-foreground">
            Loading threads…
          </p>
        )}
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
          {columns.map((column) => (
            <section key={column.id} aria-labelledby={`board-${column.id}`} className="min-w-0">
              <h2 id={`board-${column.id}`} className="mb-3 text-sm font-medium">
                {column.label}
              </h2>
              <ul className="space-y-2">
                {column.threads.map((thread) => {
                  const status = resolveSidebarThreadStatus(thread);
                  const project = projectByKey.get(`${thread.environmentId}:${thread.projectId}`);
                  const environment = environmentById.get(thread.environmentId);
                  return (
                    <li key={`${thread.environmentId}:${thread.id}`}>
                      <Link
                        to="/$environmentId/$threadId"
                        params={{ environmentId: thread.environmentId, threadId: thread.id }}
                        className="block rounded-lg border bg-background p-3 outline-none hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <div className="break-words text-sm font-medium">{thread.title}</div>
                        {thread.latestActivityPreview?.kind === "agent" && (
                          <div className="mt-2 text-sm text-muted-foreground">
                            <span className="text-xs font-medium">Agent</span>
                            <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words">
                              {thread.latestActivityPreview.text}
                            </p>
                          </div>
                        )}
                        <div className="mt-2 break-words text-xs text-muted-foreground">
                          {project?.title ?? "Unknown project"} ·{" "}
                          {environment?.label ?? thread.environmentId}
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          {status === "approval"
                            ? "Approval needed"
                            : status === "input"
                              ? "Question waiting"
                              : status === "failed"
                                ? "Failed"
                                : status === "monitoring"
                                  ? "Monitoring"
                                  : column.label}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {column.threads.length === 0 && (
                <p className="py-3 text-xs text-muted-foreground">No threads</p>
              )}
            </section>
          ))}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/board")({ component: ThreadBoard });
