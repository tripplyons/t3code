// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as CodexErrors from "effect-codex-app-server/errors";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };

const nativeGoal = {
  threadId: wireFixture.rootThreadId,
  objective: "Finish the migration",
  status: "paused" as const,
  tokenBudget: 50000,
  tokensUsed: 1234,
  timeUsedSeconds: 45,
  createdAt: 1,
  updatedAt: 2,
};
const encodeScript = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeRuntime = Effect.fnUntraced(function* (
  goalUnsupported = false,
  notifications: readonly { method: string; params: unknown }[] = [],
) {
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-goal-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(scratch, { recursive: true, force: true })),
  );
  const scriptPath = NodePath.join(scratch, "script.json");
  NodeFS.writeFileSync(
    scriptPath,
    encodeScript({
      rootThreadId: wireFixture.rootThreadId,
      notifications,
      goal: nativeGoal,
      goalUnsupported,
    }),
  );
  const threadId = ThreadId.make("t3-thread-goal");
  const runtime = yield* makeCodexSessionRuntime({
    threadId,
    binaryPath: NodePath.join(
      import.meta.dirname,
      `../testFixtures/codexCollabMockPeer.${HostProcessPlatform.defaultValue() === "win32" ? "cmd" : "sh"}`,
    ),
    cwd: scratch,
    runtimeMode: "full-access",
    resumeCursor: { threadId: wireFixture.rootThreadId },
    environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
  });
  return { runtime, threadId };
});

it.effect("restores a goal and edits, resumes, pauses, and clears native state", () =>
  Effect.gen(function* () {
    const { runtime, threadId } = yield* makeRuntime();
    const snapshots = yield* Queue.unbounded<unknown>();
    yield* runtime.events.pipe(
      Stream.filter((event) => event.method === "thread/goal/snapshot"),
      Stream.runForEach((event) => Queue.offer(snapshots, event.payload)),
      Effect.forkChild,
    );
    yield* runtime.start();
    assert.deepEqual(yield* Queue.take(snapshots), { goal: nativeGoal });

    const edited = yield* runtime.updateGoal({
      threadId,
      action: "set",
      objective: "Finish and verify the migration",
      tokenBudget: null,
    });
    assert.deepEqual(edited, {
      ...nativeGoal,
      objective: "Finish and verify the migration",
      tokenBudget: null,
    });
    assert.deepEqual(yield* Queue.take(snapshots), { goal: edited });
    const resumed = yield* runtime.updateGoal({ threadId, action: "set", status: "active" });
    assert.equal(resumed?.status, "active");
    assert.equal(resumed?.tokensUsed, 1234);
    assert.equal(resumed?.objective, edited?.objective);
    assert.deepEqual(yield* Queue.take(snapshots), { goal: resumed });
    const paused = yield* runtime.updateGoal({ threadId, action: "set", status: "paused" });
    assert.equal(paused?.status, "paused");
    assert.deepEqual(yield* Queue.take(snapshots), { goal: paused });
    assert.isNull(yield* runtime.updateGoal({ threadId, action: "clear" }));
    assert.deepEqual(yield* Queue.take(snapshots), { goal: null });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps conversations usable when Codex has no goal API and reports mutation failure",
  () =>
    Effect.gen(function* () {
      const { runtime, threadId } = yield* makeRuntime(true);
      const session = yield* runtime.start();
      assert.equal(session.status, "ready");
      const error = yield* Effect.flip(
        runtime.updateGoal({ threadId, action: "set", status: "paused" }),
      );
      assert.isTrue(Schema.is(CodexErrors.CodexAppServerRequestError)(error));
      assert.equal(error.message, "Goals are not supported");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("suppresses child goals before and after child registration", () =>
  Effect.gen(function* () {
    const childThreadId = wireFixture.childThreadIds[0];
    const childGoal = { ...nativeGoal, threadId: childThreadId, objective: "Child objective" };
    const childUpdates = [
      { method: "thread/goal/updated", params: { threadId: childThreadId, goal: childGoal } },
      { method: "thread/goal/cleared", params: { threadId: childThreadId } },
    ];
    const registration = wireFixture.notifications.find(
      (entry) => entry.method === "thread/started",
    );
    assert.isDefined(registration);
    const { runtime } = yield* makeRuntime(false, [
      ...childUpdates,
      registration!,
      ...childUpdates,
      {
        method: "thread/goal/updated",
        params: { threadId: nativeGoal.threadId, goal: nativeGoal },
      },
    ]);
    yield* runtime.start();
    const events = yield* runtime.events.pipe(
      Stream.takeUntil((event) => event.method === "turn/completed"),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* runtime.sendTurn({ input: "Check child goal isolation" });
    const goalEvents = Array.from(yield* Fiber.join(events)).filter((event) =>
      event.method.startsWith("thread/goal/"),
    );
    assert.deepEqual(
      goalEvents.map((event) => event.payload),
      [{ goal: nativeGoal }, { threadId: nativeGoal.threadId, goal: nativeGoal }],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
