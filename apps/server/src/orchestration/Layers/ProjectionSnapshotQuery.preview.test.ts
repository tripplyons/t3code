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

it.effect("selects bounded agent/tool previews across snapshots, live refetches, and reverts", () =>
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
      return Option.getOrThrow(yield* query.getThreadShellById(threadId)).latestActivityPreview;
    });
    assert.isNull(yield* read());
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES
      ('assistant', ${threadId}, 'assistant', 'Checking the implementation', 1, '2026-09-19T00:00:01Z', '2026-09-19T00:00:01Z'),
      ('user', ${threadId}, 'user', 'Newer user text is not an agent preview', 0, '2026-09-19T00:00:09Z', '2026-09-19T00:00:09Z'),
      ('empty', ${threadId}, 'assistant', '', 1, '2026-09-19T00:00:10Z', '2026-09-19T00:00:10Z')`;
    assert.deepEqual(yield* read(), {
      kind: "agent",
      text: "Checking the implementation",
      createdAt: "2026-09-19T00:00:01Z",
    });
    yield* sql`UPDATE projection_thread_messages SET text = text || ' and tests' WHERE message_id = 'assistant'`;
    assert.equal((yield* read())?.text, "Checking the implementation and tests");
    for (const [index, kind] of ["tool.started", "tool.updated", "tool.completed"].entries()) {
      const createdAt = `2026-09-19T00:00:0${index + 2}Z`;
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
        VALUES (${kind}, ${threadId}, 'tool', ${kind}, 'vp test run', '{"data":"large output stays out of the shell"}', ${createdAt})`;
      const expected = { kind: "tool", text: "vp test run", createdAt };
      assert.deepEqual(yield* read(), expected);
      assert.deepEqual(
        (yield* query.getShellSnapshot()).threads[0]?.latestActivityPreview,
        expected,
      );
    }
    yield* sql`INSERT INTO projection_thread_activities
      (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('noise', ${threadId}, 'info', 'context-window.updated', 'Not a tool call', '{}', '2026-09-19T00:00:20Z')`;
    assert.equal((yield* read())?.text, "vp test run");
    // A long Unicode result must remain bounded and decode without losing the shell.
    const longText = "🧪".repeat(10_000);
    yield* sql`INSERT INTO projection_thread_messages
      (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('result', ${threadId}, 'assistant', ${longText}, 0, '2026-09-19T00:00:30Z', '2026-09-19T00:00:30Z')`;
    assert.equal((yield* read())?.text, "🧪".repeat(THREAD_ACTIVITY_PREVIEW_MAX_CHARS));
    yield* sql`UPDATE projection_threads SET archived_at = '2026-09-19T00:00:31Z' WHERE thread_id = ${threadId}`;
    assert.equal(
      (yield* query.getArchivedShellSnapshot()).threads[0]?.latestActivityPreview?.text,
      "🧪".repeat(THREAD_ACTIVITY_PREVIEW_MAX_CHARS),
    );
    yield* sql`UPDATE projection_threads SET archived_at = NULL WHERE thread_id = ${threadId}`;
    // Revert removes records; the preview must follow the remaining history.
    yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'result'`;
    assert.equal((yield* read())?.kind, "tool");
    yield* sql`DELETE FROM projection_thread_activities WHERE thread_id = ${threadId}`;
    assert.equal((yield* read())?.kind, "agent");
    yield* sql`DELETE FROM projection_thread_messages WHERE thread_id = ${threadId}`;
    assert.isNull(yield* read());
  }).pipe(Effect.provide(layer)),
);
