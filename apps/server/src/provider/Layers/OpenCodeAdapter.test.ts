import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { FormInfo, OpenCodeClient, SessionMessageInfo, V2Event } from "@opencode/client";

import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { isOpenCodeSessionNotFound, makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

const SESSION_ID = "ses-1";
const THREAD_ID = ThreadId.make("thread-1");
const MODEL = createModelSelection(ProviderInstanceId.make("opencode"), "anthropic/claude-sonnet");

type EventData<Type extends V2Event["type"]> = Extract<V2Event, { readonly type: Type }>["data"];

let eventCount = 0;
/** Builds an event envelope. The adapter reads only `type`, `created`, and `data`. */
const openCodeEvent = <Type extends V2Event["type"]>(type: Type, data: EventData<Type>) =>
  ({ id: `evt-${++eventCount}`, created: 0, type, data }) as V2Event;

const TOKENS = { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } };

/**
 * A scripted OpenCode server. Requests are recorded in `calls`; `push` feeds
 * the event subscription, which opens with `server.connected` like the real one.
 */
function makeFakeOpenCode(options?: {
  readonly existingSession?: { readonly id: string; readonly directory: string };
  readonly agents?: ReadonlyArray<string>;
  readonly commands?: ReadonlyArray<string>;
  readonly interrupted?: boolean;
  readonly messages?: ReadonlyArray<SessionMessageInfo>;
  /** Answers `session.prompt`, which otherwise resolves at once. */
  readonly prompt?: () => Promise<unknown>;
}) {
  const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
  const buffered: Array<V2Event | "end"> = [openCodeEvent("server.connected", {})];
  let wake: (() => void) | undefined;
  const record =
    <A>(method: string, output: A) =>
    (input: unknown) => {
      calls.push({ method, input });
      return Promise.resolve(output);
    };
  const sessionInfo = (id: string, directory: string) => ({ id, location: { directory } });

  async function* subscribe(input: { readonly signal: AbortSignal }) {
    while (!input.signal.aborted) {
      const next = buffered.shift();
      if (next === "end") return;
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }

  const client = {
    event: { subscribe },
    agent: {
      list: record("agent.list", { data: (options?.agents ?? ["build"]).map((id) => ({ id })) }),
    },
    command: {
      list: record("command.list", {
        data: (options?.commands ?? []).map((name) => ({ name })),
      }),
    },
    mcp: { add: record("mcp.add", undefined) },
    message: {
      // Pages of two. Like the real server, a cursor carries its own order.
      list: (input: { readonly cursor?: string; readonly order?: string }) => {
        calls.push({ method: "message.list", input });
        if (input.cursor !== undefined && input.order !== undefined) {
          return Promise.reject({
            _tag: "InvalidCursorError",
            message: "Cursor cannot be combined with order",
          });
        }
        const messages = options?.messages ?? [];
        const start = Number(input.cursor ?? 0);
        const end = start + 2;
        return Promise.resolve({
          data: messages.slice(start, end),
          cursor: end < messages.length ? { next: String(end) } : {},
        });
      },
    },
    permission: { reply: record("permission.reply", undefined) },
    session: {
      get: (input: { readonly sessionID: string }) => {
        calls.push({ method: "session.get", input });
        const existing = options?.existingSession;
        return existing?.id === input.sessionID
          ? Promise.resolve(sessionInfo(existing.id, existing.directory))
          : Promise.reject({ _tag: "SessionNotFoundError", sessionID: input.sessionID });
      },
      create: (input: { readonly location: { readonly directory: string } }) => {
        calls.push({ method: "session.create", input });
        return Promise.resolve(sessionInfo(SESSION_ID, input.location.directory));
      },
      update: record("session.update", undefined),
      move: record("session.move", undefined),
      wait: record("session.wait", undefined),
      remove: record("session.remove", undefined),
      prompt: (input: unknown) => {
        calls.push({ method: "session.prompt", input });
        return options?.prompt?.() ?? Promise.resolve(undefined);
      },
      command: record("session.command", undefined),
      compact: record("session.compact", undefined),
      interrupt: record("session.interrupt", { interrupted: options?.interrupted ?? true }),
      switchModel: record("session.switchModel", undefined),
      switchAgent: record("session.switchAgent", undefined),
      instructions: { entry: { put: record("session.instructions.entry.put", undefined) } },
      inbox: { cancel: record("session.inbox.cancel", undefined) },
      form: {
        reply: record("session.form.reply", undefined),
        cancel: record("session.form.cancel", undefined),
      },
      revert: {
        stage: record("session.revert.stage", undefined),
        commit: record("session.revert.commit", undefined),
      },
    },
  };

  return {
    // The adapter uses a small part of the generated client surface.
    client: client as unknown as OpenCodeClient,
    calls,
    inputsOf: (method: string) =>
      calls.filter((call) => call.method === method).map((call) => call.input),
    push: (...events: ReadonlyArray<V2Event | "end">) => {
      buffered.push(...events);
      wake?.();
    },
  };
}

type FakeOpenCode = ReturnType<typeof makeFakeOpenCode>;

const unused = (operation: string) => () =>
  Effect.fail(new OpenCodeRuntimeError({ operation, detail: "Not used by the adapter." }));

const OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
});

const makeAdapter = (fake: FakeOpenCode) =>
  makeOpenCodeAdapter(OPENCODE_SETTINGS).pipe(
    Effect.provide(
      Layer.succeed(OpenCodeRuntime, {
        startOpenCodeServerProcess: unused("startOpenCodeServerProcess"),
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "http://127.0.0.1:9999",
            version: "2.0.8",
            exitCode: null,
            external: true,
          }),
        runOpenCodeCommand: unused("runOpenCodeCommand"),
        createOpenCodeSdkClient: () => fake.client,
        loadOpenCodeInventory: unused("loadOpenCodeInventory"),
        loadOpenCodeSkills: unused("loadOpenCodeSkills"),
      } satisfies OpenCodeRuntimeShape).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const startSession = (
  adapter: Effect.Success<ReturnType<typeof makeAdapter>>,
  input?: { readonly runtimeMode?: RuntimeMode; readonly resumeCursor?: unknown; cwd?: string },
) =>
  adapter.startSession({
    provider: adapter.provider,
    threadId: THREAD_ID,
    runtimeMode: input?.runtimeMode ?? "approval-required",
    modelSelection: MODEL,
    ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
    ...(input?.cwd ? { cwd: input.cwd } : {}),
  });

/** Collects runtime events up to and including the first one of `type`. */
const eventsThrough = (
  adapter: Effect.Success<ReturnType<typeof makeAdapter>>,
  type: ProviderRuntimeEvent["type"],
) =>
  adapter.streamEvents.pipe(
    Stream.takeUntil((event) => event.type === type),
    Stream.runCollect,
    Effect.map((events) => [...events]),
  );

const ofType = <Type extends ProviderRuntimeEvent["type"]>(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  type: Type,
) =>
  events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { readonly type: Type }> => event.type === type,
  );

const enqueued = (inboxID: string) =>
  openCodeEvent("session.inbox.enqueued", {
    inboxID,
    sessionID: SESSION_ID,
    item: { type: "user", payload: { text: "hi" }, delivery: "steer" },
  } as EventData<"session.inbox.enqueued">);
const delivered = (inboxID: string) =>
  openCodeEvent("session.inbox.delivered", { sessionID: SESSION_ID, inboxID });
const succeeded = () => openCodeEvent("session.execution.succeeded", { sessionID: SESSION_ID });

it.effect("streams a turn and completes it once its prompt was delivered", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });

    NodeAssert.deepEqual(fake.inputsOf("session.switchModel"), [
      { sessionID: SESSION_ID, model: { providerID: "anthropic", id: "claude-sonnet" } },
    ]);
    NodeAssert.deepEqual(fake.inputsOf("session.prompt"), [
      { sessionID: SESSION_ID, text: "hi", files: [] },
    ]);

    const message = { sessionID: SESSION_ID, assistantMessageID: "msg-1", ordinal: 0 };
    fake.push(
      enqueued("inbox-1"),
      // An execution that ends before the prompt is delivered belongs to
      // something else OpenCode queued, such as a compaction.
      succeeded(),
      delivered("inbox-1"),
      openCodeEvent("session.text.delta", { ...message, delta: "Hel" }),
      openCodeEvent("session.text.delta", { ...message, delta: "lo" }),
      openCodeEvent("session.text.ended", { ...message, text: "Hello" }),
      openCodeEvent("session.step.ended", {
        sessionID: SESSION_ID,
        assistantMessageID: "msg-1",
        finish: "stop",
        cost: 0,
        tokens: TOKENS,
      } as EventData<"session.step.ended">),
      succeeded(),
    );

    const events = yield* eventsThrough(adapter, "turn.completed");
    NodeAssert.deepEqual(
      events.map((event) => event.type),
      [
        "session.started",
        "thread.started",
        "turn.started",
        "content.delta",
        "content.delta",
        "item.completed",
        "turn.completed",
      ],
    );
    NodeAssert.deepEqual(
      ofType(events, "content.delta").map((event) => event.payload.delta),
      ["Hel", "lo"],
    );
    const [completed] = ofType(events, "turn.completed");
    NodeAssert.equal(completed?.turnId, turn.turnId);
    NodeAssert.deepEqual(completed?.payload, {
      state: "completed",
      tokenUsage: {
        usageStatus: "complete",
        usageScope: "main_agent",
        inputTokens: 14,
        cachedInputTokens: 3,
        cacheCreationTokens: 1,
        outputTokens: 7,
        reasoningTokens: 2,
        hasSubagents: false,
      },
    });
  }),
);

it.effect("keeps a steered turn open until every prompt was delivered", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "first" });
    const steer = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "second" });
    NodeAssert.equal(steer.turnId, turn.turnId);

    fake.push(
      enqueued("inbox-1"),
      enqueued("inbox-2"),
      delivered("inbox-1"),
      succeeded(),
      openCodeEvent("session.text.ended", {
        sessionID: SESSION_ID,
        assistantMessageID: "msg-2",
        ordinal: 0,
        text: "after the steer",
      }),
      delivered("inbox-2"),
      succeeded(),
    );

    const events = yield* eventsThrough(adapter, "turn.completed");
    NodeAssert.equal(ofType(events, "turn.started").length, 1);
    // The first execution ended with a prompt still queued, so the turn
    // stayed open and the later text still belongs to it.
    NodeAssert.deepEqual(
      ofType(events, "content.delta").map((event) => [event.turnId, event.payload.delta]),
      [[turn.turnId, "after the steer"]],
    );
  }),
);

it.effect("maps a tool call to one item lifecycle", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "run pwd" });

    const call = { sessionID: SESSION_ID, assistantMessageID: "msg-1", id: "call-1" };
    fake.push(
      enqueued("inbox-1"),
      delivered("inbox-1"),
      openCodeEvent("session.tool.input.started", { ...call, name: "shell" }),
      openCodeEvent("session.tool.called", { ...call, input: { command: "pwd" }, executed: false }),
      openCodeEvent("session.tool.success", {
        ...call,
        content: [{ type: "text", text: "/repo" }],
        executed: true,
      } as EventData<"session.tool.success">),
      succeeded(),
    );

    const events = yield* eventsThrough(adapter, "turn.completed");
    const items = events.filter(
      (event) =>
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed",
    );
    NodeAssert.deepEqual(
      items.map((event) => [
        event.type,
        event.itemId,
        event.payload.itemType,
        event.payload.status,
      ]),
      [
        ["item.started", "call-1", "command_execution", "inProgress"],
        ["item.updated", "call-1", "command_execution", "inProgress"],
        ["item.completed", "call-1", "command_execution", "completed"],
      ],
    );
    NodeAssert.deepEqual(items.at(-1)?.payload.data, {
      tool: "shell",
      command: "pwd",
      result: "/repo",
    });
    NodeAssert.equal(items.at(-1)?.payload.detail, "/repo");
  }),
);

it.effect("opens a permission request and replies with the user's decision", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "run pwd" });

    // A subagent session asks through its parent thread.
    fake.push(
      openCodeEvent("session.created", {
        sessionID: "ses-child",
        parentID: SESSION_ID,
      } as EventData<"session.created">),
      openCodeEvent("permission.asked", {
        id: "per-1",
        sessionID: "ses-child",
        action: "shell",
        resources: ["pwd"],
      }),
    );
    const [opened] = ofType(yield* eventsThrough(adapter, "request.opened"), "request.opened");
    NodeAssert.equal(opened?.requestId, "per-1");
    NodeAssert.equal(opened?.payload.requestType, "command_execution_approval");
    NodeAssert.equal(opened?.payload.detail, "pwd");

    yield* adapter.respondToRequest(THREAD_ID, ApprovalRequestId.make("per-1"), "acceptForSession");
    NodeAssert.deepEqual(fake.inputsOf("permission.reply"), [
      { sessionID: "ses-child", requestID: "per-1", decision: "always" },
    ]);
    const [resolved] = ofType(
      yield* eventsThrough(adapter, "request.resolved"),
      "request.resolved",
    );
    NodeAssert.deepEqual(resolved?.payload, {
      requestType: "command_execution_approval",
      decision: "acceptForSession",
    });
  }),
);

it.effect("approves permission requests itself in full-access mode", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter, { runtimeMode: "full-access" });
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "run pwd" });

    fake.push(
      openCodeEvent("permission.asked", {
        id: "per-1",
        sessionID: SESSION_ID,
        action: "shell",
        resources: ["pwd"],
      }),
      enqueued("inbox-1"),
      delivered("inbox-1"),
      succeeded(),
    );
    const events = yield* eventsThrough(adapter, "turn.completed");
    NodeAssert.deepEqual(ofType(events, "request.opened"), []);
    NodeAssert.deepEqual(fake.inputsOf("permission.reply"), [
      { sessionID: SESSION_ID, requestID: "per-1", decision: "once" },
    ]);
  }),
);

it.effect("asks the user to fill an OpenCode form and replies with typed answers", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "ask me" });

    const form: FormInfo = {
      id: "form-1",
      sessionID: SESSION_ID,
      title: "Deploy",
      fields: [
        {
          key: "target",
          type: "string",
          title: "Target",
          options: [{ value: "prod", label: "Production" }],
        },
        { key: "confirm", type: "boolean", title: "Confirm" },
      ],
    };
    fake.push(openCodeEvent("form.created", { form } as EventData<"form.created">));
    const [requested] = ofType(
      yield* eventsThrough(adapter, "user-input.requested"),
      "user-input.requested",
    );
    NodeAssert.equal(requested?.requestId, "form-1");
    NodeAssert.deepEqual(
      requested?.payload.questions.map((question) => question.id),
      ["target", "confirm"],
    );

    yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("form-1"), {
      target: "prod",
      confirm: "true",
    });
    NodeAssert.deepEqual(fake.inputsOf("session.form.reply"), [
      { sessionID: SESSION_ID, formID: "form-1", answer: { target: "prod", confirm: true } },
    ]);
    const [resolved] = ofType(
      yield* eventsThrough(adapter, "user-input.resolved"),
      "user-input.resolved",
    );
    NodeAssert.deepEqual(resolved?.payload.answers, { target: "prod", confirm: true });
  }),
);

it.effect("fails the turn and closes its open requests when the execution fails", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });

    // OpenCode reports some failures, such as a missing agent, without ever
    // delivering the prompt.
    fake.push(
      openCodeEvent("permission.asked", {
        id: "per-1",
        sessionID: SESSION_ID,
        action: "edit",
        resources: ["a.ts"],
      }),
      openCodeEvent("session.execution.failed", {
        sessionID: SESSION_ID,
        error: { type: "unknown", message: 'Agent not found: "plan"' },
      } as EventData<"session.execution.failed">),
    );

    const events = yield* eventsThrough(adapter, "runtime.error");
    NodeAssert.deepEqual(
      events.slice(-3).map((event) => [event.type, event.turnId]),
      [
        ["request.resolved", turn.turnId],
        ["turn.completed", turn.turnId],
        ["runtime.error", undefined],
      ],
    );
    const [completed] = ofType(events, "turn.completed");
    NodeAssert.equal(completed?.payload.state, "failed");
    NodeAssert.equal(completed?.payload.errorMessage, 'Agent not found: "plan"');
    NodeAssert.equal((yield* adapter.listSessions())[0]?.status, "error");
  }),
);

it.effect("aborts a turn OpenCode had not started, and withdraws its queued prompt", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode({ interrupted: false });
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
    fake.push(
      enqueued("inbox-1"),
      openCodeEvent("session.renamed", { sessionID: SESSION_ID, title: "Hi" }),
    );
    yield* eventsThrough(adapter, "thread.metadata.updated");

    yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
    NodeAssert.deepEqual(fake.inputsOf("session.inbox.cancel"), [
      { sessionID: SESSION_ID, inboxID: "inbox-1" },
    ]);
    const [aborted] = ofType(yield* eventsThrough(adapter, "turn.aborted"), "turn.aborted");
    NodeAssert.equal(aborted?.turnId, turn.turnId);
    NodeAssert.equal(aborted?.payload.reason, "Interrupted by user.");
  }),
);

/** A `session.prompt` that stays pending, as it does while OpenCode boots a directory. */
const makePendingPrompt = Effect.fn("makePendingPrompt")(function* () {
  const started = yield* Queue.make<void>();
  const accepted = Promise.withResolvers<unknown>();
  return {
    started: Queue.take(started),
    accept: accepted.resolve,
    prompt: () => {
      Queue.offerUnsafe(started, undefined);
      return accepted.promise;
    },
  };
});

it.effect("keeps the turn open while OpenCode is slow to accept its first prompt", () =>
  Effect.gen(function* () {
    const pending = yield* makePendingPrompt();
    const fake = makeFakeOpenCode({ prompt: pending.prompt });
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    const sending = yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "hi" })
      .pipe(Effect.forkChild);
    yield* pending.started;

    yield* TestClock.adjust("30 seconds");
    pending.accept({ id: "inbox-1" });
    const turn = yield* Fiber.join(sending);
    fake.push(enqueued("inbox-1"), delivered("inbox-1"), succeeded());

    const events = yield* eventsThrough(adapter, "turn.completed");
    NodeAssert.equal(ofType(events, "turn.completed")[0]?.turnId, turn.turnId);
    NodeAssert.deepEqual(ofType(events, "turn.aborted"), []);
    NodeAssert.deepEqual(fake.inputsOf("session.inbox.cancel"), []);
  }),
);

it.effect("withdraws a prompt OpenCode accepts after its turn was stopped", () =>
  Effect.gen(function* () {
    const pending = yield* makePendingPrompt();
    const fake = makeFakeOpenCode({ interrupted: false, prompt: pending.prompt });
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    const sending = yield* adapter
      .sendTurn({ threadId: THREAD_ID, input: "hi" })
      .pipe(Effect.forkChild);
    yield* pending.started;

    yield* adapter.interruptTurn(THREAD_ID);
    yield* eventsThrough(adapter, "turn.aborted");
    NodeAssert.equal(fake.inputsOf("session.interrupt").length, 1);

    pending.accept({ id: "inbox-1" });
    yield* Fiber.join(sending);
    NodeAssert.deepEqual(fake.inputsOf("session.inbox.cancel"), [
      { sessionID: SESSION_ID, inboxID: "inbox-1" },
    ]);
    NodeAssert.equal(fake.inputsOf("session.interrupt").length, 2);
  }),
);

it.effect("reports an interrupted execution as an aborted turn", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
    yield* adapter.interruptTurn(THREAD_ID, turn.turnId);
    fake.push(
      openCodeEvent("session.execution.interrupted", { sessionID: SESSION_ID, reason: "user" }),
    );

    const events = yield* eventsThrough(adapter, "turn.aborted");
    NodeAssert.equal(ofType(events, "turn.aborted")[0]?.payload.reason, "Interrupted by user.");
    NodeAssert.deepEqual(ofType(events, "turn.completed"), []);
  }),
);

it.effect("sends a known slash command through session.command", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode({ commands: ["review"] });
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/review the last commit" });
    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/unknown stays a prompt" });

    NodeAssert.deepEqual(fake.inputsOf("session.command"), [
      { sessionID: SESSION_ID, name: "review", text: "the last commit", files: [] },
    ]);
    NodeAssert.deepEqual(fake.inputsOf("session.prompt"), [
      { sessionID: SESSION_ID, text: "/unknown stays a prompt", files: [] },
    ]);
  }),
);

it.effect("uses the plan agent in plan mode only when OpenCode has one", () =>
  Effect.gen(function* () {
    const withoutPlan = makeFakeOpenCode();
    const first = yield* makeAdapter(withoutPlan);
    yield* startSession(first);
    yield* first.sendTurn({ threadId: THREAD_ID, input: "plan it", interactionMode: "plan" });
    NodeAssert.deepEqual(withoutPlan.inputsOf("session.switchAgent"), []);

    const withPlan = makeFakeOpenCode({ agents: ["build", "plan"] });
    const second = yield* makeAdapter(withPlan);
    yield* startSession(second);
    yield* second.sendTurn({ threadId: THREAD_ID, input: "plan it", interactionMode: "plan" });
    NodeAssert.deepEqual(withPlan.inputsOf("session.switchAgent"), [
      { sessionID: SESSION_ID, agent: "plan" },
    ]);
  }),
);

it.effect("reports a finished compaction and refuses to compact during a turn", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);

    yield* adapter.compaction.start(THREAD_ID, MODEL);
    NodeAssert.deepEqual(fake.inputsOf("session.compact"), [{ sessionID: SESSION_ID }]);
    fake.push(
      openCodeEvent("session.compaction.ended", {
        sessionID: SESSION_ID,
        reason: "manual",
        text: "summary",
      } as EventData<"session.compaction.ended">),
      succeeded(),
    );
    const events = yield* eventsThrough(adapter, "thread.state.changed");
    NodeAssert.equal(ofType(events, "thread.state.changed")[0]?.payload.state, "compacted");

    yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
    const error = yield* Effect.flip(adapter.compaction.start(THREAD_ID, MODEL));
    NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
  }),
);

it.effect("resumes the session from its cursor and moves it to a new cwd", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode({ existingSession: { id: "ses-old", directory: "/elsewhere" } });
    const adapter = yield* makeAdapter(fake);
    const session = yield* startSession(adapter, {
      resumeCursor: { schemaVersion: 1, sessionId: "ses-old" },
    });

    NodeAssert.deepEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "ses-old" });
    NodeAssert.deepEqual(fake.inputsOf("session.create"), []);
    NodeAssert.deepEqual(fake.inputsOf("session.move"), [
      { sessionID: "ses-old", directory: process.cwd() },
    ]);
    NodeAssert.deepEqual(
      fake.calls.map((call) => call.method),
      ["session.get", "session.update", "session.move", "session.wait"],
    );
  }),
);

it.effect("starts a fresh session when the resumed one no longer exists", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    const session = yield* startSession(adapter, {
      resumeCursor: { schemaVersion: 1, sessionId: "ses-gone" },
    });
    NodeAssert.deepEqual(session.resumeCursor, { schemaVersion: 1, sessionId: SESSION_ID });
    NodeAssert.equal(fake.inputsOf("session.create").length, 1);
  }),
);

it("recognizes only OpenCode's session-not-found rejection", () => {
  const notFound = { _tag: "SessionNotFoundError", sessionID: "ses-1" };
  NodeAssert.equal(isOpenCodeSessionNotFound(notFound), true);
  NodeAssert.equal(
    isOpenCodeSessionNotFound(
      new OpenCodeRuntimeError({ operation: "session.get", detail: "gone", cause: notFound }),
    ),
    true,
  );
  NodeAssert.equal(isOpenCodeSessionNotFound({ _tag: "ServiceUnavailableError" }), false);
  NodeAssert.equal(isOpenCodeSessionNotFound(new Error("fetch failed")), false);
});

it.effect("rolls back by reverting to the first removed user message", () =>
  Effect.gen(function* () {
    const message = (type: "user" | "assistant", id: string) =>
      ({ type, id }) as SessionMessageInfo;
    const fake = makeFakeOpenCode({
      messages: [
        message("user", "msg-u1"),
        message("assistant", "msg-a1"),
        message("user", "msg-u2"),
        message("assistant", "msg-a2"),
        message("user", "msg-u3"),
      ],
    });
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);

    const thread = yield* adapter.readThread(THREAD_ID);
    NodeAssert.deepEqual(
      thread.turns.map((turn) => [turn.id, turn.items.length]),
      [
        ["msg-u1", 2],
        ["msg-u2", 2],
        ["msg-u3", 1],
      ],
    );

    yield* adapter.rollbackThread(THREAD_ID, 2);
    NodeAssert.deepEqual(fake.inputsOf("session.revert.stage"), [
      { sessionID: SESSION_ID, messageID: "msg-u2", files: false },
    ]);
    NodeAssert.deepEqual(fake.inputsOf("session.revert.commit"), [{ sessionID: SESSION_ID }]);
  }),
);

it.effect("fails the turn and exits the session when the event stream ends", () =>
  Effect.gen(function* () {
    const fake = makeFakeOpenCode();
    const adapter = yield* makeAdapter(fake);
    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
    fake.push("end");

    const events = yield* eventsThrough(adapter, "session.exited");
    NodeAssert.deepEqual(
      events.slice(-3).map((event) => event.type),
      ["turn.completed", "runtime.error", "session.exited"],
    );
    NodeAssert.equal(ofType(events, "turn.completed")[0]?.turnId, turn.turnId);
    NodeAssert.equal(ofType(events, "runtime.error")[0]?.payload.class, "transport_error");
    NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), false);
  }),
);
