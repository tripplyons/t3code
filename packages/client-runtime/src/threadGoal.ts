import type { ThreadGoal } from "@t3tools/contracts";

export const goalStatusLabel = {
  active: "Active",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limit reached",
  budgetLimited: "Token budget reached",
  complete: "Complete",
} satisfies Record<ThreadGoal["status"], string>;

export function parseGoalTokenBudget(value: string) {
  const trimmed = value.trim();
  if (trimmed === "") return { tokenBudget: null };
  const tokenBudget = Number(trimmed);
  if (!/^\d+$/u.test(trimmed) || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
    return {
      error: "Token budget must be a positive whole number, or leave it blank for no limit.",
    };
  }
  return { tokenBudget };
}

export function goalTokenSummary(goal: ThreadGoal) {
  const used = goal.tokensUsed.toLocaleString();
  return goal.tokenBudget === null
    ? `${used} tokens used`
    : `${used} / ${goal.tokenBudget.toLocaleString()} tokens`;
}
