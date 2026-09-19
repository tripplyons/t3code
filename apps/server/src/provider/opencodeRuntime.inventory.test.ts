import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpenCodeClient } from "@opencode/client";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HostProcessExecutablePath } from "@t3tools/shared/hostProcess";

import { OpenCodeRuntime, OpenCodeRuntimeLive } from "./opencodeRuntime.ts";

const testLayer = OpenCodeRuntimeLive.pipe(Layer.provideMerge(NodeServices.layer));

const MODEL = { id: "gpt-test", providerID: "openai", name: "GPT Test", enabled: true };

type ListInput = { readonly location: { readonly directory: string } };
type List = (input: ListInput, options: { readonly signal: AbortSignal }) => Promise<unknown>;

function makeInventoryClient(lists: {
  readonly model?: List;
  readonly provider?: List;
  readonly agent?: List;
  readonly skill?: List;
  readonly command?: List;
}): OpenCodeClient {
  const empty: List = () => Promise.resolve({ data: [] });
  return {
    model: { list: lists.model ?? (() => Promise.resolve({ data: [MODEL] })) },
    provider: { list: lists.provider ?? empty },
    agent: { list: lists.agent ?? empty },
    skill: { list: lists.skill ?? empty },
    command: { list: lists.command ?? empty },
  } as unknown as OpenCodeClient;
}

it.layer(testLayer)("OpenCodeRuntime inventory", (it) => {
  it.effect("aborts pending SDK requests when inventory loading is interrupted", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const started = yield* Queue.make<void>();
      const aborted = yield* Queue.make<string>();
      const pending =
        (name: string): List =>
        (_input, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                Queue.offerUnsafe(aborted, name);
                reject(signal.reason);
              },
              { once: true },
            );
            Queue.offerUnsafe(started, undefined);
          });
      const client = makeInventoryClient({
        provider: pending("provider"),
        agent: pending("agent"),
        skill: pending("skill"),
        command: pending("command"),
      });

      const inventoryFiber = yield* runtime
        .loadOpenCodeInventory(client, "/workspace/project")
        .pipe(Effect.forkChild);
      yield* Queue.takeN(started, 4);
      yield* Fiber.interrupt(inventoryFiber);

      NodeAssert.deepEqual((yield* Queue.takeAll(aborted)).toSorted(), [
        "agent",
        "command",
        "provider",
        "skill",
      ]);
    }),
  );

  it.effect("scopes every list to the workspace directory", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const directories: Array<string> = [];
      const record =
        (data: ReadonlyArray<unknown>): List =>
        (input) => {
          directories.push(input.location.directory);
          return Promise.resolve({ data });
        };
      const command = { name: "review", description: "Review changes" };
      const client = makeInventoryClient({
        model: record([MODEL]),
        provider: record([]),
        agent: record([]),
        skill: record([]),
        command: record([command]),
      });

      const inventory = yield* runtime.loadOpenCodeInventory(client, "/workspace/project");

      NodeAssert.deepEqual(inventory.models, [MODEL]);
      NodeAssert.deepEqual(inventory.commands, [command]);
      NodeAssert.deepEqual(directories, Array(5).fill("/workspace/project"));
    }),
  );

  it.effect("keeps the model inventory when agent, skill and command discovery fail", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const unavailable: List = () => Promise.reject(new Error("endpoint unavailable"));
      const client = makeInventoryClient({
        agent: unavailable,
        skill: unavailable,
        command: unavailable,
      });

      const inventory = yield* runtime.loadOpenCodeInventory(client, "/workspace/project");

      NodeAssert.deepEqual(inventory.models, [MODEL]);
      NodeAssert.deepEqual(inventory.agents, []);
      NodeAssert.deepEqual(inventory.skills, []);
      NodeAssert.deepEqual(inventory.commands, []);
    }),
  );

  it.effect("caps and drains command stdout and stderr when requested", () =>
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      const executablePath = yield* HostProcessExecutablePath;
      const outputBytes = 2 * 1024 * 1024;
      const result = yield* runtime.runOpenCodeCommand({
        binaryPath: executablePath,
        args: [
          "-e",
          `process.stdout.write("o".repeat(${outputBytes})); process.stderr.write("e".repeat(${outputBytes}));`,
        ],
        maxOutputBytes: 64,
      });

      NodeAssert.equal(result.stdout, "o".repeat(64));
      NodeAssert.equal(result.stderr, "e".repeat(64));
      NodeAssert.equal(result.code, 0);
    }),
  );
});
