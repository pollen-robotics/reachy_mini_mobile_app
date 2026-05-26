/**
 * Single-instance provider for the daemon-state surface.
 *
 *   <DaemonStateProvider session={session} enabled={hasReachedReady}>
 *     <RobotInfoSheet />
 *     <ConversationPanel />
 *     <IdentityChipBar />
 *     ...all consume `useDaemonState()`
 *   </DaemonStateProvider>
 *
 * Why a provider (not a "just call the hook in N places")
 * ───────────────────────────────────────────────────────
 * The whole point of this module is to be the **single source of
 * truth** for what we know about the daemon. If two unrelated
 * components both called `useDaemonStateInternal`, we'd round-trip
 * `get_volume` / `get_microphone_volume` / `get_version` twice on
 * mount, debounce two writers in parallel, and possibly play the
 * audible chime twice - all of which we explicitly want to avoid.
 *
 * The provider mounts ONCE near the top of the session screen (just
 * inside `RobotSessionScreen`'s `<Stack>`) and serves every consumer
 * tree below it. The consumer hook (`useDaemonState`) is a thin
 * `useContext` wrapper that throws if it's called outside the
 * provider, so a misuse is loud, not silent.
 */
import { createContext, useContext, type ReactNode } from "react";

import {
  useDaemonStateInternal,
  type DaemonStateSessionMethods,
} from "./useDaemonStateInternal";
import type { DaemonStateValue } from "./types";

/**
 * Internal context handle. `null` is the "no provider above me"
 * sentinel - the consumer hook checks for it and throws so a
 * forgotten provider is a debuggable error rather than a silent
 * "everything is null forever".
 */
const DaemonStateContext = createContext<DaemonStateValue | null>(null);

interface DaemonStateProviderProps {
  /**
   * Session handle. The provider only needs the daemon-touching
   * methods, which we type via `DaemonStateSessionMethods` so the
   * signature stays narrow even when the host passes a full
   * `RobotSessionHandle`.
   */
  session: DaemonStateSessionMethods;
  /**
   * Drives the underlying hook's fetch lifecycle. The host should
   * pass `session.hasReachedReady` so we kick off `get_*`
   * round-trips as soon as the engine has reached `ready` for the
   * first time on the current session.
   */
  enabled: boolean;
  children: ReactNode;
}

export function DaemonStateProvider({
  session,
  enabled,
  children,
}: DaemonStateProviderProps) {
  const value = useDaemonStateInternal({ session, enabled });
  return (
    <DaemonStateContext.Provider value={value}>
      {children}
    </DaemonStateContext.Provider>
  );
}

/**
 * Consume the daemon-state surface. Throws when called outside a
 * `<DaemonStateProvider>` so a setup bug surfaces immediately
 * instead of producing all-null fields with no obvious cause.
 */
export function useDaemonState(): DaemonStateValue {
  const ctx = useContext(DaemonStateContext);
  if (!ctx) {
    throw new Error(
      "useDaemonState must be used inside a <DaemonStateProvider>. " +
        "If you're seeing this in `RobotSessionScreen`, the provider is " +
        "the wrapper at the top of the rendered tree.",
    );
  }
  return ctx;
}
