import { describe, expect, it } from "vite-plus/test";
import { graphDestination } from "./graphNavigation";

describe("graph navigation", () => {
  it.each(["graph.open", "graph.toggle"] as const)(
    "%s opens the graph from another page",
    (command) => {
      expect(graphDestination(command, "/environment/thread", "/")).toBe("/board");
    },
  );
  it("opening an already open graph does not add a history entry", () => {
    expect(graphDestination("graph.open", "/board", "/environment/thread")).toBeNull();
  });
  it("toggle restores the previous page including its search and hash", () => {
    expect(graphDestination("graph.toggle", "/board", "/pull-requests?state=open#review")).toBe(
      "/pull-requests?state=open#review",
    );
  });
  it("a graph opened directly can toggle back to the home page", () => {
    expect(graphDestination("graph.toggle", "/board", "/")).toBe("/");
  });
});
