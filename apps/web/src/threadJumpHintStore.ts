import { create } from "zustand";

const EMPTY_LABELS: ReadonlyMap<string, string> = new Map();

/**
 * The jump hints the sidebar is showing right now, keyed by scoped thread key.
 * The sidebar owns the jump order and handles the shortcuts; other views read
 * this to badge the same threads, so a hint can never disagree with the key.
 */
export const useThreadJumpHintStore = create<{
  visibleLabelByKey: ReadonlyMap<string, string>;
  setVisibleLabels: (labels: ReadonlyMap<string, string> | null) => void;
}>((set) => ({
  visibleLabelByKey: EMPTY_LABELS,
  setVisibleLabels: (labels) =>
    set((state) => {
      const next = labels ?? EMPTY_LABELS;
      const previous = state.visibleLabelByKey;
      if (
        previous.size === next.size &&
        [...next].every(([key, label]) => previous.get(key) === label)
      ) {
        return state;
      }
      return { visibleLabelByKey: next };
    }),
}));
