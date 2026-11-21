import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { graphDestination, subscribeGraphCommands, type GraphCommand } from "../graphNavigation";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { resolveShortcutCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";

/** Remember the last page outside the graph regardless of which entry point opened the graph. */
export function GraphNavigation() {
  const location = useLocation();
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const returnHref = useRef("/");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the return target in step with router navigation, including visits outside the graph.
  useEffect(() => {
    if (location.pathname !== "/board") returnHref.current = location.href;
  }, [location.href, location.pathname]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register the graph command bus and window shortcut listener only while the layout is mounted.
  useEffect(() => {
    const run = (command: GraphCommand) => {
      const href = graphDestination(command, location.pathname, returnHref.current);
      if (href !== null) void navigate({ href });
    };
    const unsubscribe = subscribeGraphCommands(run);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) return;
      if (event.target instanceof HTMLElement && event.target.closest("[data-keybinding-capture]"))
        return;
      const command = resolveShortcutCommand(event, keybindings);
      if (command !== "graph.open" && command !== "graph.toggle") return;
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
