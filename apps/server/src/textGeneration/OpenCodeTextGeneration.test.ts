import { OpenCodeSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as NetService from "@t3tools/shared/Net";
import { beforeEach, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as OpenCodeRuntime from "../provider/opencodeRuntime.ts";
import * as OpenCodeServerOwner from "../provider/OpenCodeServerOwner.ts";
import * as OpenCodeTextGeneration from "./OpenCodeTextGeneration.ts";
import * as TextGeneration from "./TextGeneration.ts";

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    generateUrls: [] as string[],
    generateInputs: [] as Array<{ readonly prompt: string; readonly model?: unknown }>,
    authHeaders: [] as Array<string | null>,
    closeCalls: [] as string[],
    connectionError: undefined as Error | undefined,
    generateError: undefined as unknown,
    generatedText: undefined as string | undefined,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.generateUrls.length = 0;
    this.state.generateInputs.length = 0;
    this.state.authHeaders.length = 0;
    this.state.closeCalls.length = 0;
    this.state.connectionError = undefined;
    this.state.generateError = undefined;
    this.state.generatedText = undefined;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntime.OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath, serverPassword, environment }) =>
    Effect.gen(function* () {
      const index = runtimeMock.state.startCalls.length + 1;
      const url = `http://127.0.0.1:${4_300 + index}`;
      runtimeMock.state.startCalls.push(binaryPath);
      // The production runtime binds server lifetime to the caller's scope.
      // Mirror that here so the closeCalls probe observes scope close.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      const effectiveServerPassword = OpenCodeRuntime.resolveOpenCodeServerPassword({
        external: false,
        ...(serverPassword !== undefined ? { serverPassword } : {}),
        ...(environment !== undefined ? { environment } : {}),
      });
      return {
        url,
        ...(effectiveServerPassword !== undefined
          ? { serverPassword: effectiveServerPassword }
          : {}),
        version: "2.0.8",
        isRunning: Effect.succeed(true),
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    runtimeMock.state.connectionError
      ? Effect.fail(
          new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: "server.info",
            detail: runtimeMock.state.connectionError.message,
            cause: runtimeMock.state.connectionError,
          }),
        )
      : Effect.succeed({
          url: serverUrl ?? "http://127.0.0.1:4301",
          ...(serverPassword ? { serverPassword } : {}),
          version: "2.0.8",
          exitCode: null,
          external: Boolean(serverUrl),
        }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      generate: {
        text: async (input: { readonly prompt: string; readonly model?: unknown }) => {
          runtimeMock.state.generateUrls.push(baseUrl);
          runtimeMock.state.generateInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          if (runtimeMock.state.generateError !== undefined) {
            throw runtimeMock.state.generateError;
          }
          return {
            text:
              runtimeMock.state.generatedText ??
              JSON.stringify({
                subject: "Improve OpenCode reuse",
                body: "Reuse one server for the full action.",
              }),
          };
        },
      },
    }) as unknown as ReturnType<OpenCodeRuntime.OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
  loadOpenCodeSkills: () => Effect.succeed([]),
};

const DEFAULT_TEST_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "openai/gpt-5",
};
const DEFAULT_COMMIT_MESSAGE_INPUT = {
  cwd: process.cwd(),
  branch: "feature/opencode-reuse",
  stagedSummary: "M README.md",
  stagedPatch: "diff --git a/README.md b/README.md",
  modelSelection: DEFAULT_TEST_MODEL_SELECTION,
};

const OPENCODE_TEXT_GENERATION_IDLE_TTL_MS = 30_000;

const OpenCodeTextGenerationTestLayer = Layer.succeed(
  OpenCodeRuntime.OpenCodeRuntime,
  OpenCodeRuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const OpenCodeTextGenerationExistingServerTestLayer = Layer.succeed(
  OpenCodeRuntime.OpenCodeRuntime,
  OpenCodeRuntimeTestDouble,
).pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), {
      prefix: "t3code-opencode-text-generation-existing-server-test-",
    }),
  ),
  Layer.provideMerge(NetService.layer),
  Layer.provideMerge(NodeServices.layer),
);

const DEFAULT_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
});
const LOCAL_AUTH_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverPassword: "secret-password",
});
const EXISTING_SERVER_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});
const EXTERNAL_SERVER_WITHOUT_AUTH_OPENCODE_SETTINGS = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
});

function withOpenCodeTextGeneration<A, E, R>(
  settings: OpenCodeSettings,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
  environment?: NodeJS.ProcessEnv,
) {
  return Effect.gen(function* () {
    const serverOwner = yield* OpenCodeServerOwner.make({
      binaryPath: settings.binaryPath,
      ...(settings.serverPassword ? { serverPassword: settings.serverPassword } : {}),
      ...(environment ? { environment } : {}),
    });
    const textGeneration = yield* OpenCodeTextGeneration.makeOpenCodeTextGeneration(settings).pipe(
      Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, serverOwner),
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

beforeEach(() => {
  runtimeMock.reset();
});

const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(OPENCODE_TEXT_GENERATION_IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

it.layer(OpenCodeTextGenerationTestLayer)("OpenCodeTextGeneration", (it) => {
  it.effect("sends one prompt with the selected model and variant", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.generatedText = '{"title":"Review uploaded report"}';

        const result = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Review this report.",
          modelSelection: {
            ...DEFAULT_TEST_MODEL_SELECTION,
            options: [{ id: "variant", value: "high" }],
          },
        });

        expect(result.title).toBe("Review uploaded report");
        expect(runtimeMock.state.generateInputs).toEqual([
          {
            prompt: expect.stringContaining("Review this report."),
            model: { providerID: "openai", id: "gpt-5", variant: "high" },
          },
        ]);
      }),
    ),
  );

  it.effect("passes configured authentication to a locally spawned server", () =>
    withOpenCodeTextGeneration(LOCAL_AUTH_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT);

        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode"]);
        expect(runtimeMock.state.authHeaders).toEqual([
          `Basic ${btoa("opencode:secret-password")}`,
        ]);
      }),
    ),
  );

  it.effect("uses an environment-only password for a locally spawned server", () =>
    withOpenCodeTextGeneration(
      DEFAULT_OPENCODE_SETTINGS,
      (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT);

          expect(runtimeMock.state.authHeaders).toEqual([
            `Basic ${btoa("opencode:environment-password")}`,
          ]);
        }),
      { OPENCODE_SERVER_PASSWORD: "environment-password" },
    ),
  );

  it.effect("uses settings auth when the local environment password differs", () =>
    withOpenCodeTextGeneration(
      LOCAL_AUTH_OPENCODE_SETTINGS,
      (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT);

          expect(runtimeMock.state.authHeaders).toEqual([
            `Basic ${btoa("opencode:secret-password")}`,
          ]);
        }),
      { OPENCODE_SERVER_PASSWORD: "environment-password" },
    ),
  );

  it.effect("reuses a warm server across back-to-back requests and closes it after idling", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode"]);
        expect(runtimeMock.state.generateUrls).toEqual([
          "http://127.0.0.1:4301",
          "http://127.0.0.1:4301",
        ]);
        expect(runtimeMock.state.closeCalls).toEqual([]);

        yield* advanceIdleClock;

        expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("starts a new server after the warm server idles out", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        yield* advanceIdleClock;

        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(runtimeMock.state.startCalls).toEqual(["fake-opencode", "fake-opencode"]);
        expect(runtimeMock.state.generateUrls).toEqual([
          "http://127.0.0.1:4301",
          "http://127.0.0.1:4302",
        ]);
        expect(runtimeMock.state.closeCalls).toEqual(["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("preserves the client cause and request context when generation fails", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        const clientCause = { _tag: "ServiceUnavailableError", message: "model unavailable" };
        runtimeMock.state.generateError = clientCause;

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.message).toContain("model unavailable");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationRequestError",
          operation: "generateCommitMessage",
          providerId: "openai",
          modelId: "gpt-5",
        });
        expect((error.cause as { cause: { cause: unknown } }).cause.cause).toBe(clientCause);
      }),
    ),
  );

  it.effect("returns a typed empty-output error for blank text", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.generatedText = "   ";

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode returned empty output.");
        expect(error.cause).toMatchObject({
          _tag: "OpenCodeTextGenerationEmptyOutputError",
          operation: "generateCommitMessage",
          providerId: "openai",
          modelId: "gpt-5",
        });
        expect(error.cause).not.toHaveProperty("cause");
      }),
    ),
  );

  it.effect("rejects output that does not match the requested structure", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.generatedText = "I could not write a commit message.";

        const error = yield* textGeneration
          .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
          .pipe(Effect.flip);

        expect(error.message).toContain("OpenCode returned invalid structured output.");
      }),
    ),
  );

  it.effect("parses JSON returned as plain text output", () =>
    withOpenCodeTextGeneration(DEFAULT_OPENCODE_SETTINGS, (textGeneration) =>
      Effect.gen(function* () {
        runtimeMock.state.generatedText =
          'Here is the result:\n{"subject":"Tighten OpenCode parsing","body":"Handle JSON text output locally."}';

        const result = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/opencode-reuse",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(result).toEqual({
          subject: "Tighten OpenCode parsing",
          body: "Handle JSON text output locally.",
        });
      }),
    ),
  );
});

it.layer(OpenCodeTextGenerationExistingServerTestLayer)(
  "OpenCodeTextGeneration with configured server URL",
  (it) => {
    it.effect("does not send a local environment password to a configured server", () =>
      withOpenCodeTextGeneration(
        EXTERNAL_SERVER_WITHOUT_AUTH_OPENCODE_SETTINGS,
        (textGeneration) =>
          Effect.gen(function* () {
            yield* textGeneration.generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT);
            expect(runtimeMock.state.authHeaders).toEqual([null]);
          }),
        { OPENCODE_SERVER_PASSWORD: "local-secret" },
      ),
    );

    it.effect("does not generate text when the server version is unsupported", () =>
      withOpenCodeTextGeneration(EXISTING_SERVER_OPENCODE_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
          runtimeMock.state.connectionError = new Error(
            "OpenCode v1.14.19 is too old. Upgrade to v2.0.0 or newer.",
          );

          const error = yield* textGeneration
            .generateCommitMessage(DEFAULT_COMMIT_MESSAGE_INPUT)
            .pipe(Effect.flip);

          expect(error).toBeInstanceOf(TextGenerationError);
          expect(error.message).toContain("v1.14.19 is too old");
          expect(runtimeMock.state.generateInputs).toEqual([]);
        }),
      ),
    );

    it.effect("reuses a configured OpenCode server URL without spawning or applying idle TTL", () =>
      withOpenCodeTextGeneration(EXISTING_SERVER_OPENCODE_SETTINGS, (textGeneration) =>
        Effect.gen(function* () {
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });
          yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/opencode-reuse",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(runtimeMock.state.startCalls).toEqual([]);
          expect(runtimeMock.state.generateUrls).toEqual([
            "http://127.0.0.1:9999",
            "http://127.0.0.1:9999",
          ]);
          expect(runtimeMock.state.authHeaders).toEqual([
            `Basic ${btoa("opencode:secret-password")}`,
            `Basic ${btoa("opencode:secret-password")}`,
          ]);

          yield* advanceIdleClock;

          expect(runtimeMock.state.closeCalls).toEqual([]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  },
);
