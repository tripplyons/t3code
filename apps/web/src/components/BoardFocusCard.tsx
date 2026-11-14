import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useLayoutEffect, useRef, useState, type FocusEvent, type RefObject } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useQuietThreadProjection } from "../state/entities";
import type { SidebarThreadSummary } from "../types";
import ChatView from "./ChatView";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import { DEFAULT_APPROVAL_OPTIONS } from "./chat/ComposerPendingApprovalActions";
import { usePendingThreadRequests } from "./chat/usePendingThreadRequests";
import { boardApprovalChoices } from "./threadBoard";
import { useBoardShortcuts } from "./useBoardShortcuts";

const isComposerRegion = (target: EventTarget | null): target is HTMLElement =>
  target instanceof HTMLElement && target.hasAttribute("data-chat-composer-overlay");

// The overlay is a focusable landmark, so only focus inside it counts as the composer in use.
const isInComposer = (target: EventTarget | null) =>
  target instanceof Element &&
  !isComposerRegion(target) &&
  target.closest("[data-chat-composer-overlay]") !== null;

const focusSelectedRow = () => {
  const row = document.querySelector<HTMLElement>("[data-board-row][aria-current]");
  row?.focus({ preventScroll: true });
  return row !== null;
};

/**
 * The selected board thread's full conversation. The composer stays hidden
 * until the user replies, so the timeline gets the whole pane while reading.
 */
export function BoardFocusCard({
  thread,
  composerFocused,
  onComposerFocusChange,
}: {
  thread: SidebarThreadSummary;
  composerFocused: boolean;
  onComposerFocusChange: (focused: boolean) => void;
}) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const [error, setError] = useState<string | null>(null);
  // Number keys answer approvals; the timeline shows them and the composer owns questions.
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
  const approvalChoices = boardApprovalChoices(approval?.options ?? DEFAULT_APPROVAL_OPTIONS);

  const articleRef = useRef<HTMLElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Moves DOM focus while this card's nodes still exist.
  useLayoutEffect(() => {
    const article = articleRef.current;
    // Switching threads remounts the card. Hand focus to the list first, or workspace focus
    // recovery refocuses the new card's conversation region and draws its keyboard ring.
    return () => {
      if (article?.contains(document.activeElement)) focusSelectedRow();
    };
  }, []);

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    // Leaving the window keeps the editor active; portaled composer menus still count as inside.
    if (!isInComposer(event.target) || !document.hasFocus()) return;
    const next = event.relatedTarget;
    if (isInComposer(next)) return;
    if (next instanceof Element && next.closest("[role='menu'], [role='listbox'], [role='dialog']"))
      return;
    onComposerFocusChange(false);
  };

  useBoardShortcuts((key, event) => {
    if (!approval || approval.responseCapability !== "live" || !/^[1-9]$/.test(key)) return;
    const choice = approvalChoices[Number(key) - 1];
    if (!choice) return;
    if (!pending.respondingRequestIds.includes(approval.requestId))
      void pending.onRespondToApproval(approval.requestId, choice.decision);
    event.preventDefault();
  });

  return (
    <article ref={articleRef} aria-label={thread.title} className="flex min-h-0 flex-1 flex-col">
      {error ? <p className="px-4 pt-2 text-sm text-destructive-foreground">{error}</p> : null}
      <div
        data-board-composer
        className="flex min-h-0 flex-1 flex-col"
        onFocus={(event) => {
          // A click on the region's padding focuses the region itself; keep the editor active.
          if (isComposerRegion(event.target)) {
            event.target.querySelector<HTMLElement>("[contenteditable='true']")?.focus();
          } else if (isInComposer(event.target)) onComposerFocusChange(true);
        }}
        onBlur={onBlur}
        onKeyDownCapture={(event) => {
          // Esc in the editor hands the keyboard back to the board unless it is closing a
          // composer menu. ProseMirror prevents every Escape, so defaultPrevented can't tell.
          // Focus moves to the selected row; a bare blur would let workspace focus recovery
          // pull it back into the hidden composer's region.
          const target = event.target;
          if (
            event.key === "Escape" &&
            target instanceof HTMLElement &&
            target.isContentEditable &&
            !document.querySelector("[data-composer-command-drawer], [data-composer-stash-drawer]")
          ) {
            if (!focusSelectedRow()) target.blur();
          }
        }}
      >
        <ChatView
          environmentId={thread.environmentId}
          threadId={thread.id}
          routeKind="server"
          board
          hideIdleComposer={!composerFocused}
          onSent={() => {
            onComposerFocusChange(false);
            focusSelectedRow();
          }}
        />
      </div>
    </article>
  );
}
