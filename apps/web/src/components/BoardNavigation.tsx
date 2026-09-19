import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { boardDestination, subscribeBoardCommands, type BoardCommand } from "../boardNavigation";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

/** Remember the last non-board page regardless of which entry point opened the board. */
export function BoardNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const returnHref = useRef("/");

  useEffect(() => {
    if (location.pathname !== "/board") returnHref.current = location.href;
  }, [location.href, location.pathname]);

  useEffect(() => {
    const run = (command: BoardCommand) => {
      const href = boardDestination(command, location.pathname, returnHref.current);
      if (href !== null) void navigate({ href });
    };
    const unsubscribe = subscribeBoardCommands(run);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      const command = resolveShortcutCommand(event, keybindings);
      if (command !== "board.open" && command !== "board.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      run(command);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [keybindings, location.pathname, navigate]);

  return null;
}
