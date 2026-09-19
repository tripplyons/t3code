import { describe, expect, it } from "vite-plus/test";
import { boardDestination } from "./boardNavigation";

describe("board navigation", () => {
  it.each(["board.open", "board.toggle"] as const)(
    "%s opens the board from another page",
    (command) => {
      expect(boardDestination(command, "/environment/thread", "/")).toBe("/board");
    },
  );
  it("opening an already open board does not add a history entry", () => {
    expect(boardDestination("board.open", "/board", "/environment/thread")).toBeNull();
  });
  it("toggle restores the previous page including its search and hash", () => {
    expect(boardDestination("board.toggle", "/board", "/pull-requests?state=open#review")).toBe(
      "/pull-requests?state=open#review",
    );
  });
  it("a board opened directly can toggle back to the home page", () => {
    expect(boardDestination("board.toggle", "/board", "/")).toBe("/");
  });
});
