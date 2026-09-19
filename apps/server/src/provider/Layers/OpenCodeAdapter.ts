import {
  EventId,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  type TurnTokenUsage,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { FormInfo, OpenCodeClient, SessionMessageInfo, V2Event } from "@opencode/client";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  loadOpenCodeCommands,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodeFiles,
  toOpenCodeFormAnswer,
  toOpenCodePermissionReply,
  toUserInputQuestions,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";

const PROVIDER = ProviderDriverKind.make("opencode");

/**
 * Version tag stamped into the OpenCode resume cursor. Bump if the cursor
 * shape changes so stale-shaped cursors written by older builds are ignored
 * rather than misread (mirrors GROK_RESUME_VERSION / CURSOR_RESUME_VERSION).
 */
const OPENCODE_RESUME_VERSION = 1 as const;

/**
 * Decode a persisted resume cursor into the upstream `ses_…` id. Anything
 * that isn't a current-version cursor with a non-empty id means "no resume"
 * rather than an error. Re-adopting the session id IS the resume mechanism —
 * OpenCode scopes a conversation's history by session id.
 */
function parseOpenCodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error definitively reports a missing session. Only a confirmed
 * miss may silently start a fresh session; any other failure must propagate,
 * or a transient blip resets a live thread to an empty one (the #3604 silent
 * context loss). OpenCode rejects with a tagged `SessionNotFoundError`, which
 * `runOpenCodeSdk` carries as the `cause`. Exported for unit testing.
 */
export function isOpenCodeSessionNotFound(cause: unknown): boolean {
  const rejection = OpenCodeRuntimeError.is(cause) ? cause.cause : cause;
  return (
    typeof rejection === "object" &&
    rejection !== null &&
    "_tag" in rejection &&
    rejection._tag === "SessionNotFoundError"
  );
}

/**
 * Whether two directory spellings name the same location. Raw string
 * equality misreads a trailing slash, `.`/`..` segment, or symlinked cwd
 * (macOS `/tmp` → `/private/tmp`) as a cwd change, needlessly forking the
 * session on every resume. Lexically equal paths short-circuit; otherwise
 * both sides go through `realPath`, each falling back to its lexical form
 * on failure (deleted directory, external-server path) — so the probe can
 * only widen matches, never split them. Takes the services as arguments so
 * adapter methods stay service-free. Exported for unit testing.
 */
export function isSameOpenCodeDirectory(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  left: string,
  right: string,
): Effect.Effect<boolean> {
  const lexicalLeft = path.resolve(left);
  const lexicalRight = path.resolve(right);
  if (lexicalLeft === lexicalRight) {
    return Effect.succeed(true);
  }
  const canonicalize = (lexical: string) =>
    fileSystem.realPath(lexical).pipe(Effect.orElseSucceed(() => lexical));
  return Effect.zipWith(
    canonicalize(lexicalLeft),
    canonicalize(lexicalRight),
    (canonicalLeft, canonicalRight) => canonicalLeft === canonicalRight,
  );
}

type OpenCodeEventOf<Type extends V2Event["type"]> = Extract<V2Event, { readonly type: Type }>;
type OpenCodePermissionRequest = OpenCodeEventOf<"permission.asked">["data"];
type OpenCodeStepTokens = OpenCodeEventOf<"session.step.ended">["data"]["tokens"];

/** The agent a session runs when the user picked none. */
const OPENCODE_DEFAULT_AGENT = "build";
const OPENCODE_PLAN_AGENT = "plan";
const OPENCODE_INSTRUCTIONS_KEY = "t3code.runtime";
const OPENCODE_REQUEST_TIMEOUT = "10 seconds";

interface OpenCodeTurnTokenUsageAccumulator {
  steps: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  hasSubagents: boolean;
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpenCodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  /** Subagent sessions spawned under this thread. Their asks surface here; their output does not. */
  readonly childSessionIds: Set<string>;
  readonly pendingPermissions: Map<string, OpenCodePermissionRequest>;
  readonly pendingForms: Map<string, FormInfo>;
  /** Tool calls in flight. OpenCode names the tool only when its input starts streaming. */
  readonly tools: Map<string, { readonly name: string; input?: Record<string, unknown> }>;
  /** Text and reasoning items that already streamed a delta this turn. */
  readonly streamedItemIds: Set<string>;
  /**
   * OpenCode runs an execution per inbox item, including compactions and
   * moves, so an execution ending does not by itself end the turn. A turn ends
   * when every prompt it submitted has been enqueued and delivered.
   */
  readonly submissions: Array<object>;
  readonly turnInboxIds: Set<string>;
  turnDelivered: boolean;
  turnTokenUsage: OpenCodeTurnTokenUsageAccumulator | undefined;
  activeTurnId: TurnId | undefined;
  /** Model and agent are session state in OpenCode, so they are switched only when they change. */
  appliedModel: string | undefined;
  appliedAgent: string;
  readonly promptSemaphore: Semaphore.Semaphore;
  readonly firstConnection: Deferred.Deferred<void, ProviderAdapterRequestError>;
  /**
   * One-shot guard flipped by `stopOpenCodeContext` / `emitUnexpectedExit`.
   * The session lifecycle is owned by `sessionScope`; this Ref exists only
   * so concurrent callers can race the transition safely via `getAndSet`.
   */
  readonly stopped: Ref.Ref<boolean>;
  /**
   * Sole lifecycle handle for the session. Closing this scope:
   *   - aborts the `AbortController` registered as a finalizer
   *     (cancels the in-flight `event.subscribe` stream),
   *   - interrupts the event-pump and server-exit fibers forked
   *     via `Effect.forkIn(sessionScope)`,
   *   - tears down the OpenCode server process for scope-owned servers.
   */
  readonly sessionScope: Scope.Closeable;
}

function makeOpenCodeTurnTokenUsageAccumulator(): OpenCodeTurnTokenUsageAccumulator {
  return {
    steps: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    hasSubagents: false,
  };
}

function accumulateOpenCodeStepUsage(
  accumulator: OpenCodeTurnTokenUsageAccumulator,
  tokens: OpenCodeStepTokens,
): void {
  accumulator.steps += 1;
  accumulator.inputTokens += tokens.input + tokens.cache.read + tokens.cache.write;
  accumulator.cachedInputTokens += tokens.cache.read;
  accumulator.cacheCreationTokens += tokens.cache.write;
  accumulator.outputTokens += tokens.output + tokens.reasoning;
  accumulator.reasoningTokens += tokens.reasoning;
}

function takeOpenCodeTurnTokenUsage(
  context: OpenCodeSessionContext,
  complete: boolean,
): TurnTokenUsage {
  const usage = context.turnTokenUsage;
  context.turnTokenUsage = undefined;
  if (!usage || usage.steps === 0) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: usage?.hasSubagents ?? false,
    };
  }
  return {
    usageStatus: complete ? "complete" : "partial",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
    hasSubagents: usage.hasSubagents,
  };
}

export interface OpenCodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const isoFromEpochMs = (value: number) => DateTime.formatIso(DateTime.makeUnsafe(value));

/**
 * Map a tagged OpenCodeRuntimeError produced by {@link runOpenCodeSdk} into
 * the adapter-boundary `ProviderAdapterRequestError`. SDK-method-level call
 * sites pipe through this in `Effect.mapError` so they never build the error
 * shape by hand.
 */
const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

/** Runs one OpenCode request with the adapter's request timeout and error shape. */
const request = <A>(operation: string, fn: (signal: AbortSignal) => Promise<A>) =>
  runOpenCodeSdk(operation, fn).pipe(
    Effect.timeout(OPENCODE_REQUEST_TIMEOUT),
    Effect.catchTags({
      OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
      TimeoutError: (cause) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: operation,
            detail: `OpenCode ${operation} did not complete within ${OPENCODE_REQUEST_TIMEOUT}.`,
            cause,
          }),
        ),
    }),
  );

/**
 * Map a `Cause.squash`-ed failure into a `ProviderAdapterProcessError`. The
 * typed cause is usually an `OpenCodeRuntimeError` (from {@link runOpenCodeSdk}),
 * in which case we preserve its `detail`; otherwise we fall back to
 * {@link openCodeRuntimeErrorDetail} for unknown causes (defects, etc.).
 */
const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("shell") || normalized.includes("bash")) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (normalized.includes("subagent") || normalized.includes("task")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  action: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" {
  switch (action) {
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      // Every OpenCode permission needs an actionable approval in each client.
      return "command_execution_approval";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
      return "decline";
  }
}

function toolResultText(
  content: OpenCodeEventOf<"session.tool.success">["data"]["content"],
): string | undefined {
  const text = content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function openCodeEventSessionId(event: V2Event): string | undefined {
  if (event.type === "form.created") return event.data.form.sessionID;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || !("sessionID" in data)) return undefined;
  return typeof data.sessionID === "string" ? data.sessionID : undefined;
}

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);
  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
});

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): Effect.Effect<ProviderSession> {
  return Effect.map(nowIso, (updatedAt) => {
    const { activeTurnId, lastError, ...rest } = { ...context.session, ...patch, updatedAt };
    context.session = {
      ...rest,
      ...(activeTurnId !== undefined && !options?.clearActiveTurnId ? { activeTurnId } : {}),
      ...(lastError !== undefined && !options?.clearLastError ? { lastError } : {}),
    };
    return context.session;
  });
}

const stopOpenCodeContext = Effect.fn("stopOpenCodeContext")(function* (
  context: OpenCodeSessionContext,
) {
  // Race-safe one-shot: first caller flips the flag, everyone else no-ops.
  if (yield* Ref.getAndSet(context.stopped, true)) {
    return false;
  }
  yield* Deferred.fail(
    context.firstConnection,
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "event.subscribe",
      detail: "OpenCode session stopped before the event stream connected.",
    }),
  ).pipe(Effect.ignore);

  // Best-effort remote interrupt. A shared or external server outlives this
  // session, so a running turn must be told to stop.
  if (context.activeTurnId !== undefined) {
    yield* runOpenCodeSdk("session.interrupt", (signal) =>
      context.client.session.interrupt({ sessionID: context.openCodeSessionId }, { signal }),
    ).pipe(Effect.timeout("1 second"), Effect.ignore);
  }

  // Closing the session scope interrupts every fiber forked into it and
  // runs each finalizer we registered — the `AbortController.abort()` call,
  // the child-process termination, etc.
  yield* Scope.close(context.sessionScope, Exit.void);
  return true;
});

export function makeOpenCodeAdapter(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    // Only close loggers we created. If the caller passed one in via
    // `options.nativeEventLogger`, they own its lifecycle.
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeSessionContext>();
    const deleteContextIfCurrent = (context: OpenCodeSessionContext) => {
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
    };
    const awaitOpenCodeContextReady = Effect.fn("awaitOpenCodeContextReady")(function* (
      context: OpenCodeSessionContext,
    ) {
      yield* Deferred.await(context.firstConnection);
      const current = yield* ensureSessionContext(sessions, context.session.threadId);
      if (current !== context) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.session.threadId,
        });
      }
      return current;
    });
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );
    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session. Each session's `Scope.close` tears down its spawned OpenCode
    // server (via the `ChildProcessSpawner` finalizer installed in
    // `startOpenCodeServerProcess`) and interrupts the forked event/exit
    // fibers. Consumers that can't reason about Effect scopes therefore
    // cannot leak OpenCode child processes by forgetting to call `stopAll`.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `ignoreCause` swallows both typed failures (none here) and defects
        // from throwing scope finalizers so a sibling's death can't interrupt
        // the remaining cleanups.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        // Close the logger AFTER session teardown so any final lifecycle
        // events emitted during shutdown still get written. `close` flushes
        // the `Logger.batched` window and closes each per-thread
        // `RotatingFileSink` handle owned by the logger's internal scope.
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) =>
      nativeEventLogger
        ? nativeEventLogger.write(event, threadId).pipe(Effect.catchCause(() => Effect.void))
        : Effect.void;

    /** Closes asks the turn left open, so no client keeps an approval nobody is waiting on. */
    const closePendingOpenCodeRequests = Effect.fn("closePendingOpenCodeRequests")(function* (
      context: OpenCodeSessionContext,
      turnId: TurnId,
      raw: unknown,
    ) {
      for (const [requestId, permission] of context.pendingPermissions) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId,
            raw,
          })),
          type: "request.resolved",
          payload: { requestType: mapPermissionToRequestType(permission.action) },
        });
      }
      context.pendingPermissions.clear();
      for (const requestId of context.pendingForms.keys()) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId,
            raw,
          })),
          type: "user-input.resolved",
          payload: { answers: {} },
        });
      }
      context.pendingForms.clear();
    });

    /** Ends the active turn and emits its terminal event. No-op when the turn already ended. */
    const endOpenCodeTurn = Effect.fn("endOpenCodeTurn")(function* (
      context: OpenCodeSessionContext,
      outcome:
        | { readonly state: "completed" }
        | { readonly state: "failed"; readonly message: string }
        | { readonly state: "aborted"; readonly reason: string },
      raw: unknown,
    ) {
      const turnId = context.activeTurnId;
      if (turnId === undefined) {
        return;
      }
      const tokenUsage = takeOpenCodeTurnTokenUsage(context, outcome.state === "completed");
      context.activeTurnId = undefined;
      context.turnDelivered = false;
      context.turnInboxIds.clear();
      context.submissions.length = 0;
      context.tools.clear();
      context.streamedItemIds.clear();
      yield* updateProviderSession(
        context,
        outcome.state === "failed"
          ? { status: "error", lastError: outcome.message }
          : { status: "ready" },
        { clearActiveTurnId: true },
      );
      yield* closePendingOpenCodeRequests(context, turnId, raw);
      const base = yield* buildEventBase({ threadId: context.session.threadId, turnId, raw });
      yield* emit(
        outcome.state === "aborted"
          ? { ...base, type: "turn.aborted", payload: { reason: outcome.reason, tokenUsage } }
          : {
              ...base,
              type: "turn.completed",
              payload:
                outcome.state === "failed"
                  ? { state: "failed", errorMessage: outcome.message, tokenUsage }
                  : { state: "completed", tokenUsage },
            },
      );
    });

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCodeSessionContext,
      message: string,
    ) {
      // Atomic one-shot: the event pump and the server-exit watcher can race
      // here. The first caller flips the flag and emits; the other no-ops.
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      deleteContextIfCurrent(context);
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: message,
        }),
      ).pipe(Effect.ignore);
      const turnId = context.activeTurnId;
      yield* endOpenCodeTurn(context, { state: "failed", message }, undefined);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "runtime.error",
        payload: { message, class: "transport_error" },
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "session.exited",
        payload: { reason: message, recoverable: false, exitKind: "error" },
      });
      // The caller runs inside `sessionScope`, so closing it interrupts this
      // fiber. Everything that must be emitted is emitted above.
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    const emitPermissionRequest = Effect.fn("emitPermissionRequest")(function* (
      context: OpenCodeSessionContext,
      permission: OpenCodePermissionRequest,
      raw: unknown,
    ) {
      // Full access means the user already granted everything, but subagent
      // sessions do not inherit the session ruleset we send. Answer their asks
      // here.
      //
      // Reply "once", not "always": OpenCode stores "always" grants per
      // directory, so on a shared external server an "always" from a
      // full-access thread would silently widen what a supervised thread on
      // the same directory is allowed to do.
      if (context.session.runtimeMode === "full-access") {
        yield* request("permission.reply", (signal) =>
          context.client.permission.reply(
            { sessionID: permission.sessionID, requestID: permission.id, decision: "once" },
            { signal },
          ),
        ).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* emit({
                ...(yield* buildEventBase({
                  threadId: context.session.threadId,
                  turnId: context.activeTurnId,
                  raw,
                })),
                type: "runtime.warning",
                payload: {
                  message: "OpenCode did not accept an automatic full-access approval.",
                  detail: cause.detail,
                },
              });
            }),
          ),
        );
        return;
      }

      const resources = permission.resources.filter((resource) => resource !== "*");
      context.pendingPermissions.set(permission.id, permission);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: permission.id,
          raw,
        })),
        type: "request.opened",
        payload: {
          requestType: mapPermissionToRequestType(permission.action),
          detail:
            permission.action === "shell" && resources.length > 0
              ? resources.join("\n")
              : [permission.action.replaceAll("_", " "), ...resources].join("\n"),
          args: permission.metadata,
          options: [
            { decision: "accept", label: "Allow once" },
            {
              decision: "acceptForSession",
              label: "Allow for workspace",
              warning: "Applies to matching requests in other OpenCode sessions in this workspace.",
            },
            { decision: "decline", label: "Deny" },
          ],
        },
      });
    });

    const emitFormRequest = Effect.fn("emitFormRequest")(function* (
      context: OpenCodeSessionContext,
      form: FormInfo,
      raw: unknown,
    ) {
      const questions = toUserInputQuestions(form);
      const base = yield* buildEventBase({
        threadId: context.session.threadId,
        turnId: context.activeTurnId,
        requestId: form.id,
        raw,
      });
      if (questions.length > 0) {
        context.pendingForms.set(form.id, form);
        yield* emit({ ...base, type: "user-input.requested", payload: { questions } });
        return;
      }
      // A form with only external fields sends the user to a URL. T3 Code has
      // no answer to give, so cancel it rather than leave the agent waiting.
      yield* request("session.form.cancel", (signal) =>
        context.client.session.form.cancel(
          { sessionID: form.sessionID, formID: form.id },
          { signal },
        ),
      ).pipe(Effect.ignore);
      yield* emit({
        ...base,
        type: "runtime.warning",
        payload: {
          message: `OpenCode asked for input T3 Code cannot collect: ${form.title}`,
          detail: form,
        },
      });
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCodeSessionContext,
      event: V2Event,
    ) {
      if (event.type === "server.connected") {
        yield* Deferred.succeed(context.firstConnection, undefined).pipe(Effect.ignore);
        return;
      }
      if (event.type === "session.created") {
        const parentId = event.data.parentID;
        if (
          parentId !== undefined &&
          (parentId === context.openCodeSessionId || context.childSessionIds.has(parentId))
        ) {
          context.childSessionIds.add(event.data.sessionID);
          if (context.turnTokenUsage) {
            context.turnTokenUsage.hasSubagents = true;
          }
        }
        return;
      }

      const sessionId = openCodeEventSessionId(event);
      const isParentEvent = sessionId === context.openCodeSessionId;
      if (sessionId === undefined || (!isParentEvent && !context.childSessionIds.has(sessionId))) {
        return;
      }

      const threadId = context.session.threadId;
      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          ...(turnId ? { turnId } : {}),
          ...(isParentEvent ? {} : { childSessionId: sessionId }),
          payload: event,
        },
      });

      // Asks from subagent sessions need the user too. Everything else a
      // subagent emits stays inside its tool item on the parent session.
      switch (event.type) {
        case "permission.asked":
          yield* emitPermissionRequest(context, event.data, event);
          return;
        case "permission.replied": {
          // Replies sent through this adapter are resolved in `respondToRequest`.
          // This covers replies from another OpenCode client.
          const permission = context.pendingPermissions.get(event.data.requestID);
          if (!permission) return;
          context.pendingPermissions.delete(event.data.requestID);
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              requestId: event.data.requestID,
              raw: event,
            })),
            type: "request.resolved",
            payload: {
              requestType: mapPermissionToRequestType(permission.action),
              decision: mapPermissionDecision(event.data.reply),
            },
          });
          return;
        }
        case "form.created":
          yield* emitFormRequest(context, event.data.form, event);
          return;
        case "form.replied":
        case "form.cancelled": {
          if (!context.pendingForms.delete(event.data.id)) return;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              requestId: event.data.id,
              raw: event,
            })),
            type: "user-input.resolved",
            payload: { answers: event.type === "form.replied" ? event.data.answer : {} },
          });
          return;
        }
        default:
          break;
      }
      if (!isParentEvent) {
        return;
      }

      switch (event.type) {
        case "session.inbox.enqueued": {
          if (event.data.item.type === "user" && context.submissions.shift() !== undefined) {
            context.turnInboxIds.add(event.data.inboxID);
          }
          break;
        }
        case "session.inbox.delivered": {
          if (context.turnInboxIds.delete(event.data.inboxID)) {
            context.turnDelivered = true;
          }
          break;
        }
        case "session.inbox.cancelled": {
          context.turnInboxIds.delete(event.data.inboxID);
          break;
        }

        case "session.execution.succeeded": {
          if (
            context.turnDelivered &&
            context.turnInboxIds.size === 0 &&
            context.submissions.length === 0
          ) {
            yield* endOpenCodeTurn(context, { state: "completed" }, event);
          }
          break;
        }
        case "session.execution.interrupted": {
          yield* endOpenCodeTurn(
            context,
            {
              state: "aborted",
              reason:
                event.data.reason === "user"
                  ? "Interrupted by user."
                  : `OpenCode interrupted the turn (${event.data.reason}).`,
            },
            event,
          );
          break;
        }
        case "session.execution.failed": {
          const message = event.data.error.message.trim() || "OpenCode session failed.";
          yield* endOpenCodeTurn(context, { state: "failed", message }, event);
          yield* emit({
            ...(yield* buildEventBase({ threadId, raw: event })),
            type: "runtime.error",
            payload: { message, class: "provider_error", detail: event.data.error },
          });
          break;
        }

        case "session.step.ended": {
          if (context.turnTokenUsage) {
            accumulateOpenCodeStepUsage(context.turnTokenUsage, event.data.tokens);
          }
          break;
        }
        case "session.retry.scheduled": {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.warning",
            payload: {
              message: `OpenCode is retrying the request (attempt ${event.data.attempt}).`,
              detail: event.data.error.message,
            },
          });
          break;
        }

        case "session.text.delta":
        case "session.reasoning.delta": {
          if (event.data.delta.length === 0) break;
          const kind = event.type === "session.text.delta" ? "text" : "reasoning";
          const itemId = `${event.data.assistantMessageID}:${kind}:${event.data.ordinal}`;
          context.streamedItemIds.add(itemId);
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId,
              createdAt: isoFromEpochMs(event.created),
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind: kind === "text" ? "assistant_text" : "reasoning_text",
              delta: event.data.delta,
            },
          });
          break;
        }
        case "session.text.ended":
        case "session.reasoning.ended": {
          const kind = event.type === "session.text.ended" ? "text" : "reasoning";
          const itemId = `${event.data.assistantMessageID}:${kind}:${event.data.ordinal}`;
          const base = yield* buildEventBase({
            threadId,
            turnId,
            itemId,
            createdAt: isoFromEpochMs(event.created),
            raw: event,
          });
          // Providers that do not stream report the whole text only here.
          if (!context.streamedItemIds.has(itemId) && event.data.text.length > 0) {
            yield* emit({
              ...base,
              type: "content.delta",
              payload: {
                streamKind: kind === "text" ? "assistant_text" : "reasoning_text",
                delta: event.data.text,
              },
            });
          }
          if (kind === "text") {
            yield* emit({
              ...base,
              eventId: EventId.make(yield* randomUUIDv4),
              type: "item.completed",
              payload: {
                itemType: "assistant_message",
                status: "completed",
                title: "Assistant message",
                ...(event.data.text.length > 0 ? { detail: event.data.text } : {}),
              },
            });
          }
          break;
        }

        case "session.tool.input.started": {
          context.tools.set(event.data.id, { name: event.data.name });
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: event.data.id,
              createdAt: isoFromEpochMs(event.created),
              raw: event,
            })),
            type: "item.started",
            payload: {
              itemType: toToolLifecycleItemType(event.data.name),
              status: "inProgress",
              title: event.data.name,
              data: { tool: event.data.name },
            },
          });
          break;
        }
        case "session.tool.called":
        case "session.tool.success":
        case "session.tool.failed": {
          const tool = context.tools.get(event.data.id);
          if (!tool) break;
          if (event.type === "session.tool.called") {
            tool.input = event.data.input;
          } else {
            context.tools.delete(event.data.id);
          }
          const itemType = toToolLifecycleItemType(tool.name);
          const result =
            event.type === "session.tool.success" ? toolResultText(event.data.content) : undefined;
          const detail = event.type === "session.tool.failed" ? event.data.error.message : result;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: event.data.id,
              createdAt: isoFromEpochMs(event.created),
              raw: event,
            })),
            type: event.type === "session.tool.called" ? "item.updated" : "item.completed",
            payload: {
              itemType,
              status:
                event.type === "session.tool.called"
                  ? "inProgress"
                  : event.type === "session.tool.success"
                    ? "completed"
                    : "failed",
              title: tool.name,
              ...(detail ? { detail } : {}),
              data: {
                tool: tool.name,
                ...(typeof tool.input?.command === "string" ? { command: tool.input.command } : {}),
                ...(itemType === "file_change" && tool.input ? { input: tool.input } : {}),
                ...(result !== undefined &&
                (itemType === "command_execution" || itemType === "mcp_tool_call")
                  ? { result }
                  : {}),
              },
            },
          });
          break;
        }

        case "session.renamed": {
          yield* emit({
            ...(yield* buildEventBase({ threadId, raw: event })),
            type: "thread.metadata.updated",
            payload: {
              name: event.data.title,
              metadata: { sessionID: context.openCodeSessionId },
            },
          });
          break;
        }
        case "session.compaction.ended": {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "thread.state.changed",
            payload: { state: "compacted", detail: event },
          });
          break;
        }
        case "session.compaction.failed": {
          // ProviderService treats a runtime error as the end of a manual compaction.
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: event })),
            type: "runtime.error",
            payload: {
              message: `OpenCode could not compact the conversation: ${event.data.error.message}`,
              class: "provider_error",
              detail: event.data.error,
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
      const eventsAbortController = new AbortController();

      // Fibers forked into `context.sessionScope` are interrupted
      // automatically when the scope closes — no bookkeeping required.
      yield* Stream.fromAsyncIterable(
        context.client.event.subscribe({ signal: eventsAbortController.signal }),
        (cause) =>
          new OpenCodeRuntimeError({
            operation: "event.subscribe",
            detail: openCodeRuntimeErrorDetail(cause),
            cause,
          }),
      ).pipe(
        Stream.runForEach((event) => handleSubscribedEvent(context, event)),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            // Expected paths: the scope aborted the subscription or the
            // session has already been marked stopped.
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            // The client does not reconnect. ProviderService resumes the
            // session from its cursor on the next message.
            yield* emitUnexpectedExit(
              context,
              Exit.isFailure(exit)
                ? `OpenCode event stream disconnected: ${openCodeRuntimeErrorDetail(Cause.squash(exit.cause))}`
                : "OpenCode event stream ended unexpectedly. Send another message to reconnect.",
            );
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );
      // Scope finalizers run newest first, so this one must be registered
      // after the fork. Interrupting the pump waits for the subscription to
      // return, and the subscription returns only once it is aborted.
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            emitUnexpectedExit(context, `OpenCode server exited unexpectedly (${code}).`),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeResume(input.resumeCursor)?.sessionId;
        const permissions = buildOpenCodePermissionRules(input.runtimeMode);
        const existing = sessions.get(input.threadId);
        if (existing) {
          if (existing.session.status === "connecting" && !(yield* Ref.get(existing.stopped))) {
            return (yield* awaitOpenCodeContextReady(existing)).session;
          }
          yield* stopOpenCodeContext(existing);
          deleteContextIfCurrent(existing);
        }

        const sessionScope = yield* Scope.make();
        const startedExit = yield* Effect.exit(
          Effect.gen(function* () {
            // The runtime binds the server's lifetime to the Scope.Scope
            // we provide below — closing `sessionScope` kills the child
            // process automatically. No manual `server.close()` needed.
            const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
            const server = yield* openCodeRuntime.connectToOpenCodeServer({
              binaryPath: openCodeSettings.binaryPath,
              serverUrl: openCodeSettings.serverUrl,
              ...(openCodeSettings.serverPassword
                ? { serverPassword: openCodeSettings.serverPassword }
                : {}),
              environment: McpProviderSession.withAgentDeviceEnvironment(
                options?.environment ?? process.env,
                mcpSession,
              ),
            });
            const client = openCodeRuntime.createOpenCodeSdkClient({
              baseUrl: server.url,
              ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
            });
            if (mcpSession && !server.external) {
              yield* runOpenCodeSdk("mcp.add", (signal) =>
                client.mcp.add(
                  {
                    server: "t3-code",
                    location: { directory },
                    config: {
                      type: "remote",
                      url: mcpSession.endpoint,
                      headers: { Authorization: mcpSession.authorizationHeader },
                      oauth: false,
                    },
                  },
                  { signal },
                ),
              );
            }

            // Resume: re-adopt the session named by the durable cursor —
            // OpenCode scopes history by session id. The probe recovers only
            // a confirmed not-found (start fresh); transport/auth/server
            // errors propagate instead of masking as a new empty session.
            const adopted = resumeSessionId
              ? yield* runOpenCodeSdk("session.get", (signal) =>
                  client.session.get({ sessionID: resumeSessionId }, { signal }),
                ).pipe(Effect.catchIf(isOpenCodeSessionNotFound, () => Effect.void))
              : undefined;
            if (!adopted) {
              if (resumeSessionId) {
                yield* Effect.logWarning(
                  `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                );
              }
              const model = parseOpenCodeModelSlug(input.modelSelection?.model);
              const created = yield* runOpenCodeSdk("session.create", (signal) =>
                client.session.create(
                  {
                    location: { directory },
                    permissions,
                    ...(input.title ? { title: input.title } : {}),
                    ...(model ? { model } : {}),
                  },
                  { signal },
                ),
              );
              return { server, client, openCodeSession: created, created: true };
            }

            // Resume skips `session.create`, so re-assert the ruleset — a
            // runtime-mode change would otherwise leave the session on its
            // original permissions.
            yield* runOpenCodeSdk("session.update", (signal) =>
              client.session.update({ sessionID: adopted.id, permissions }, { signal }),
            );
            // The thread moved to another cwd (e.g. into a git worktree). Move
            // the session with it so the follow-up keeps its history (#3604).
            // A move is queued like a prompt, so wait for it to land before
            // any turn can be submitted.
            if (!(yield* sameDirectory(adopted.location.directory, directory))) {
              yield* runOpenCodeSdk("session.move", (signal) =>
                client.session.move({ sessionID: adopted.id, directory }, { signal }),
              );
              yield* runOpenCodeSdk("session.wait", (signal) =>
                client.session.wait({ sessionID: adopted.id }, { signal }),
              ).pipe(Effect.timeout(OPENCODE_REQUEST_TIMEOUT));
            }
            return { server, client, openCodeSession: adopted, created: false };
          }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
        );
        if (Exit.isFailure(startedExit)) {
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
          return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
        }
        const started = startedExit.value;

        const createdAt = yield* nowIso;
        const context: OpenCodeSessionContext = {
          session: {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "connecting",
            runtimeMode: input.runtimeMode,
            cwd: directory,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            // ProviderService persists this cursor and feeds it back into
            // `startSession` after the in-memory session is lost (reaper /
            // restart), so follow-ups continue the same conversation (#3604).
            resumeCursor: {
              schemaVersion: OPENCODE_RESUME_VERSION,
              sessionId: started.openCodeSession.id,
            },
            createdAt,
            updatedAt: createdAt,
          },
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSession.id,
          childSessionIds: new Set(),
          pendingPermissions: new Map(),
          pendingForms: new Map(),
          tools: new Map(),
          streamedItemIds: new Set(),
          submissions: [],
          turnInboxIds: new Set(),
          turnDelivered: false,
          turnTokenUsage: undefined,
          activeTurnId: undefined,
          appliedModel: undefined,
          appliedAgent: started.openCodeSession.agent ?? OPENCODE_DEFAULT_AGENT,
          promptSemaphore: Semaphore.makeUnsafe(1),
          firstConnection: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
          stopped: yield* Ref.make(false),
          sessionScope,
        };
        // A start that fails or loses a race owns the session it just created.
        // A resumed session is shared upstream state and stays.
        const cleanupStartingContext = Effect.gen(function* () {
          if (started.created) {
            yield* runOpenCodeSdk("session.remove", (signal) =>
              context.client.session.remove({ sessionID: context.openCodeSessionId }, { signal }),
            ).pipe(Effect.timeout("1 second"), Effect.ignore);
          }
          yield* stopOpenCodeContext(context);
          deleteContextIfCurrent(context);
        });
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          yield* cleanupStartingContext;
          return (yield* awaitOpenCodeContextReady(raceWinner)).session;
        }
        sessions.set(input.threadId, context);

        const connectionExit = yield* Effect.gen(function* () {
          yield* startEventPump(context);
          yield* Deferred.await(context.firstConnection).pipe(
            Effect.timeout(OPENCODE_REQUEST_TIMEOUT),
            Effect.catchTag("TimeoutError", (cause) =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "event.subscribe",
                  detail: `OpenCode event stream did not connect within ${OPENCODE_REQUEST_TIMEOUT}.`,
                  cause,
                }),
              ),
            ),
          );
        }).pipe(
          Effect.onInterrupt(() => cleanupStartingContext),
          Effect.exit,
        );
        if (Exit.isFailure(connectionExit)) {
          yield* cleanupStartingContext;
          return yield* Effect.failCause(connectionExit.cause);
        }
        yield* updateProviderSession(context, { status: "ready" });

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCodeSession.id,
          },
        });

        return context.session;
      },
    );

    /** Validates a model selection against this instance and parses its 'provider/model' slug. */
    const resolveOpenCodeModel = Effect.fn("resolveOpenCodeModel")(function* (
      context: OpenCodeSessionContext,
      operation: string,
      requested: ProviderSendTurnInput["modelSelection"],
    ) {
      const modelSelection =
        requested ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue: `OpenCode model selection is bound to instance '${modelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const model = parseOpenCodeModelSlug(modelSelection?.model);
      if (!modelSelection || !model) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }
      return { modelSelection, model };
    });

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      yield* awaitOpenCodeContextReady(context);
      const { modelSelection, model } = yield* resolveOpenCodeModel(
        context,
        "sendTurn",
        input.modelSelection,
      );

      const text = input.input?.trim() ?? "";
      // OpenCode ingests images, text, and PDFs natively; formats its model
      // paths reject ride only as the prompt's file path line.
      const files = toOpenCodeFiles({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if (text.length === 0 && files.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }
      const commandMatch = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
      const nativeCommand = commandMatch
        ? (yield* loadOpenCodeCommands(context.client, context.directory).pipe(
            Effect.timeout(OPENCODE_REQUEST_TIMEOUT),
            Effect.orElseSucceed(() => []),
          )).find((command) => command.name === commandMatch[1])
        : undefined;

      return yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          if (sessions.get(input.threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }

          const variant = getModelSelectionStringOptionValue(modelSelection, "variant");
          const appliedModel = `${modelSelection.model}#${variant ?? ""}`;
          if (context.appliedModel !== appliedModel) {
            yield* request("session.switchModel", (signal) =>
              context.client.session.switchModel(
                {
                  sessionID: context.openCodeSessionId,
                  model: { ...model, ...(variant ? { variant } : {}) },
                },
                { signal },
              ),
            );
            // OpenCode appends session instructions after its own agent and
            // provider prompts. They name the model, so they follow it.
            yield* request("session.instructions.entry.put", (signal) =>
              context.client.session.instructions.entry.put(
                {
                  sessionID: context.openCodeSessionId,
                  key: OPENCODE_INSTRUCTIONS_KEY,
                  value: buildRuntimeInstructions({
                    harness: "OpenCode",
                    model: modelSelection.model,
                  }),
                },
                { signal },
              ),
            );
            context.appliedModel = appliedModel;
          }

          // OpenCode ships a plan agent only in some builds. Plan mode uses it
          // when it exists and otherwise runs the default agent.
          const selectedAgent = getModelSelectionStringOptionValue(modelSelection, "agent");
          const planAgent =
            selectedAgent === undefined && input.interactionMode === "plan"
              ? (yield* request("agent.list", (signal) =>
                  context.client.agent.list(
                    { location: { directory: context.directory } },
                    { signal },
                  ),
                )).data.find((agent) => agent.id === OPENCODE_PLAN_AGENT)?.id
              : undefined;
          const agent = selectedAgent ?? planAgent ?? OPENCODE_DEFAULT_AGENT;
          if (context.appliedAgent !== agent) {
            yield* request("session.switchAgent", (signal) =>
              context.client.session.switchAgent(
                { sessionID: context.openCodeSessionId, agent },
                { signal },
              ),
            );
            context.appliedAgent = agent;
          }

          // A sendTurn while a turn is active is a steer. OpenCode delivers the
          // prompt into the running execution, so the active turn id is reused.
          const steering = context.activeTurnId !== undefined;
          const turnId =
            context.activeTurnId ?? TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
          if (!steering) {
            context.activeTurnId = turnId;
            context.turnTokenUsage = makeOpenCodeTurnTokenUsageAccumulator();
          }
          yield* updateProviderSession(
            context,
            { status: "running", activeTurnId: turnId, model: modelSelection.model },
            { clearLastError: true },
          );
          if (!steering) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.started",
              payload: { model: modelSelection.model },
            });
          }

          const submission = {};
          context.submissions.push(submission);
          yield* (
            nativeCommand
              ? request("session.command", (signal) =>
                  context.client.session.command(
                    {
                      sessionID: context.openCodeSessionId,
                      name: nativeCommand.name,
                      text: commandMatch?.[2] ?? "",
                      files,
                    },
                    { signal },
                  ),
                )
              : request("session.prompt", (signal) =>
                  context.client.session.prompt(
                    { sessionID: context.openCodeSessionId, text, files },
                    { signal },
                  ),
                )
          ).pipe(
            Effect.tapError((cause) =>
              Effect.gen(function* () {
                const index = context.submissions.indexOf(submission);
                if (index >= 0) context.submissions.splice(index, 1);
                if (steering || context.activeTurnId !== turnId) return;
                yield* endOpenCodeTurn(
                  context,
                  { state: "aborted", reason: cause.detail },
                  undefined,
                );
                yield* updateProviderSession(context, { lastError: cause.detail });
              }),
            ),
          );

          return {
            threadId: input.threadId,
            turnId,
            // Re-surface the durable cursor on every turn so the persisted binding
            // is refreshed alongside last-seen/runtime state (mirrors Grok/Codex).
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
          };
        }),
      );
    });

    const compactThread = Effect.fn("compactThread")(function* (
      threadId: ThreadId,
      requestedModelSelection?: ProviderSendTurnInput["modelSelection"],
    ) {
      const context = yield* ensureSessionContext(sessions, threadId);
      yield* awaitOpenCodeContextReady(context);
      yield* resolveOpenCodeModel(context, "compactThread", requestedModelSelection);
      yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          if (context.activeTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "compactThread",
              issue: "OpenCode cannot compact while a turn is running.",
            });
          }
          // The call only queues the compaction. `session.compaction.ended`
          // and `session.compaction.failed` report how it went.
          yield* request("session.compact", (signal) =>
            context.client.session.compact({ sessionID: context.openCodeSessionId }, { signal }),
          );
        }),
      );
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        if (turnId !== undefined && context.activeTurnId !== turnId) {
          return;
        }
        const { interrupted } = yield* request("session.interrupt", (signal) =>
          context.client.session.interrupt({ sessionID: context.openCodeSessionId }, { signal }),
        );
        if (interrupted) {
          // `session.execution.interrupted` ends the turn.
          return;
        }
        // Nothing was running, so no event will end the turn. Withdraw its
        // queued prompts and end it here.
        yield* Effect.forEach(
          [...context.turnInboxIds],
          (inboxID) =>
            request("session.inbox.cancel", (signal) =>
              context.client.session.inbox.cancel(
                { sessionID: context.openCodeSessionId, inboxID },
                { signal },
              ),
            ).pipe(Effect.ignore),
          { discard: true },
        );
        yield* endOpenCodeTurn(
          context,
          { state: "aborted", reason: "Interrupted by user." },
          undefined,
        );
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const permission = context.pendingPermissions.get(requestId);
      if (!permission) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }

      const reply = toOpenCodePermissionReply(decision);
      yield* request("permission.reply", (signal) =>
        context.client.permission.reply(
          { sessionID: permission.sessionID, requestID: requestId, decision: reply },
          { signal },
        ),
      );
      if (!context.pendingPermissions.delete(requestId)) {
        return;
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId,
          turnId: context.activeTurnId,
          requestId,
          raw: { type: "permission.reply", requestID: requestId, reply },
        })),
        type: "request.resolved",
        payload: {
          requestType: mapPermissionToRequestType(permission.action),
          decision: mapPermissionDecision(reply),
        },
      });
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const form = context.pendingForms.get(requestId);
      if (!form) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.form.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }

      const answer = toOpenCodeFormAnswer(form, answers);
      yield* request("session.form.reply", (signal) =>
        context.client.session.form.reply(
          { sessionID: form.sessionID, formID: form.id, answer },
          { signal },
        ),
      );
      if (!context.pendingForms.delete(requestId)) {
        return;
      }
      yield* emit({
        ...(yield* buildEventBase({
          threadId,
          turnId: context.activeTurnId,
          requestId,
          raw: { type: "session.form.reply", formID: form.id, answer },
        })),
        type: "user-input.resolved",
        payload: { answers: answer },
      });
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCodeContext(context);
        deleteContextIfCurrent(context);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    /** Reads the whole conversation, oldest first. OpenCode pages message lists. */
    const listOpenCodeMessages = Effect.fn("listOpenCodeMessages")(function* (
      context: OpenCodeSessionContext,
    ) {
      const messages: Array<SessionMessageInfo> = [];
      let cursor: string | undefined;
      do {
        const page = yield* request("message.list", (signal) =>
          context.client.message.list(
            // A cursor carries its own order, and OpenCode rejects both together.
            { sessionID: context.openCodeSessionId, ...(cursor ? { cursor } : { order: "asc" }) },
            { signal },
          ),
        );
        messages.push(...page.data);
        cursor = page.cursor.next ?? undefined;
      } while (cursor !== undefined);
      return messages;
    });

    /** A turn is one user message and everything OpenCode produced before the next one. */
    const toTurnSnapshots = (messages: ReadonlyArray<SessionMessageInfo>) => {
      const turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }> = [];
      for (const message of messages) {
        if (message.type === "user") {
          turns.push({ id: TurnId.make(message.id), items: [message] });
        } else {
          turns.at(-1)?.items.push(message);
        }
      }
      return turns;
    };

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        return { threadId, turns: toTurnSnapshots(yield* listOpenCodeMessages(context)) };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const turns = toTurnSnapshots(yield* listOpenCodeMessages(context));
        const firstRemoved = turns[Math.max(0, turns.length - numTurns)];
        if (numTurns <= 0 || !firstRemoved) {
          return { threadId, turns };
        }
        // `files: false` rewinds only the conversation, so T3 alone decides
        // whether filesystem changes survive.
        yield* request("session.revert.stage", (signal) =>
          context.client.session.revert.stage(
            { sessionID: context.openCodeSessionId, messageID: firstRemoved.id, files: false },
            { signal },
          ),
        );
        yield* request("session.revert.commit", (signal) =>
          context.client.session.revert.commit(
            { sessionID: context.openCodeSessionId },
            { signal },
          ),
        );
        return { threadId, turns: toTurnSnapshots(yield* listOpenCodeMessages(context)) };
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        // `stopOpenCodeContext` is typed as never-failing — SDK calls are
        // already `Effect.ignore`'d inside it. `ignoreCause` here also
        // swallows defects from throwing finalizers so one bad close can't
        // interrupt the sibling fibers. Same pattern as the layer finalizer.
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      compaction: { type: "native", start: compactThread },
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
