import { describe, expect, it } from "vite-plus/test";
import { parseGoalTokenBudget } from "./threadGoal.ts";

describe("goal token budget", () => {
  it("removes the limit when the budget is blank", () => {
    expect(parseGoalTokenBudget("  ")).toEqual({ tokenBudget: null });
  });
  it("accepts a positive whole token count", () => {
    expect(parseGoalTokenBudget(" 50000 ")).toEqual({ tokenBudget: 50000 });
  });
  it.each(["0", "-5", "1.5", "1e5", "NaN", "Infinity", "9007199254740992"])(
    "rejects %s",
    (value) => {
      expect(parseGoalTokenBudget(value).error).toBeDefined();
    },
  );
});
