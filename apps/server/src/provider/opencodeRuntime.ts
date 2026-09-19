import * as NodeURL from "node:url";

import type {
  ChatAttachment,
  ProviderApprovalDecision,
  RuntimeMode,
  UserInputQuestion,
} from "@t3tools/contracts";
import {
  OpenCode,
  type AgentInfo,
  type CommandInfo,
  type FormInfo,
  type ModelInfo,
  type OpenCodeClient,
  type PermissionRuleset,
  type ProviderInfo,
  type SessionFormReplyInput,
  type SessionPromptInput,
  type SkillInfo,
} from "@opencode/client";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export const MINIMUM_OPENCODE_VERSION = "2.0.0";
const OPENCODE_SERVER_INFO_TIMEOUT = "5 seconds";
const OPENCODE_INVENTORY_WARMUP_ATTEMPTS = 40;
const OPENCODE_INVENTORY_WARMUP_INTERVAL = "250 millis";

export function resolveOpenCodeServerPassword(
  input: {
    readonly external: boolean;
    readonly serverPassword?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (input.serverPassword !== undefined) {
    return input.serverPassword;
  }
  if (input.external) {
    return undefined;
  }
  return input.environment === undefined
    ? inheritedEnvironment.OPENCODE_SERVER_PASSWORD
    : input.environment.OPENCODE_SERVER_PASSWORD;
}

const OPENCODE_SERVER_READY_PREFIX = "server listening";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS = 64 * 1024;
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly isRunning: Effect.Effect<boolean>;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) {
    // ClientError only names the failure class; the transport error is its cause.
    const inner = cause.cause instanceof Error ? cause.cause.message.trim() : "";
    return inner.length > 0 ? `${cause.message.trim()}: ${inner}` : cause.message.trim();
  }
  if (cause && typeof cause === "object") {
    // The OpenCode API rejects with its tagged error body, e.g.
    // { _tag: "SessionNotFoundError", message }.
    if ("message" in cause && typeof cause.message === "string" && cause.message.trim()) {
      return cause.message.trim();
    }
    const encoded = encodeJsonStringForDiagnostics(cause);
    if (encoded) return encoded;
  }
  return String(cause);
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export const verifyOpenCodeServerVersion = Effect.fn("verifyOpenCodeServerVersion")(function* (
  client: OpenCodeClient,
) {
  const infoOption = yield* runOpenCodeSdk("server.info", (signal) =>
    client.server.info({ signal }),
  ).pipe(Effect.timeoutOption(OPENCODE_SERVER_INFO_TIMEOUT));
  if (Option.isNone(infoOption)) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: "Timed out while checking the OpenCode server version.",
    });
  }

  const version = infoOption.value.version;
  if (parseSemver(version) === null) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode server returned an invalid version. T3 Code requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  if (compareSemverVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  return version;
});

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providers: ReadonlyArray<ProviderInfo>;
  readonly models: ReadonlyArray<ModelInfo>;
  readonly agents: ReadonlyArray<AgentInfo>;
  readonly skills: ReadonlyArray<SkillInfo>;
  readonly commands: ReadonlyArray<CommandInfo>;
}

/** Command templates stay in OpenCode, which expands arguments and runs MCP prompts. */
export const loadOpenCodeCommands = (client: OpenCodeClient, directory: string) =>
  runOpenCodeSdk("command.list", (signal) =>
    client.command.list({ location: { directory } }, { signal }),
  ).pipe(Effect.map((result) => result.data));

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly id: string;
}

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly maxOutputBytes?: number;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly serverPassword?: string;
  }) => OpenCodeClient;
  readonly loadOpenCodeInventory: (
    client: OpenCodeClient,
    directory: string,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadOpenCodeSkills: (
    client: OpenCodeClient,
    directory: string,
  ) => Effect.Effect<ReadonlyArray<SkillInfo>, OpenCodeRuntimeError>;
}

function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_READY_PREFIX)) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    id: trimmed.slice(separator + 1),
  };
}

/**
 * Attachments OpenCode can hand to a model as a native file. Anything
 * else (ZIP, binaries, image formats like BMP/AVIF/SVG that model APIs
 * reject, or files over the direct-attachment size limit) would make the turn
 * fail before it starts, so those ride only as the file path ProviderService
 * puts in the prompt.
 */
const OPENCODE_NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OPENCODE_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

function isOpenCodeNativeFilePart(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  if (input.sizeBytes > OPENCODE_NATIVE_FILE_PART_MAX_BYTES) {
    return false;
  }
  const normalized = input.mimeType.trim().toLowerCase();
  return (
    OPENCODE_NATIVE_IMAGE_MIMES.has(normalized) ||
    normalized.startsWith("text/") ||
    normalized === "application/pdf"
  );
}

export function toOpenCodeFiles(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): NonNullable<SessionPromptInput["files"]> {
  const files: Array<{ readonly uri: string; readonly name: string }> = [];

  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    if (!isOpenCodeNativeFilePart(attachment)) {
      continue;
    }
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    files.push({ uri: NodeURL.pathToFileURL(attachmentPath).href, name: attachment.name });
  }

  return files;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [{ action: "*", resource: "*", effect: "allow" }];
  }

  // "Auto-accept edits" is documented as "auto-approve edits, ask before other
  // actions", so prompting for every edit ignores the mode the user picked.
  // "auto" is left asking on purpose: the docs say providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for that mode.
  const editEffect = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  // Session rules override OpenCode's agent defaults, and the last matching
  // rule wins. Ask by default, allow read-only tools, and keep OpenCode's
  // default approval rules for environment files.
  return [
    { action: "*", resource: "*", effect: "ask" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "skill", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "allow" },
    { action: "edit", resource: "*", effect: editEffect },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

type OpenCodeFormField = FormInfo["fields"][number];
type OpenCodeAnswerableField = Exclude<OpenCodeFormField, { readonly type: "external" }>;

const BOOLEAN_FORM_OPTIONS = [
  { label: "Yes", description: "", value: "true" },
  { label: "No", description: "", value: "false" },
];

/** Fields T3 Code can ask about: external fields only link out and take no typed answer. */
function answerableFormFields(form: FormInfo): Array<OpenCodeAnswerableField> {
  return form.fields.filter(
    (field): field is OpenCodeAnswerableField => field.type !== "external" && !field.hidden,
  );
}

function formFieldOptions(field: OpenCodeAnswerableField): UserInputQuestion["options"] {
  if (field.type === "boolean") return BOOLEAN_FORM_OPTIONS;
  if (field.type !== "string" && field.type !== "multiselect") return [];
  return (field.options ?? []).map((option) => ({
    label: option.label,
    description: option.description ?? "",
    value: option.value,
  }));
}

/** OpenCode asks the user through forms. Each answerable field becomes one question, keyed by the field key. */
export function toUserInputQuestions(form: FormInfo): Array<UserInputQuestion> {
  return answerableFormFields(form).map((field) => {
    const options = formFieldOptions(field);
    const header = field.title?.trim() || form.title.trim() || field.key;
    return {
      id: field.key,
      header,
      question: field.description?.trim() || header,
      options,
      allowCustomAnswer:
        options.length === 0 ||
        ((field.type === "string" || field.type === "multiselect") && field.custom === true),
      multiSelect: field.type === "multiselect",
    };
  });
}

/** Maps T3 answers, which carry option values or custom text, to the type each form field expects. */
export function toOpenCodeFormAnswer(
  form: FormInfo,
  answers: Record<string, unknown>,
): SessionFormReplyInput["answer"] {
  const answer: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  for (const field of answerableFormFields(form)) {
    const raw = answers[field.key];
    const selected = (Array.isArray(raw) ? raw : [raw]).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    const first = selected.at(0);
    if (first === undefined) continue;

    switch (field.type) {
      case "boolean":
        answer[field.key] = first === "true";
        break;
      case "number":
      case "integer": {
        const parsed = Number(first);
        if (Number.isFinite(parsed)) answer[field.key] = parsed;
        break;
      }
      case "string":
        answer[field.key] = first;
        break;
      case "multiselect":
        answer[field.key] = selected;
        break;
    }
  }
  return answer;
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const terminateCommandGroup =
        hostPlatform === "win32"
          ? child.kill({ killSignal: "SIGKILL" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), "SIGKILL");
              } catch {
                // The command and its process group may already have exited.
              }
            });
      yield* Effect.addFinalizer(() => terminateCommandGroup.pipe(Effect.ignore));
      const collectOptions =
        input.maxOutputBytes === undefined ? undefined : { maxBytes: input.maxOutputBytes };
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout, collectOptions),
          collectStreamAsString(child.stderr, collectOptions),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    OpenCode.make({
      baseUrl: input.baseUrl,
      ...(input.serverPassword
        ? {
            headers: {
              authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
    });

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);
      // OpenCode always protects its server. Left without a password it
      // invents one and only prints it, so T3 Code supplies its own.
      const serverPassword =
        resolveOpenCodeServerPassword({
          external: false,
          ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
          ...(input.environment !== undefined ? { environment: input.environment } : {}),
        }) ||
        (yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to generate a server password: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            env: { ...input.environment, OPENCODE_SERVER_PASSWORD: serverPassword },
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make<string | null>("");
      const stderrRef = yield* Ref.make<string | null>("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.modify(stdoutRef, (stdout) => {
          if (stdout === null) {
            return [null, null] as const;
          }
          const nextStdout = `${stdout}${chunk}`;
          return [
            parseServerUrlFromOutput(nextStdout),
            nextStdout.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ] as const;
        }).pipe(
          Effect.flatMap((parsed) =>
            parsed ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore) : Effect.void,
          ),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrRef, (stderr) =>
            stderr === null
              ? null
              : `${stderr}${chunk}`.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = (yield* Ref.get(stdoutRef)) ?? "";
            const stderr = (yield* Ref.get(stderrRef)) ?? "";
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      if (Exit.isFailure(readyExit) || Option.isNone(readyExit.value)) {
        yield* Fiber.interruptAll([stdoutFiber, stderrFiber, exitFiber]).pipe(Effect.ignore);
      }

      if (Exit.isFailure(readyExit)) {
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      // Keep draining both pipes until the process scope closes. Stopping the
      // readers can block OpenCode when its output buffers fill. Startup output
      // is no longer needed, so discard later output instead of retaining it.
      yield* Ref.set(stdoutRef, null);
      yield* Ref.set(stderrRef, null);

      const url = readyOption.value;
      const version = yield* verifyOpenCodeServerVersion(
        createOpenCodeSdkClient({ baseUrl: url, serverPassword }),
      );

      return {
        url,
        serverPassword,
        version,
        isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = resolveOpenCodeServerPassword({
        external: true,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      });
      return verifyOpenCodeServerVersion(
        createOpenCodeSdkClient({
          baseUrl: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
      ).pipe(
        Effect.map((version) => ({
          url: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
          version,
          exitCode: null,
          external: true,
        })),
      );
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        version: server.version,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  // A location boots lazily, so its model list can be empty right after the
  // first request. An install with no models at all is not usable either way.
  const loadModels = (client: OpenCodeClient, directory: string) =>
    runOpenCodeSdk("model.list", (signal) =>
      client.model.list({ location: { directory } }, { signal }),
    ).pipe(
      Effect.map((result) => result.data),
      Effect.repeat({
        until: (models) => models.length > 0,
        times: OPENCODE_INVENTORY_WARMUP_ATTEMPTS,
        schedule: Schedule.spaced(OPENCODE_INVENTORY_WARMUP_INTERVAL),
      }),
    );

  const loadOpenCodeSkills: OpenCodeRuntimeShape["loadOpenCodeSkills"] = (client, directory) =>
    runOpenCodeSdk("skill.list", (signal) =>
      client.skill.list({ location: { directory } }, { signal }),
    ).pipe(Effect.map((result) => result.data));

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (
    client,
    directory,
  ) =>
    Effect.gen(function* () {
      // Models load first because they wait out the location boot. The other
      // lists are already warm by then.
      const models = yield* loadModels(client, directory);
      const [providers, agents, skills, commands] = yield* Effect.all(
        [
          runOpenCodeSdk("provider.list", (signal) =>
            client.provider.list({ location: { directory } }, { signal }),
          ).pipe(Effect.map((result) => result.data)),
          runOpenCodeSdk("agent.list", (signal) =>
            client.agent.list({ location: { directory } }, { signal }),
          ).pipe(
            Effect.map((result) => result.data),
            Effect.orElseSucceed((): ReadonlyArray<AgentInfo> => []),
          ),
          loadOpenCodeSkills(client, directory).pipe(
            Effect.orElseSucceed((): ReadonlyArray<SkillInfo> => []),
          ),
          loadOpenCodeCommands(client, directory).pipe(
            Effect.orElseSucceed((): ReadonlyArray<CommandInfo> => []),
          ),
        ],
        { concurrency: "unbounded" },
      );
      return { providers, models, agents, skills, commands };
    });

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    loadOpenCodeSkills,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "t3/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
