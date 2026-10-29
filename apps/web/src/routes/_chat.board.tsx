import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

import { buildBoardPreviewIndex } from "../components/BoardActivityPreviews.logic";
import { BoardFocusCard } from "../components/BoardFocusCard";
import {
  buildThreadBoard,
  resolveBoardSelection,
  threadBoardStatus,
  type BoardSection,
} from "../components/threadBoard";
import { useBoardShortcuts } from "../components/useBoardShortcuts";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Kbd } from "../components/ui/kbd";
import { SidebarInset } from "../components/ui/sidebar";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { isElectron } from "../env";
import { undoLatestThreadAction } from "../hooks/showThreadUndoNotice";
import { cn } from "../lib/utils";
import {
  useAllEnvironmentShellsBootstrapped,
  useDelegatedUnderParent,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useThreadJumpHintStore } from "../threadJumpHintStore";
import type { SidebarThreadSummary } from "../types";

const rowKey = (thread: SidebarThreadSummary) => `${thread.environmentId}:${thread.id}`;

function latestPreviewText(thread: SidebarThreadSummary) {
  return [...buildBoardPreviewIndex(thread.source.recentActivityPreviews).values()].at(-1)?.text;
}

function ThreadBoard() {
  const threads = useThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const { environments } = useEnvironments();
  const [projectKey, setProjectKey] = useState("");
  const [wakeTime, setWakeTime] = useState(Date.now);
  const [openSections, setOpenSections] = useState<ReadonlySet<BoardSection>>(
    () => new Set(["inbox", "working", "idle"]),
  );
  const [selection, setSelection] = useState<{ key: string; index: number } | null>(null);
  const now = new Date(wakeTime).toISOString();
  const sections = buildThreadBoard(threads, {
    projectKey,
    delegatedUnderParent,
    serverConfigs,
    now,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the wake timer so snoozed cards return at their deadline without continuous polling.
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
  // The sidebar owns the jump order and the shortcuts; rows only mirror its hints.
  const jumpLabelByKey = useThreadJumpHintStore((state) => state.visibleLabelByKey);
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
  );
  const environmentById = new Map(
    environments.map((environment) => [environment.environmentId, environment]),
  );
  const rows = sections.flatMap((section) => (openSections.has(section.id) ? section.threads : []));
  const selected = resolveBoardSelection(rows, rowKey, selection);
  const selectedCapabilities = selected
    ? serverConfigs.get(selected.environmentId)?.environment.capabilities
    : undefined;

  const select = (thread: SidebarThreadSummary) => {
    const key = rowKey(thread);
    const section = sections.find((candidate) => candidate.threads.includes(thread));
    let visibleRows = rows;
    if (section && !openSections.has(section.id)) {
      const nextOpen = new Set(openSections).add(section.id);
      visibleRows = sections.flatMap((candidate) =>
        nextOpen.has(candidate.id) ? candidate.threads : [],
      );
      // Commit the expanded section now so its row exists to scroll to.
      flushSync(() => setOpenSections(nextOpen));
    }
    setSelection({ key, index: visibleRows.findIndex((row) => rowKey(row) === key) });
    document.querySelector(`[data-board-row="${CSS.escape(key)}"]`)?.scrollIntoView({
      block: "nearest",
    });
  };
  useBoardShortcuts((key, event) => {
    if (key === "z") {
      if (!undoLatestThreadAction()) return;
    } else if (key === "j" || key === "arrowdown" || key === "k" || key === "arrowup") {
      const step = key === "j" || key === "arrowdown" ? 1 : -1;
      const allRows = sections.flatMap((section) => section.threads);
      const index = selected ? allRows.indexOf(selected) : -1;
      const next = allRows[Math.min(Math.max(index + step, 0), allRows.length - 1)];
      if (!next) return;
      select(next);
    } else return;
    event.preventDefault();
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
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
      <div
        data-board-root
        className="grid min-h-0 flex-1 grid-cols-1 overflow-auto bg-background lg:grid-cols-[minmax(18rem,26rem)_1fr] lg:overflow-hidden"
      >
        <nav
          aria-label="Board threads"
          className="min-h-0 border-b p-3 lg:overflow-auto lg:border-r lg:border-b-0"
        >
          {!bootstrapped && (
            <p role="status" className="mb-3 px-2 text-sm text-muted-foreground">
              Loading threads…
            </p>
          )}
          {sections.map((section) => {
            const open = openSections.has(section.id);
            return (
              <section key={section.id} aria-labelledby={`board-${section.id}`} className="mb-3">
                <h2 id={`board-${section.id}`}>
                  <button
                    type="button"
                    aria-expanded={open}
                    className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
                    onClick={() =>
                      setOpenSections((current) => {
                        const next = new Set(current);
                        if (open) next.delete(section.id);
                        else next.add(section.id);
                        return next;
                      })
                    }
                  >
                    <ChevronRightIcon
                      aria-hidden
                      className={cn("size-3.5 shrink-0", open && "rotate-90")}
                    />
                    {section.label}
                    <span className="ml-auto tabular-nums">{section.threads.length}</span>
                  </button>
                </h2>
                {open && section.threads.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    {section.id === "inbox" ? "Nothing needs you." : "No threads"}
                  </p>
                ) : null}
                {open ? (
                  <ul className="mt-1 space-y-1">
                    {section.threads.map((thread) => {
                      const key = rowKey(thread);
                      const project = projectByKey.get(
                        `${thread.environmentId}:${thread.projectId}`,
                      );
                      const jumpLabel = jumpLabelByKey.get(key);
                      const preview = latestPreviewText(thread);
                      const isSelected = selected !== null && rowKey(selected) === key;
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            data-board-row={key}
                            aria-current={isSelected ? "true" : undefined}
                            onClick={() => select(thread)}
                            className={cn(
                              "relative block w-full rounded-lg border border-transparent px-3 py-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              isSelected && "border-border bg-accent",
                            )}
                          >
                            {jumpLabel && (
                              <span
                                aria-hidden
                                className="pointer-events-none absolute right-2 top-2 inline-flex h-5 items-center rounded-full border border-border/80 bg-background/95 px-1.5 font-mono text-3xs font-medium tracking-tight text-foreground shadow-sm"
                              >
                                {jumpLabel}
                              </span>
                            )}
                            <div className="truncate pr-8 text-sm font-medium">{thread.title}</div>
                            {preview ? (
                              <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
                                {preview}
                              </p>
                            ) : null}
                            <div className="mt-1 truncate text-xs text-muted-foreground">
                              {threadBoardStatus(thread)} · {project?.title ?? "Unknown project"}
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            );
          })}
          <p className="mt-4 px-2 text-xs text-muted-foreground">
            <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>R</Kbd> reply · <Kbd>Z</Kbd> undo
          </p>
        </nav>
        <div className="min-h-0 p-4 sm:p-6 lg:overflow-auto">
          {selected ? (
            <BoardFocusCard
              key={rowKey(selected)}
              thread={selected}
              project={projectByKey.get(`${selected.environmentId}:${selected.projectId}`)}
              environmentLabel={
                environmentById.get(selected.environmentId)?.label ?? selected.environmentId
              }
              settlementSupported={selectedCapabilities?.threadSettlement === true}
              snoozable={
                selectedCapabilities?.threadSnooze === true && canSnooze(selected, { now })
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {bootstrapped ? "Nothing needs you." : null}
            </p>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/board")({ component: ThreadBoard });
