import { describe, expect, it } from "vite-plus/test";

import { boardApprovalChoices } from "./threadBoard";

describe("boardApprovalChoices", () => {
  it("keeps Approve on 1 and Decline on 2 whatever order the provider offers", () => {
    const choices = boardApprovalChoices([
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "acceptForSession", label: "Always allow this session" },
      { decision: "accept", label: "Approve" },
    ]);
    expect(choices.map((choice) => choice.decision)).toEqual([
      "accept",
      "decline",
      "cancel",
      "acceptForSession",
    ]);
  });
});
