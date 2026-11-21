import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { createFileRoute } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { create } from "zustand";

import { boardHomeRow, focusBoardHome } from "../components/boardFocus";
import { BoardFocusCard } from "../components/BoardFocusCard";
import { BoardThreadActions } from "../components/BoardThreadActions";
import {
  buildBoardPreviewIndex,
  buildThreadBoard,
  resolveBoardSelection,
  type BoardSection,
} from "../components/threadBoard";
import { useBoardShortcuts } from "../components/useBoardShortcuts";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { Button } from "../components/ui/button";
import { Kbd } from "../components/ui/kbd";
import { JumpHintBadge } from "../components/sidebar/SidebarThreadRow";
import { SidebarInset } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { useComposerHandleContext } from "../composerHandleContext";
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
import { requestWorkspaceFocus } from "../lib/workspaceFocus";
import {
  useAllEnvironmentShellsBootstrapped,
  useDelegatedUnderParent,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useThreadDetailPrewarm } from "../state/threads";
import { useThreadJumpHintStore } from "../threadJumpHintStore";
import type { SidebarThreadSummary } from "../types";

const rowKey = (thread: SidebarThreadSummary) => `${thread.environmentId}:${thread.id}`;

function latestPreviewText(thread: SidebarThreadSummary) {
  return [...buildBoardPreviewIndex(thread.source.recentActivityPreviews).values()].at(-1)?.text;
}

// Rows after and before the selection whose conversations load ahead of the keyboard.
const PREWARM_AHEAD = 2;
const PREWARM_BEHIND = 1;

function BoardThreadPrewarm({ thread }: { thread: SidebarThreadSummary }) {
  useThreadDetailPrewarm(thread.environmentId, thread.id);
  return null;
}

// Outlives the route, so opening a thread and coming back returns to the same row.
const useBoardSelection = create<{ selection: { key: string; index: number } | null }>(() => ({
  selection: null,
}));

function ThreadBoard() {
  const gt = useGT();
  const m = useMessages();
  const composerHandle = useComposerHandleContext();
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
  const selection = useBoardSelection((state) => state.selection);
  // Keyed by thread so moving to another row starts with its composer hidden again.
  const [composerFocusKey, setComposerFocusKey] = useState<string | null>(null);
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
  const selectedKey = selected ? rowKey(selected) : null;
  // J and K step through every section, collapsed ones included.
  const allRows = sections.flatMap((section) => section.threads);
  const selectedIndex = selected ? allRows.indexOf(selected) : -1;
  const prewarmRows =
    selectedIndex === -1
      ? []
      : allRows
          .slice(Math.max(selectedIndex - PREWARM_BEHIND, 0), selectedIndex + PREWARM_AHEAD + 1)
          .filter((thread) => thread !== selected);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Entering the board from any page puts the keyboard on the list.
  useEffect(() => requestWorkspaceFocus({ area: "board", restore: false }), []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- DOM focus follows a selection that moves without a key press.
  useLayoutEffect(() => {
    // Done, Later, a filter, or a collapsed section replace the selected row. Focus goes with
    // the selection unless the keyboard is in another area or a popup.
    if (selectedKey === null) return;
    const active = document.activeElement;
    if (!active || active === document.body || active.closest("[data-board-root]"))
      focusBoardHome();
  }, [selectedKey]);
  const selectedCapabilities = selected
    ? serverConfigs.get(selected.environmentId)?.environment.capabilities
    : undefined;
  const setReplying = (replying: boolean) => {
    setComposerFocusKey(replying ? selectedKey : null);
    // A reply commits to the row on screen, so the departed row it replaced cannot return and
    // take the selection, and the editor, away.
    if (replying && selected && selectedKey !== null && selection?.key !== selectedKey)
      useBoardSelection.setState({
        selection: { key: selectedKey, index: rows.indexOf(selected) },
      });
  };
  const reply = () => {
    if (selectedKey === null) return;
    flushSync(() => setReplying(true));
    document.querySelector<HTMLElement>("[data-board-composer] [contenteditable='true']")?.focus();
  };
  const dictate = () => {
    if (selectedKey === null) return;
    reply();
    if (composerHandle?.current?.toggleDictation() === false)
      toastManager.add({
        type: "warning",
        title: gt("Dictation isn't available for this thread"),
        description: gt("Check Settings → Voice, or answer what the thread is waiting on first."),
      });
  };

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
    useBoardSelection.setState({
      selection: { key, index: visibleRows.findIndex((row) => rowKey(row) === key) },
    });
    const row = document.querySelector<HTMLElement>(`[data-board-row="${CSS.escape(key)}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  };
  const move = (step: 1 | -1) => {
    const next = allRows[Math.min(Math.max(selectedIndex + step, 0), allRows.length - 1)];
    if (!next) return false;
    select(next);
    return true;
  };
  useBoardShortcuts((key, event) => {
    if (key === "z") {
      if (!undoLatestThreadAction()) return;
    } else if (key === "j" || key === "arrowdown") {
      if (!move(1)) return;
    } else if (key === "k" || key === "arrowup") {
      if (!move(-1)) return;
    } else return;
    event.preventDefault();
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron} className="bg-background">
        <h1 className="shrink-0 text-sm font-medium">
          <T>Board</T>
        </h1>
        <div className="[-webkit-app-region:no-drag] ml-auto min-w-0 w-44 sm:w-64">
          <Select value={projectKey} onValueChange={(value) => setProjectKey(value ?? "")}>
            <SelectTrigger aria-label={gt("Filter board by project")} className="w-full">
              <SelectValue>{projectByKey.get(projectKey)?.title ?? gt("All projects")}</SelectValue>
            </SelectTrigger>
            <SelectPopup finalFocus={() => boardHomeRow() ?? true}>
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
      </WorkspacePageHeader>
      <div
        data-board-root
        className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background lg:grid lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]"
      >
        <nav
          aria-label={gt("Board threads")}
          data-board-nav
          data-workspace-area="board"
          data-workspace-order={0.5}
          tabIndex={-1}
          onMouseDown={(event) => {
            // The list's own controls work like a toolbar: a click on one leaves the keyboard
            // on the selected row, or brings it there from another area.
            if (event.target instanceof Element && event.target.closest("[data-board-row]")) return;
            event.preventDefault();
            if (!document.activeElement?.closest("[data-board-root]")) focusBoardHome();
          }}
          className="flex max-h-[45%] shrink-0 flex-col border-b lg:max-h-none lg:min-h-0 lg:border-r lg:border-b-0"
        >
          {/* The actions sit below the scroller, not over it, so a row scrolled into view is
              never under them. */}
          <div className="min-h-0 overflow-auto px-3 pt-3">
            {!bootstrapped && (
              <p role="status" className="mb-3 px-2 text-sm text-muted-foreground">
                <T>Loading threads…</T>
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
                      {m(section.label)}
                      <span className="ml-auto tabular-nums">{section.threads.length}</span>
                    </button>
                  </h2>
                  {open && section.threads.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">
                      {section.id === "inbox" ? gt("Nothing needs you.") : gt("No threads")}
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
                        const isSelected = selectedKey === key;
                        return (
                          <li key={key}>
                            <button
                              type="button"
                              // A row remounts when its thread changes section; the id lets
                              // workspace focus recovery return focus to it.
                              id={`board-row-${key}`}
                              data-board-row={key}
                              aria-current={isSelected ? "true" : undefined}
                              data-workspace-focus-default={isSelected ? "" : undefined}
                              // One tab stop: a focused row is always the selected row.
                              tabIndex={isSelected ? 0 : -1}
                              onClick={() => select(thread)}
                              className={cn(
                                "block w-full rounded-lg px-3 py-2 text-left outline-none hover:bg-accent/50",
                                // Focus follows the selection, so the highlight already marks it.
                                isSelected
                                  ? "bg-accent light:ring-1 light:ring-inset light:ring-border/70"
                                  : "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                              )}
                            >
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1 truncate text-sm font-medium">
                                  {thread.title}
                                </div>
                                {jumpLabel ? <JumpHintBadge label={jumpLabel} /> : null}
                              </div>
                              {preview ? (
                                <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
                                  {preview}
                                </p>
                              ) : null}
                              <div className="mt-1 truncate text-xs text-muted-foreground">
                                {project?.title ?? gt("Unknown project")}
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
          </div>
          <div className="flex shrink-0 flex-wrap gap-2 border-t border-inherit p-3">
            {selected ? (
              <BoardThreadActions
                key={selectedKey}
                thread={selected}
                settlementSupported={selectedCapabilities?.threadSettlement === true}
                snoozable={
                  selectedCapabilities?.threadSnooze === true && canSnooze(selected, { now })
                }
                onReply={reply}
                onDictate={dictate}
              />
            ) : null}
            <Button size="sm" variant="outline" onClick={() => move(1)}>
              <T>Next</T> <Kbd>J</Kbd>
            </Button>
            <Button size="sm" variant="outline" onClick={() => move(-1)}>
              <T>Previous</T> <Kbd>K</Kbd>
            </Button>
            <Button size="sm" variant="outline" onClick={() => undoLatestThreadAction()}>
              <T>Undo</T> <Kbd>Z</Kbd>
            </Button>
          </div>
        </nav>
        {/* Stacked, the list and the conversation split the height: the timeline holds its own
            wheel scroll, so a page that scrolls past it could never reach the pane's bottom. */}
        <div className="flex min-h-0 flex-1 flex-col">
          {prewarmRows.map((thread) => (
            <BoardThreadPrewarm key={rowKey(thread)} thread={thread} />
          ))}
          {selected ? (
            <BoardFocusCard
              thread={selected}
              composerFocused={composerFocusKey === selectedKey}
              onComposerFocusChange={setReplying}
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground sm:p-6">
              {bootstrapped ? gt("Nothing needs you.") : null}
            </p>
          )}
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/board")({ component: ThreadBoard });
