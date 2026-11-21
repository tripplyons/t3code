import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import type { SidebarThreadSummary } from "../types";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "./Sidebar.snooze";
import { boardHomeRow } from "./boardFocus";
import { useBoardShortcuts } from "./useBoardShortcuts";
import { Button } from "./ui/button";
import { Kbd } from "./ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "./ui/menu";
import { toastManager } from "./ui/toast";

function reportFailure(result: AtomCommandResult<unknown, unknown>, title: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : undefined,
  });
}

/** Done, Later, Reply, Dictate, and Open for the selected board thread, with their keys. */
export function BoardThreadActions({
  thread,
  settlementSupported,
  snoozable,
  onReply,
  onDictate,
}: {
  thread: SidebarThreadSummary;
  settlementSupported: boolean;
  /** Whether the environment supports snoozing and the server would accept it now. */
  snoozable: boolean;
  onReply: () => void;
  /** Opens the reply composer and starts dictation, or stops a recording. */
  onDictate: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const { settleThread, snoozeThread } = useThreadActions();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozePresets, setSnoozePresets] = useState<ReadonlyArray<SnoozePreset>>([]);

  const settle = async () =>
    reportFailure(await settleThread(threadRef), gt("Could not mark done"));
  const snooze = async (preset: Pick<SnoozePreset, "snoozedUntil"> | null | undefined) => {
    if (!preset) return;
    reportFailure(
      await snoozeThread(threadRef, preset.snoozedUntil),
      gt("Could not snooze thread"),
    );
  };
  const openSnooze = (open: boolean) => {
    if (open) {
      // oxlint-disable-next-line react/purity -- Runs when the menu opens, not during render.
      setSnoozePresets(resolveSnoozePresets(new Date(), timestampFormat, thread.environmentId));
    }
    setSnoozeOpen(open);
  };

  const openThread = () =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: thread.environmentId, threadId: thread.id },
    });

  useBoardShortcuts((key, event) => {
    if (key === "enter") openThread();
    else if (key === "e" && settlementSupported) void settle();
    else if (key === "l" && snoozable) openSnooze(true);
    else if (key === "r") onReply();
    else if (key === "d") onDictate();
    else return;
    event.preventDefault();
  });

  return (
    <>
      {settlementSupported ? (
        <Button size="sm" variant="outline" onClick={() => void settle()}>
          <T>Done</T> <Kbd>E</Kbd>
        </Button>
      ) : null}
      {snoozable ? (
        <Menu open={snoozeOpen} onOpenChange={openSnooze}>
          <MenuTrigger render={<Button size="sm" variant="outline" />}>
            <T>Later</T> <Kbd>L</Kbd>
          </MenuTrigger>
          <MenuPopup align="start" finalFocus={() => boardHomeRow() ?? true}>
            {snoozePresets.map((preset) => (
              <MenuItem
                key={preset.id}
                onClick={() =>
                  void snooze(
                    pickSnoozePreset(
                      snoozePresets,
                      preset.id,
                      timestampFormat,
                      thread.environmentId,
                    ),
                  )
                }
              >
                {preset.label} ({preset.whenLabel})
              </MenuItem>
            ))}
            {snoozePresets.length > 0 ? <MenuSeparator /> : null}
            <MenuItem onClick={() => void requestCustomSnooze().then(snooze)}>
              <T>Custom…</T>
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
      <Button size="sm" variant="outline" onClick={onReply}>
        <T>Reply</T> <Kbd>R</Kbd>
      </Button>
      <Button size="sm" variant="outline" onClick={onDictate}>
        <T>Dictate</T> <Kbd>D</Kbd>
      </Button>
      <Button
        size="sm"
        variant="outline"
        render={
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: thread.environmentId, threadId: thread.id }}
          />
        }
      >
        <T>Open thread</T> <Kbd>↵</Kbd>
      </Button>
    </>
  );
}
