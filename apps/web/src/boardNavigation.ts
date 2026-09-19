export type BoardCommand = "board.open" | "board.toggle";

const EVENT_NAME = "t3code:board-navigation";

export function boardDestination(command: BoardCommand, pathname: string, returnHref: string) {
  if (pathname !== "/board") return "/board";
  return command === "board.toggle" ? returnHref : null;
}

export function dispatchBoardCommand(command: BoardCommand) {
  window.dispatchEvent(new CustomEvent<BoardCommand>(EVENT_NAME, { detail: command }));
}

export function subscribeBoardCommands(listener: (command: BoardCommand) => void) {
  const handler = (event: Event) => {
    const command = (event as CustomEvent<unknown>).detail;
    if (command === "board.open" || command === "board.toggle") listener(command);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
