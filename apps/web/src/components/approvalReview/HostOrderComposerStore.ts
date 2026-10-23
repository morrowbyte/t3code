import {
  ApprovalReviewHostOrder,
  ApprovalReviewOrderCreate,
  ApprovalReviewOrderCancelResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { resolveStorage } from "../../lib/storage";

const SentOrder = Schema.Struct({
  input: ApprovalReviewOrderCreate,
  order: Schema.NullOr(ApprovalReviewHostOrder),
  error: Schema.NullOr(Schema.String),
  alreadyClaimedActions: ApprovalReviewOrderCancelResult.fields.alreadyClaimedActions,
});
export type SentOrder = typeof SentOrder.Type;
const SavedSession = Schema.Struct({
  text: Schema.String,
  selectedVmId: Schema.String,
  draft: Schema.NullOr(ApprovalReviewOrderCreate),
  sent: Schema.Array(SentOrder),
});
export type HostOrderSession = typeof SavedSession.Type & { pending: boolean };
export const EMPTY_HOST_ORDER_SESSION: HostOrderSession = {
  text: "",
  selectedVmId: "",
  draft: null,
  sent: [],
  pending: false,
};
const SavedState = Schema.Struct({
  sessions: Schema.Record(Schema.String, SavedSession),
  selectedHosts: Schema.Record(Schema.String, Schema.String),
});

const decodeSavedState = Schema.decodeUnknownOption(SavedState);

// A tab session survives Settings navigation and reload without sharing drafts across clients.
export const useHostOrderComposerStore = create<{
  sessions: Record<string, HostOrderSession>;
  selectedHosts: Record<string, string>;
  update: (key: string, update: (session: HostOrderSession) => HostOrderSession) => void;
  selectHost: (destinationKey: string, host: string) => void;
}>()(
  persist(
    (set) => ({
      sessions: {},
      selectedHosts: {},
      update: (key, update) =>
        set((state) => ({
          sessions: {
            ...state.sessions,
            [key]: update(state.sessions[key] ?? EMPTY_HOST_ORDER_SESSION),
          },
        })),
      selectHost: (key, host) =>
        set((state) => ({ selectedHosts: { ...state.selectedHosts, [key]: host } })),
    }),
    {
      name: "t3code:host-order-drafts:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.sessionStorage : undefined),
      ),
      partialize: (state) => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).map(([key, { pending: _pending, ...session }]) => [
            key,
            session,
          ]),
        ),
        selectedHosts: state.selectedHosts,
      }),
      merge: (persisted, current) => {
        const decoded = decodeSavedState(persisted);
        if (decoded._tag === "None") return current;
        return {
          ...current,
          selectedHosts: decoded.value.selectedHosts,
          sessions: Object.fromEntries(
            Object.entries(decoded.value.sessions).map(([key, session]) => [
              key,
              { ...session, pending: false },
            ]),
          ),
        };
      },
    },
  ),
);
