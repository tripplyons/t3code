import { resolveThreadBoardGroup } from "@t3tools/client-runtime/state/thread-sort";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { filterSidebarV2VisibleThreads, sortThreadsForSidebar } from "./Sidebar.logic";

const THREAD_BOARD_SECTIONS = [
  { id: "inbox", label: "Inbox" },
  { id: "working", label: "Working" },
  { id: "idle", label: "Idle" },
] as const;

export type BoardSection = (typeof THREAD_BOARD_SECTIONS)[number]["id"];

/**
 * Blocked and failed threads come first in the inbox, then finished work waiting for
 * review. Finished work counts as inbox only where settling can clear it.
 */
export function resolveThreadBoardSection(
  thread: SidebarThreadSummary,
  options: { now: string; snoozeSupported: boolean; settlementSupported: boolean },
): BoardSection | null {
  if (options.snoozeSupported && effectiveSnoozed(thread, options)) return null;
  const group = resolveThreadBoardGroup(thread);
  if (group === "needs-you") return "inbox";
  if (group === "idle" && options.settlementSupported) return "inbox";
  return group;
}

export function threadBoardStatus(thread: SidebarThreadSummary) {
  if (thread.hasPendingApprovals) return "Needs approval";
  if (thread.hasPendingUserInput) return "Has a question";
  if (thread.pendingSubagentRequest != null) return "Subagent needs you";
  if (thread.runtime?.status === "failed") return "Failed";
  if (resolveThreadBoardGroup(thread) === "working") return "Working";
  if (thread.hasActionableProposedPlan) return "Plan ready";
  return "Finished";
}

export function buildThreadBoard(
  threads: readonly SidebarThreadSummary[],
  options: {
    now: string;
    projectKey: string;
    delegatedUnderParent?: ReadonlySet<string>;
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
  const groups: Record<BoardSection, SidebarThreadSummary[]> = {
    inbox: [],
    working: [],
    idle: [],
  };
  const visibleThreads = filterSidebarV2VisibleThreads(
    threads,
    options.projectKey ? new Set([options.projectKey]) : null,
    options.delegatedUnderParent ?? new Set(),
  ).filter((thread) => {
    const capabilities = options.serverConfigs.get(thread.environmentId)?.environment.capabilities;
    return capabilities?.threadSettlement !== true || thread.settledOverride !== "settled";
  });
  // The sidebar order already puts blocked threads ahead of finished ones.
  for (const thread of sortThreadsForSidebar(visibleThreads)) {
    const capabilities = options.serverConfigs.get(thread.environmentId)?.environment.capabilities;
    const section = resolveThreadBoardSection(thread, {
      now: options.now,
      snoozeSupported: capabilities?.threadSnooze === true,
      settlementSupported: capabilities?.threadSettlement === true,
    });
    if (section !== null) groups[section].push(thread);
  }
  return THREAD_BOARD_SECTIONS.map((section) => ({ ...section, threads: groups[section.id] }));
}

/**
 * The row to focus: the remembered thread while it is still listed, otherwise the
 * row that took its place, so acting on a row moves on to the next one.
 */
export function resolveBoardSelection<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  selection: { key: string; index: number } | null,
): T | null {
  if (rows.length === 0) return null;
  if (selection === null) return rows[0]!;
  return (
    rows.find((row) => keyOf(row) === selection.key) ??
    rows[Math.min(selection.index, rows.length - 1)]!
  );
}
