import { useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
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

import { AppText, AppTextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

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
  const close = () => {
    if (!pending) setOpen(false);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Goal: ${goalStatusLabel[goal.status]}. ${goal.objective}`}
        onPress={() => {
          setOpen(true);
          setError(null);
          setEditing(false);
        }}
        className="min-h-11 flex-row items-center gap-2 border-b border-border-subtle px-4 py-2"
      >
        <AppText className="text-sm font-t3-medium">
          {`Goal: ${goalStatusLabel[goal.status]}`}
        </AppText>
        <AppText numberOfLines={1} className="flex-1 text-sm text-foreground-secondary">
          {goal.objective}
        </AppText>
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <KeyboardAvoidingView
          className="flex-1 items-center justify-center bg-backdrop px-6"
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            className="max-h-[80%] w-full max-w-md grow-0 rounded-3xl bg-screen"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: 24, gap: 16 }}
          >
            <AppText accessibilityRole="header" className="text-xl font-t3-semibold">
              {`Goal: ${goalStatusLabel[goal.status]}`}
            </AppText>
            {editing ? (
              <>
                <AppText>Objective</AppText>
                <AppTextInput
                  accessibilityLabel="Objective"
                  multiline
                  value={objective}
                  onChangeText={setObjective}
                  maxLength={10000}
                  editable={!pending && !disabled}
                  autoFocus
                />
                <AppText>Token budget (optional)</AppText>
                <AppTextInput
                  accessibilityLabel="Token budget"
                  value={budget}
                  onChangeText={setBudget}
                  keyboardType="number-pad"
                  placeholder="No limit"
                  editable={!pending && !disabled}
                />
                <AppText className="text-sm text-foreground-secondary">
                  Codex continues across turns until the goal is complete or stopped.
                </AppText>
                <MaterialButton
                  label={pending ? "Saving…" : "Save goal"}
                  tone="primary"
                  disabled={pending || disabled || !objective.trim()}
                  onPress={save}
                />
                <MaterialButton
                  label="Cancel"
                  tone="text"
                  disabled={pending}
                  onPress={() => setEditing(false)}
                />
              </>
            ) : (
              <>
                <AppText selectable>{goal.objective}</AppText>
                <AppText className="text-sm text-foreground-secondary">
                  {goalTokenSummary(goal)}
                </AppText>
                <View className="flex-row flex-wrap gap-2">
                  <MaterialButton
                    label={goal.status === "active" ? "Pause" : "Resume"}
                    disabled={pending || disabled}
                    onPress={() =>
                      void mutate({
                        threadId,
                        action: "set",
                        status: goal.status === "active" ? "paused" : "active",
                      })
                    }
                  />
                  <MaterialButton
                    label="Edit"
                    disabled={pending || disabled}
                    onPress={beginEditing}
                  />
                  <MaterialButton
                    label="Clear"
                    tone="danger"
                    disabled={pending || disabled}
                    onPress={() => void mutate({ threadId, action: "clear" })}
                  />
                </View>
              </>
            )}
            {disabled ? (
              <AppText className="text-sm text-foreground-secondary">
                Connect to the environment and start a conversation to manage a goal.
              </AppText>
            ) : null}
            {error ? (
              <AppText accessibilityRole="alert" className="text-sm text-danger">
                {error}
              </AppText>
            ) : null}
            <MaterialButton label="Close" tone="text" disabled={pending} onPress={close} />
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}
