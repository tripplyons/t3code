export type GraphCommand = "graph.open" | "graph.toggle";

const EVENT_NAME = "t3code:graph-navigation";

export function graphDestination(command: GraphCommand, pathname: string, returnHref: string) {
  if (pathname !== "/board") return "/board";
  return command === "graph.toggle" ? returnHref : null;
}

export function dispatchGraphCommand(command: GraphCommand) {
  window.dispatchEvent(new CustomEvent<GraphCommand>(EVENT_NAME, { detail: command }));
}

export function subscribeGraphCommands(listener: (command: GraphCommand) => void) {
  const handler = (event: Event) => {
    const command = (event as CustomEvent<unknown>).detail;
    if (command === "graph.open" || command === "graph.toggle") listener(command);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
