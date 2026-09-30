import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ThreadGoal = Schema.Struct({
  objective: TrimmedNonEmptyString,
  status: Schema.Literals([
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
  ]),
  tokenBudget: Schema.NullOr(PositiveInt),
  // Null when the provider does not report goal usage, as with Claude.
  tokensUsed: Schema.NullOr(NonNegativeInt),
  timeUsedSeconds: Schema.NullOr(NonNegativeInt),
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  // The provider whose conversation owns the goal. Stamped by ingestion.
  provider: Schema.optional(ProviderDriverKind),
});
export type ThreadGoal = typeof ThreadGoal.Type;

export const ProviderUpdateGoalInput = Schema.Union([
  Schema.Struct({
    threadId: ThreadId,
    action: Schema.Literal("set"),
    objective: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(10000))),
    status: Schema.optional(Schema.Literals(["active", "paused"])),
    tokenBudget: Schema.optional(Schema.NullOr(PositiveInt)),
  }),
  Schema.Struct({ threadId: ThreadId, action: Schema.Literal("clear") }),
]);
export type ProviderUpdateGoalInput = typeof ProviderUpdateGoalInput.Type;

export const ProviderUpdateGoalResult = Schema.Struct({ goal: Schema.NullOr(ThreadGoal) });
export type ProviderUpdateGoalResult = typeof ProviderUpdateGoalResult.Type;

export class ProviderUpdateGoalError extends Schema.TaggedError<ProviderUpdateGoalError>()(
  "ProviderUpdateGoalError",
  { threadId: ThreadId, message: Schema.String },
) {}
