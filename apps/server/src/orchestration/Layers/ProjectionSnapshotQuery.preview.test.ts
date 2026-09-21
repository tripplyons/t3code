import { ThreadId, THREAD_ACTIVITY_PREVIEW_MAX_CHARS } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolver } from "../../project/RepositoryIdentityResolver.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(Layer.succeed(RepositoryIdentityResolver, { resolve: () => Effect.succeed(null) })),
  Layer.provideMerge(SqlitePersistenceMemory),
);

it.effect("selects bounded recent agent and reasoning previews across snapshots and reverts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const query = yield* ProjectionSnapshotQuery;
    const threadId = ThreadId.make("preview-thread");
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('preview-project', 'Project', '/tmp/preview-project', '[]', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')`;
    yield* sql`INSERT INTO projection_threads
      (thread_id, project_id, title, model_selection_json, created_at, updated_at)
      VALUES (${threadId}, 'preview-project', 'Task', '{"instanceId":"codex","model":"gpt-5"}', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')`;
    const read = Effect.fn(function* () {
      return Option.getOrThrow(yield* query.getThreadShellById(threadId)).recentActivityPreviews;
    });
    const texts = Effect.fn(function* () {
      return (yield* read())?.map((preview) => preview.text);
    });
    assert.deepEqual(yield* read(), []);
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES
      ('assistant', ${threadId}, 'assistant', 'Checking the implementation', 1, '2026-09-19T00:00:01Z', '2026-09-19T00:00:01Z'),
      ('user', ${threadId}, 'user', 'Newer user text is not an agent preview', 0, '2026-09-19T00:00:09Z', '2026-09-19T00:00:09Z'),
      ('empty', ${threadId}, 'assistant', '', 1, '2026-09-19T00:00:10Z', '2026-09-19T00:00:10Z')`;
    assert.deepEqual(yield* read(), [
      { kind: "agent", text: "Checking the implementation", createdAt: "2026-09-19T00:00:01Z" },
    ]);
    yield* sql`UPDATE projection_thread_messages SET text = text || ' and tests' WHERE message_id = 'assistant'`;
    assert.deepEqual(yield* texts(), ["Checking the implementation and tests"]);
    yield* sql`INSERT INTO projection_thread_activities
      (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('tool', ${threadId}, 'tool', 'tool.completed', 'vp test run', '{"data":"large output stays out of the shell"}', '2026-09-19T00:00:11Z')`;
    assert.deepEqual(yield* texts(), ["Checking the implementation and tests"]);
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES
      ('reasoning:summary:1', ${threadId}, 'reasoning', 'Weighing the fix', 0, '2026-09-19T00:00:12Z', '2026-09-19T00:00:12Z'),
      ('assistant-2', ${threadId}, 'assistant', 'Fix applied', 0, '2026-09-19T00:00:13Z', '2026-09-19T00:00:13Z'),
      ('reasoning:summary:2', ${threadId}, 'reasoning', 'Planning the tests', 1, '2026-09-19T00:00:14Z', '2026-09-19T00:00:14Z')`;
    // Newest first, and the oldest of four drops off.
    const expected = [
      { kind: "reasoning", text: "Planning the tests", createdAt: "2026-09-19T00:00:14Z" },
      { kind: "agent", text: "Fix applied", createdAt: "2026-09-19T00:00:13Z" },
      { kind: "reasoning", text: "Weighing the fix", createdAt: "2026-09-19T00:00:12Z" },
    ] as const;
    assert.deepEqual(yield* read(), expected);
    assert.deepEqual(
      (yield* query.getShellSnapshot()).threads[0]?.recentActivityPreviews,
      expected,
    );
    // A long Unicode result must remain bounded and decode without losing the shell.
    const longText = "🧪".repeat(10_000);
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('result', ${threadId}, 'assistant', ${longText}, 0, '2026-09-19T00:00:30Z', '2026-09-19T00:00:30Z')`;
    assert.equal((yield* texts())?.[0], "🧪".repeat(THREAD_ACTIVITY_PREVIEW_MAX_CHARS));
    yield* sql`UPDATE projection_threads SET archived_at = '2026-09-19T00:00:31Z' WHERE thread_id = ${threadId}`;
    assert.equal(
      (yield* query.getArchivedShellSnapshot()).threads[0]?.recentActivityPreviews?.[0]?.text,
      "🧪".repeat(THREAD_ACTIVITY_PREVIEW_MAX_CHARS),
    );
    yield* sql`UPDATE projection_threads SET archived_at = NULL WHERE thread_id = ${threadId}`;
    // Revert removes records; the previews must follow the remaining history.
    yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'result'`;
    assert.deepEqual(yield* read(), expected);
    yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
    assert.deepEqual(yield* read(), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("reads previews through the partial message index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT text FROM projection_thread_messages
      WHERE thread_id = 'thread' AND role IN ('assistant', 'reasoning') AND text <> ''
      ORDER BY created_at DESC, message_id DESC LIMIT 3`;
    assert.include(plan.map((row) => row.detail).join("\n"), "idx_thread_preview_message");
  }).pipe(Effect.provide(layer)),
);
