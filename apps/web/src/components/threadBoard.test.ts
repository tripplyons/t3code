import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { SidebarThreadSummary } from "../types";
import { sortThreadsForSidebar } from "./Sidebar.logic";
import { buildThreadBoard, resolveThreadBoardColumn } from "./threadBoard";

const now = "2026-09-19T12:00:00.000Z";
const environmentId = EnvironmentId.make("local");
const options = { now, snoozeSupported: true };
function thread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    source: OrchestrationV2ThreadShell.make({
      createdBy: "user",
      creationSource: "web",
      id: ThreadId.make("thread"),
      projectId: ProjectId.make("project"),
      title: "Task",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: {
        parentThreadId: null,
        rootThreadId: ThreadId.make("thread"),
        relationshipToParent: null,
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      pendingBackgroundTasks: [],
      providerInstanceHistory: [],
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: DateTime.makeUnsafe(now),
      updatedAt: DateTime.makeUnsafe(now),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    }),
    id: ThreadId.make("thread"),
    environmentId,
    projectId: ProjectId.make("project"),
    title: "Task",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestRun: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    runtime: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    lineage: {
      parentThreadId: null,
      rootThreadId: ThreadId.make("thread"),
      relationshipToParent: null,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    providerInstanceHistory: [],
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}
function runtime(
  status: NonNullable<SidebarThreadSummary["runtime"]>["status"],
): NonNullable<SidebarThreadSummary["runtime"]> {
  return {
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "Codex",
    lastError: null,
    updatedAt: now,
  };
}
const completed = {
  runId: RunId.make("turn"),
  status: "completed" as const,
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  assistantMessageId: null,
};
const snoozed = { snoozedAt: "2026-09-19T10:00:00.000Z", snoozedUntil: "2026-09-19T13:00:00.000Z" };
const capabilities = {
  environment: { capabilities: { threadSettlement: true, threadSnooze: true } },
};

describe("thread board", () => {
  it("automatically sorts the sidebar in board order as threads change status", () => {
    const rows = [
      thread({ id: ThreadId.make("idle"), createdAt: "2026-09-20T12:00:00.000Z" }),
      thread({ id: ThreadId.make("working"), runtime: runtime("running") }),
      thread({ id: ThreadId.make("monitoring"), runtime: runtime("idle") }),
      thread({ id: ThreadId.make("input"), hasPendingUserInput: true, activeOrderKey: "z" }),
      thread({ id: ThreadId.make("approval"), hasPendingApprovals: true, activeOrderKey: "b" }),
      thread({
        id: ThreadId.make("error"),
        runtime: {
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "failed",
          providerName: "Codex",
          activeRunId: null,
          lastError: "Failed",
          updatedAt: now,
        },
      }),
    ];
    const boardIds = (threads: SidebarThreadSummary[]) =>
      buildThreadBoard(threads, { now, projectKey: "", serverConfigs: new Map() }).flatMap(
        (column) => column.threads.map((item) => item.id),
      );
    const sorted = sortThreadsForSidebar(rows).map((item) => item.id);
    expect(sorted).toEqual(["error", "approval", "input", "monitoring", "working", "idle"]);
    expect(sorted).toEqual(boardIds(rows));

    const updated = rows.map((row) =>
      row.id === "idle"
        ? { ...row, hasPendingUserInput: true }
        : row.id === "input"
          ? { ...row, hasPendingUserInput: false }
          : row,
    );
    expect(sortThreadsForSidebar(updated).map((item) => item.id)).toEqual([
      "idle",
      "error",
      "approval",
      "monitoring",
      "working",
      "input",
    ]);
    expect(sortThreadsForSidebar(updated).map((item) => item.id)).toEqual(boardIds(updated));
    expect(rows.map((item) => item.id)).toEqual([
      "idle",
      "working",
      "monitoring",
      "input",
      "approval",
      "error",
    ]);
  });

  it("groups completed results and proposed plans with idle threads", () => {
    expect(resolveThreadBoardColumn(thread(), options)).toBe("idle");
    expect(resolveThreadBoardColumn(thread({ latestRun: completed }), options)).toBe("idle");
    expect(resolveThreadBoardColumn(thread({ hasActionableProposedPlan: true }), options)).toBe(
      "idle",
    );
  });
  it.each(["running", "idle"] as const)("keeps live background %s out of Idle", (status) => {
    expect(
      resolveThreadBoardColumn(thread({ latestRun: completed, runtime: runtime(status) }), options),
    ).toBe("working");
  });
  it.each(["starting", "running"] as const)("shows a %s session as Working", (status) => {
    expect(
      resolveThreadBoardColumn(
        thread({
          runtime: {
            providerInstanceId: ProviderInstanceId.make("codex"),
            status,
            providerName: "Codex",
            activeRunId: null,
            lastError: null,
            updatedAt: now,
          },
        }),
        options,
      ),
    ).toBe("working");
  });
  it("prioritizes failures over stale background work", () => {
    expect(
      resolveThreadBoardColumn(
        thread({
          runtime: {
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "failed",
            providerName: "Codex",
            activeRunId: null,
            lastError: "Failed",
            updatedAt: now,
          },
        }),
        options,
      ),
    ).toBe("needs-you");
  });
  it("wakes snoozed threads for questions, approvals, and completed work", () => {
    expect(resolveThreadBoardColumn(thread(snoozed), options)).toBeNull();
    expect(
      resolveThreadBoardColumn(thread({ ...snoozed, hasPendingApprovals: true }), options),
    ).toBe("needs-you");
    expect(
      resolveThreadBoardColumn(thread({ ...snoozed, hasPendingUserInput: true }), options),
    ).toBe("needs-you");
    expect(resolveThreadBoardColumn(thread({ ...snoozed, latestRun: completed }), options)).toBe(
      "idle",
    );
    expect(
      resolveThreadBoardColumn(thread(snoozed), { ...options, now: snoozed.snoozedUntil }),
    ).toBe("idle");
  });
  it("excludes archived, settled, and snoozed threads while retaining pinned work", () => {
    const rows = [
      thread({ id: ThreadId.make("archived"), archivedAt: now }),
      thread({ id: ThreadId.make("settled"), settledOverride: "settled" }),
      thread({ id: ThreadId.make("pinned"), pinnedAt: now }),
      thread({ id: ThreadId.make("snoozed"), ...snoozed }),
    ];
    const board = buildThreadBoard(rows, {
      now,
      projectKey: "",
      serverConfigs: new Map([[environmentId, capabilities]]),
    });
    expect(board.flatMap((column) => column.threads.map((item) => item.id))).toEqual(["pinned"]);
  });
  it("scopes project filtering by environment even when project IDs collide", () => {
    const remote = EnvironmentId.make("remote");
    const board = buildThreadBoard(
      [thread(), thread({ environmentId: remote, id: ThreadId.make("remote-thread") })],
      { now, projectKey: "remote:project", serverConfigs: new Map() },
    );
    expect(board.flatMap((column) => column.threads.map((item) => item.id))).toEqual([
      "remote-thread",
    ]);
  });
  it("matches sidebar compatibility for servers without settlement or snooze", () => {
    const board = buildThreadBoard([thread({ settledOverride: "settled", ...snoozed })], {
      now,
      projectKey: "",
      serverConfigs: new Map(),
    });
    expect(board.find((column) => column.id === "idle")?.threads).toHaveLength(1);
  });
});
