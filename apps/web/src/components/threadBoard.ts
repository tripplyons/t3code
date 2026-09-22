import { resolveThreadBoardGroup } from "@t3tools/client-runtime/state/thread-sort";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { sortThreadsForSidebar } from "./Sidebar.logic";

export const THREAD_BOARD_COLUMNS = [
  { id: "needs-you", label: "Awaiting" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
] as const;

type BoardColumn = (typeof THREAD_BOARD_COLUMNS)[number]["id"];

export function resolveThreadBoardColumn(
  thread: SidebarThreadSummary,
  options: { now: string; snoozeSupported: boolean },
): BoardColumn | null {
  if (options.snoozeSupported && effectiveSnoozed(thread, options)) return null;
  return resolveThreadBoardGroup(thread);
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
