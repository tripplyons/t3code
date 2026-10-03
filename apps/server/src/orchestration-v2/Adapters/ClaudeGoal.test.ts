import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";
import { claudeGoalTransition } from "./ClaudeAdapterV2.ts";

function assistant(text: string, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: { model: "<synthetic>", content: [{ type: "text", text }] },
  } as SDKMessage;
}

describe("Claude goals", () => {
  it("reads command replies and leaves ordinary assistant text alone", () => {
    expect(
      claudeGoalTransition(assistant("Goal set: Finish the migration"), undefined, () => undefined),
    ).toBe("Finish the migration");
    expect(
      claudeGoalTransition(
        assistant("Goal active: Finish the migration (2 turns)"),
        undefined,
        () => undefined,
      ),
    ).toBe("Finish the migration");
    expect(
      claudeGoalTransition(
        assistant("Goal cleared: Finish the migration"),
        undefined,
        () => undefined,
      ),
    ).toBeNull();
    expect(claudeGoalTransition(assistant("No goal set"), undefined, () => undefined)).toBeNull();
    expect(
      claudeGoalTransition(assistant("Working on the migration"), undefined, () => undefined),
    ).toBeUndefined();
  });

  it("ignores child replies and accepts only successful ProposeGoal results", () => {
    expect(
      claudeGoalTransition(assistant("Goal set: Child goal", "child"), undefined, () => undefined),
    ).toBeUndefined();
    const result = {
      type: "user",
      parent_tool_use_id: null,
      tool_use_result: { condition: "Tests pass" },
      message: { content: [{ type: "tool_result", tool_use_id: "proposal", content: "Accepted" }] },
    } as SDKMessage;
    expect(claudeGoalTransition(result, undefined, () => "ProposeGoal")).toBe("Tests pass");
    expect(claudeGoalTransition(result, undefined, () => "Bash")).toBeUndefined();
    const failed = {
      ...result,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "proposal", content: "Failed", is_error: true },
        ],
      },
    } as SDKMessage;
    expect(claudeGoalTransition(failed, undefined, () => "ProposeGoal")).toBeUndefined();
  });

  it("restores a condition from Stop feedback and clears it only after a successful turn", () => {
    const feedback = {
      type: "user",
      parent_tool_use_id: null,
      message: { content: "Stop hook feedback:\n[Tests pass]: Keep working" },
    } as SDKMessage;
    expect(claudeGoalTransition(feedback, "Tests pass", () => undefined)).toBe("Tests pass");
    expect(claudeGoalTransition(feedback, "Different goal", () => undefined)).toBeUndefined();
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
    } as SDKMessage;
    expect(claudeGoalTransition(result, "Tests pass", () => undefined)).toBeNull();
    expect(
      claudeGoalTransition(
        { ...result, is_error: true } as SDKMessage,
        "Tests pass",
        () => undefined,
      ),
    ).toBeUndefined();
    expect(
      claudeGoalTransition(
        { ...result, num_turns: 0 } as SDKMessage,
        "Tests pass",
        () => undefined,
      ),
    ).toBeUndefined();
  });
});
