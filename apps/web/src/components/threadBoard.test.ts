import { describe, expect, it } from "vite-plus/test";
import { threadKey } from "@t3tools/client-runtime/state/entities";
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
import { buildThreadBoard, resolveBoardSelection, resolveThreadBoardSection } from "./threadBoard";

const now = "2026-09-19T12:00:00.000Z";
const environmentId = EnvironmentId.make("local");
const options = { now, snoozeSupported: true, settlementSupported: false };
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
    goal: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    lineage: {
      parentThreadId: null,
      rootThreadId: ThreadId.make("thread"),
      relationshipToParent: null,
    },
    forkedFrom: null,
    linkOrigin: null,
    delegatedFrom: null,
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

  it("groups pending background work with running threads in the board and sidebar", () => {
    const pendingBackgroundTasks = [
      { taskId: "monitor", kind: "monitor" as const, description: "Watch", awaited: true as const },
    ];
    const rows = [
      thread({ id: ThreadId.make("idle"), createdAt: "2026-09-20T12:00:00.000Z" }),
      thread({ id: ThreadId.make("waiting"), pendingBackgroundTasks, latestRun: completed }),
      thread({ id: ThreadId.make("running"), runtime: runtime("running") }),
    ];
    expect(resolveThreadBoardSection(rows[1]!, options)).toBe("working");
    expect(sortThreadsForSidebar(rows).map((row) => row.id)).toEqual([
      "running",
      "waiting",
      "idle",
    ]);
    expect(
      resolveThreadBoardSection(
        thread({ pendingBackgroundTasks, hasPendingUserInput: true }),
        options,
      ),
    ).toBe("inbox");
    expect(
      resolveThreadBoardSection(
        thread({ pendingBackgroundTasks, runtime: runtime("failed") }),
        options,
      ),
    ).toBe("inbox");
  });
  it("hides delegated work only when its parent is available", () => {
    const child = thread({ id: ThreadId.make("delegated") });
    const boardOptions = { now, projectKey: "", serverConfigs: new Map() };
    expect(buildThreadBoard([child], boardOptions).flatMap((column) => column.threads)).toEqual([
      child,
    ]);
    expect(
      buildThreadBoard([child], {
        ...boardOptions,
        delegatedUnderParent: new Set([threadKey({ environmentId, threadId: child.id })]),
      }).flatMap((column) => column.threads),
    ).toEqual([]);
  });

  it("inboxes finished work only where settling can clear it", () => {
    const settling = { ...options, settlementSupported: true };
    for (const overrides of [{}, { latestRun: completed }, { hasActionableProposedPlan: true }]) {
      expect(resolveThreadBoardSection(thread(overrides), options)).toBe("idle");
      expect(resolveThreadBoardSection(thread(overrides), settling)).toBe("inbox");
    }
    const board = buildThreadBoard(
      [
        thread({ id: ThreadId.make("done"), latestRun: completed }),
        thread({ id: ThreadId.make("working"), runtime: runtime("running") }),
        thread({ id: ThreadId.make("question"), hasPendingUserInput: true }),
      ],
      { now, projectKey: "", serverConfigs: new Map([[environmentId, capabilities]]) },
    );
    expect(board.map((section) => [section.id, section.threads.map((item) => item.id)])).toEqual([
      ["inbox", ["question", "done"]],
      ["working", ["working"]],
      ["idle", []],
    ]);
  });
  it("moves the selection to the row that replaced a handled one", () => {
    const keyOf = (row: string) => row;
    expect(resolveBoardSelection([], keyOf, { key: "a", index: 0 })).toBeNull();
    expect(resolveBoardSelection(["a", "b"], keyOf, null)).toBe("a");
    expect(resolveBoardSelection(["a", "b", "c"], keyOf, { key: "c", index: 0 })).toBe("c");
    expect(resolveBoardSelection(["a", "c"], keyOf, { key: "b", index: 1 })).toBe("c");
    expect(resolveBoardSelection(["a"], keyOf, { key: "b", index: 1 })).toBe("a");
  });
  it.each(["running", "idle"] as const)("keeps live background %s out of Idle", (status) => {
    expect(
      resolveThreadBoardSection(
        thread({ latestRun: completed, runtime: runtime(status) }),
        options,
      ),
    ).toBe("working");
  });
  it.each(["starting", "running"] as const)("shows a %s session as Working", (status) => {
    expect(
      resolveThreadBoardSection(
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
      resolveThreadBoardSection(
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
    ).toBe("inbox");
  });
  it("wakes snoozed threads for questions and approvals, but not completed work", () => {
    expect(resolveThreadBoardSection(thread(snoozed), options)).toBeNull();
    expect(
      resolveThreadBoardSection(thread({ ...snoozed, hasPendingApprovals: true }), options),
    ).toBe("inbox");
    expect(
      resolveThreadBoardSection(thread({ ...snoozed, hasPendingUserInput: true }), options),
    ).toBe("inbox");
    expect(
      resolveThreadBoardSection(thread({ ...snoozed, latestRun: completed }), options),
    ).toBeNull();
    expect(
      resolveThreadBoardSection(thread(snoozed), { ...options, now: snoozed.snoozedUntil }),
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
  it("hides subagent threads of settled parents while retaining forks", () => {
    const parent = thread({ id: ThreadId.make("parent"), settledOverride: "settled" });
    const child = thread({
      id: ThreadId.make("child"),
      latestRun: completed,
      lineage: {
        parentThreadId: parent.id,
        rootThreadId: parent.id,
        relationshipToParent: "subagent",
      },
    });
    const fork = thread({
      id: ThreadId.make("fork"),
      lineage: { ...child.lineage, relationshipToParent: "fork" },
    });
    const board = buildThreadBoard([parent, child, fork], {
      now,
      projectKey: "",
      serverConfigs: new Map([[environmentId, capabilities]]),
    });
    expect(board.flatMap((column) => column.threads.map((item) => item.id))).toEqual(["fork"]);
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
