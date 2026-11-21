import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  DEFAULT_GRAPH_FORCES,
  type GraphForceId,
  type GraphForces,
} from "./components/ThreadGraph.logic";
import { resolveStorage } from "./lib/storage";

interface ThreadGraphState {
  forces: GraphForces;
  setForce: (id: GraphForceId, value: number) => void;
  resetForces: () => void;
}

export const useThreadGraphStore = create<ThreadGraphState>()(
  persist(
    (set) => ({
      forces: DEFAULT_GRAPH_FORCES,
      setForce: (id, value) => set((state) => ({ forces: { ...state.forces, [id]: value } })),
      resetForces: () => set({ forces: DEFAULT_GRAPH_FORCES }),
    }),
    {
      name: "t3code:thread-graph:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ forces: state.forces }),
      // A force added later keeps its default until the user moves it.
      merge: (persisted, current) => {
        const saved = persisted as Partial<Pick<ThreadGraphState, "forces">>;
        return { ...current, forces: { ...current.forces, ...saved?.forces } };
      },
    },
  ),
);
