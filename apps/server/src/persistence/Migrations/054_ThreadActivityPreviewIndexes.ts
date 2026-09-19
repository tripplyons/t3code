import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_preview_agent
    ON projection_thread_messages(thread_id, created_at DESC, message_id DESC)
    WHERE role = 'assistant' AND text <> ''
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_preview_tool
    ON projection_thread_activities(thread_id, created_at DESC, activity_id DESC)
    WHERE kind IN ('tool.started', 'tool.updated', 'tool.completed') AND summary <> ''
  `;
});
