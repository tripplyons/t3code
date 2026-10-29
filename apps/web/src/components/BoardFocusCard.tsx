import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState, type RefObject } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useClientSettings } from "../hooks/useSettings";
import { useThreadActions } from "../hooks/useThreadActions";
import { useQuietThreadProjection } from "../state/entities";
import type { SidebarThreadSummary } from "../types";
import { BoardActivityPreviews } from "./BoardActivityPreviews";
import ChatView from "./ChatView";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { DEFAULT_APPROVAL_OPTIONS } from "./chat/ComposerPendingApprovalActions";
import { usePendingThreadRequests } from "./chat/usePendingThreadRequests";
import { requestCustomSnooze } from "./CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets, type SnoozePreset } from "./Sidebar.snooze";
import { boardApprovalChoices, threadBoardStatus } from "./threadBoard";
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

/**
 * The selected board row, answerable in place. Only this thread's detail is
 * loaded, so the board's own traffic stays at the shell level.
 */
export function BoardFocusCard({
  thread,
  project,
  environmentLabel,
  settlementSupported,
  snoozable,
}: {
  thread: SidebarThreadSummary;
  project: EnvironmentProject | undefined;
  environmentLabel: string;
  settlementSupported: boolean;
  /** Whether the environment supports snoozing and the server would accept it now. */
  snoozable: boolean;
}) {
  const navigate = useNavigate();
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const { settleThread, snoozeThread } = useThreadActions();
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [error, setError] = useState<string | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [snoozePresets, setSnoozePresets] = useState<ReadonlyArray<SnoozePreset>>([]);
  const composerHostRef = useRef<HTMLDivElement>(null);
  // Approvals are answered here; the embedded composer owns questions and plans.
  const composerRef: RefObject<ChatComposerHandle | null> = useRef(null);
  const promptRef = useRef("");
  const pending = usePendingThreadRequests({
    environmentId: thread.environmentId,
    activeThreadId: thread.id,
    serverProjection: projection,
    supportsQuestionAttachments: false,
    composerDraftTarget: threadRef,
    setComposerDraftPrompt,
    promptRef,
    composerRef,
    setThreadError: (_threadId, message) => setError(message),
  });
  const approval = pending.activePendingApproval;
  const cwd = project
    ? projectScriptCwd({
        project: { cwd: project.workspaceRoot },
        worktreePath: thread.worktreePath,
      })
    : undefined;
  const approvalChoices = boardApprovalChoices(approval?.options ?? DEFAULT_APPROVAL_OPTIONS);
  const approvalResponding =
    approval !== null && pending.respondingRequestIds.includes(approval.requestId);

  const settle = async () => reportFailure(await settleThread(threadRef), "Could not mark done");
  const snooze = async (preset: Pick<SnoozePreset, "snoozedUntil"> | null | undefined) => {
    if (!preset) return;
    reportFailure(await snoozeThread(threadRef, preset.snoozedUntil), "Could not snooze thread");
  };
  const openSnooze = (open: boolean) => {
    if (open) {
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
    else if (key === "r") {
      composerHostRef.current?.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
    } else if (approval && approval.responseCapability === "live" && /^[1-9]$/.test(key)) {
      const choice = approvalChoices[Number(key) - 1];
      if (!choice) return;
      if (!approvalResponding)
        void pending.onRespondToApproval(approval.requestId, choice.decision);
    } else return;
    event.preventDefault();
  });

  return (
    <article aria-label={thread.title} className="flex min-h-0 flex-col gap-4">
      <header className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{threadBoardStatus(thread)}</p>
        <h2 className="mt-1 break-words text-base font-medium">{thread.title}</h2>
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {project?.title ?? "Unknown project"} · {environmentLabel}
        </p>
      </header>

      <div>
        <BoardActivityPreviews
          previews={thread.source.recentActivityPreviews}
          cwd={cwd}
          threadRef={threadRef}
        />
        {thread.runtime?.status === "failed" && thread.runtime.lastError ? (
          <p className="mt-2 break-words text-sm text-destructive-foreground">
            {thread.runtime.lastError}
          </p>
        ) : null}
      </div>

      {approval ? (
        <section aria-label="Approval" className="rounded-lg border p-3 text-sm">
          <code className="block max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs wrap-anywhere">
            {approval.detail || "Approval requested"}
          </code>
          {approval.reason ? (
            <p className="mt-2 text-xs text-muted-foreground">{approval.reason}</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {approval.responseCapability === "live" ? (
              approvalChoices.map((choice, index) => (
                <Button
                  key={choice.decision}
                  size="sm"
                  variant={choice.decision === "accept" ? "default" : "outline"}
                  disabled={approvalResponding}
                  title={choice.warning}
                  onClick={() =>
                    void pending.onRespondToApproval(approval.requestId, choice.decision)
                  }
                >
                  {choice.label} <Kbd>{index + 1}</Kbd>
                </Button>
              ))
            ) : (
              <span className="text-xs text-warning">
                Provider process is gone. Open the thread to restart the run.
              </span>
            )}
          </div>
        </section>
      ) : null}

      {error ? <p className="text-sm text-destructive-foreground">{error}</p> : null}

      <footer className="flex flex-wrap items-center gap-2">
        {settlementSupported ? (
          <Button size="sm" variant="outline" onClick={() => void settle()}>
            Done <Kbd>E</Kbd>
          </Button>
        ) : null}
        {snoozable ? (
          <Menu open={snoozeOpen} onOpenChange={openSnooze}>
            <MenuTrigger render={<Button size="sm" variant="outline" />}>
              Later <Kbd>L</Kbd>
            </MenuTrigger>
            <MenuPopup align="start">
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
              <MenuItem onClick={() => void requestCustomSnooze().then(snooze)}>Custom…</MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: thread.environmentId, threadId: thread.id }}
            />
          }
        >
          Open thread <Kbd>↵</Kbd>
        </Button>
      </footer>

      <div
        ref={composerHostRef}
        onKeyDownCapture={(event) => {
          // Esc in the editor hands the keyboard back to the board unless it is closing a
          // composer menu. ProseMirror prevents every Escape, so defaultPrevented can't tell.
          const target = event.target;
          if (
            event.key === "Escape" &&
            target instanceof HTMLElement &&
            target.isContentEditable &&
            !document.querySelector("[data-composer-command-drawer], [data-composer-stash-drawer]")
          ) {
            target.blur();
          }
        }}
      >
        <ChatView
          environmentId={thread.environmentId}
          threadId={thread.id}
          routeKind="server"
          composerOnly
        />
      </div>
    </article>
  );
}
