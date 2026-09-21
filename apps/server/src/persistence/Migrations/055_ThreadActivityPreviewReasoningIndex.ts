import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Thread previews now include reasoning, and a partial index only serves a
// query whose WHERE clause repeats its predicate.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_thread_preview_agent`;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_thread_preview_message
    ON projection_thread_messages(thread_id, created_at DESC, message_id DESC)
    WHERE role IN ('assistant', 'reasoning') AND text <> ''
  `;
});
