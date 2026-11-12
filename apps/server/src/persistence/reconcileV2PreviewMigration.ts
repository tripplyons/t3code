import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

type MigrationRow = { readonly id: number; readonly name: string };

// Previews used V2 ids 53/54; preserve their schema and import progress while reserving main's ids.
function v2PreviewId(history: ReadonlyArray<MigrationRow>): number | "invalid" | undefined {
  const later = history.filter((row) => row.id >= 53);
  const legacy = later.find(
    (row) => row.name === "OrchestrationV2" && (row.id === 53 || row.id === 54),
  );
  if (!legacy) return undefined;
  const valid = later.every(
    (row) =>
      row === legacy ||
      (legacy.id === 54 &&
        ((row.id === 53 && row.name === "PullRequestFilesViewed") ||
          (row.id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
  );
  return valid ? legacy.id : "invalid";
}

/** The history as startup's preview reconciliation leaves it, or null when startup rejects it. */
export function reconciledV2PreviewHistory(
  history: ReadonlyArray<MigrationRow>,
): ReadonlyArray<MigrationRow> | null {
  const previewId = v2PreviewId(history);
  if (previewId === undefined) return history;
  if (previewId === "invalid") return null;
  return [
    ...history.filter((row) => row.id < 53),
    { id: 53, name: "PullRequestFilesViewed" },
    { id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
    { id: 55, name: "OrchestrationV2" },
    ...(history.some((row) => row.id === 55)
      ? [{ id: 56, name: "RemoveRedundantProjectionIndexes" }]
      : []),
  ];
}

export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      // The fork inserted a preview index before upstream's migrations. Preserve
      // completed non-idempotent migrations by moving their ledger entries, not replaying them.
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id IN (57, 62, 63, 65) AND name = 'ThreadActivityPreviewsV2'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 65 WHERE migration_id = 66 AND name = 'CodexUsageNativeTurnIndex'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 66 WHERE migration_id = 67 AND name = 'RepairClientSettlementTimestamps'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 67 WHERE migration_id = 68 AND name = 'WebhookDedupe'`;
      const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 53
      `;
      // This fork used 54-57 before upstream assigned those ids to V2.
      // Their schema additions remain valid. Free only the known fork ledger
      // entries so the idempotent column migration and V2 setup can run.
      const forkNames = new Map([
        [54, "ThreadActivityPreviewIndexes"],
        [55, "ThreadActivityPreviewReasoningIndex"],
        [56, "ProjectionThreadsAutoSettleDisabledAt"],
        [57, "ProjectionThreadGoal"],
      ]);
      if (history.some((row) => forkNames.get(row.migration_id) === row.name)) {
        const unexpected = history.filter(
          (row) => row.migration_id >= 54 && forkNames.get(row.migration_id) !== row.name,
        );
        if (unexpected.length > 0) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade fork with unexpected later migrations.",
          });
        }
        for (const row of history) {
          if (forkNames.get(row.migration_id) === row.name) {
            yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${row.migration_id} AND name = ${row.name}`;
          }
        }
        return [];
      }
      const previewId = v2PreviewId(
        history.map((row) => ({ id: row.migration_id, name: row.name })),
      );
      if (previewId === undefined) return [];
      if (previewId === "invalid") {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (previewId === 53) {
        yield* PullRequestFilesViewed;
        executed.push([53, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([54, "ProjectionThreadsAutoSettleDisabledAt"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 56 WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 55 WHERE migration_id = ${previewId} AND name = 'OrchestrationV2'`;
      if (previewId === 53) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
      return executed;
    }),
  );
});
