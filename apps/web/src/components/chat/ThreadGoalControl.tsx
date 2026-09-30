import { useRef, useState } from "react";
import { PauseIcon, PlayIcon, TargetIcon } from "lucide-react";
import type {
  EnvironmentId,
  ProviderUpdateGoalInput,
  ThreadGoal,
  ThreadId,
} from "@t3tools/contracts";
import {
  goalStatusLabel,
  goalTokenSummary,
  parseGoalTokenBudget,
} from "@t3tools/client-runtime/thread-goal";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export function ThreadGoalControl({
  environmentId,
  threadId,
  goal,
  disabled,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  goal: ThreadGoal;
  disabled: boolean;
}) {
  const updateGoal = useAtomCommand(threadEnvironment.updateGoal, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const beginEditing = () => {
    setObjective(goal.objective);
    setBudget(goal.tokenBudget?.toString() ?? "");
    setEditing(true);
    setError(null);
  };
  const mutate = async (input: ProviderUpdateGoalInput) => {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await updateGoal({ environmentId, input });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Failed to update goal.");
        setOpen(true);
        return;
      }
      setEditing(false);
      if (input.action === "clear") setOpen(false);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  const save = () => {
    const parsed = parseGoalTokenBudget(budget);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    void mutate({
      threadId,
      action: "set",
      objective: objective.trim(),
      tokenBudget: parsed.tokenBudget,
    });
  };

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-1.5"
      aria-label="Codex goal"
    >
      <Popover
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (next) {
            setError(null);
            setEditing(false);
          }
        }}
      >
        <PopoverTrigger render={<Button variant="ghost-muted" size="compact" />}>
          <TargetIcon />
          {`Goal: ${goalStatusLabel[goal.status]}`}
        </PopoverTrigger>
        <PopoverPopup width="lg" align="start">
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-medium">{`Goal: ${goalStatusLabel[goal.status]}`}</h2>
            {editing ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  save();
                }}
              >
                <label className="flex flex-col gap-1.5 text-sm">
                  Objective
                  <Textarea
                    value={objective}
                    onChange={(event) => setObjective(event.target.value)}
                    maxLength={10000}
                    disabled={pending || disabled}
                    autoFocus
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  Token budget (optional)
                  <Input
                    value={budget}
                    onChange={(event) => setBudget(event.target.value)}
                    inputMode="numeric"
                    placeholder="No limit"
                    disabled={pending || disabled}
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Codex continues across turns until the goal is complete or stopped.
                </p>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => setEditing(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={pending || disabled || !objective.trim()}
                  >
                    {pending ? "Saving…" : "Save goal"}
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words text-sm">{goal.objective}</p>
                <p className="text-xs text-muted-foreground">{goalTokenSummary(goal)}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || disabled}
                    onClick={() =>
                      void mutate({
                        threadId,
                        action: "set",
                        status: goal.status === "active" ? "paused" : "active",
                      })
                    }
                  >
                    {goal.status === "active" ? <PauseIcon /> : <PlayIcon />}
                    {goal.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending || disabled}
                    onClick={beginEditing}
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost-destructive"
                    size="sm"
                    disabled={pending || disabled}
                    onClick={() => void mutate({ threadId, action: "clear" })}
                  >
                    Clear
                  </Button>
                </div>
              </>
            )}
            {disabled ? (
              <p className="text-xs text-muted-foreground">
                Connect to the environment and start a conversation to manage a goal.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        </PopoverPopup>
      </Popover>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {goal.objective}
      </span>
      {goal.status === "active" ? (
        <Button
          variant="ghost-muted"
          size="compact"
          disabled={pending || disabled}
          aria-label="Pause goal"
          onClick={() => void mutate({ threadId, action: "set", status: "paused" })}
        >
          <PauseIcon />
          Pause
        </Button>
      ) : null}
    </div>
  );
}
