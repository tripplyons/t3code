import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { resolveSidebarThreadStatus, sortThreadsForSidebar } from "./Sidebar.logic";

export const THREAD_BOARD_COLUMNS = [
  { id: "needs-you", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "ready", label: "Ready" },
  { id: "idle", label: "Idle" },
] as const;

type BoardColumn = (typeof THREAD_BOARD_COLUMNS)[number]["id"];

export function resolveThreadBoardColumn(
  thread: SidebarThreadSummary,
  options: { now: string; snoozeSupported: boolean },
): BoardColumn | null {
  if (options.snoozeSupported && effectiveSnoozed(thread, options)) return null;
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval" || status === "input" || status === "failed") return "needs-you";
  if (status === "working" || status === "monitoring") return "working";
  if (thread.latestTurn?.state === "completed" || thread.hasActionableProposedPlan) return "ready";
  return "idle";
}

export function buildThreadBoard(
  threads: readonly SidebarThreadSummary[],
  options: {
    now: string;
    projectKey: string;
    serverConfigs: ReadonlyMap<
      EnvironmentId,
      {
        environment: {
          capabilities: Pick<
            ServerConfig["environment"]["capabilities"],
            "threadSettlement" | "threadSnooze"
          >;
        };
      }
    >;
  },
) {
  const groups: Record<BoardColumn, SidebarThreadSummary[]> = {
    "needs-you": [],
    working: [],
    ready: [],
    idle: [],
  };
  const visibleThreads = threads.filter((thread) => {
    if (thread.archivedAt !== null) return false;
    if (options.projectKey && `${thread.environmentId}:${thread.projectId}` !== options.projectKey)
      return false;
    const capabilities = options.serverConfigs.get(thread.environmentId)?.environment.capabilities;
    return capabilities?.threadSettlement !== true || thread.settledOverride !== "settled";
  });
  for (const thread of sortThreadsForSidebar(visibleThreads)) {
    const capabilities = options.serverConfigs.get(thread.environmentId)?.environment.capabilities;
    const column = resolveThreadBoardColumn(thread, {
      now: options.now,
      snoozeSupported: capabilities?.threadSnooze === true,
    });
    if (column !== null) groups[column].push(thread);
  }
  return THREAD_BOARD_COLUMNS.map((column) => ({ ...column, threads: groups[column.id] }));
}
