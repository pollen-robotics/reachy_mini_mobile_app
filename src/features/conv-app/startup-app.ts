/**
 * Whether touching Reachy's antennas while it sleeps starts the conversation
 * app, with no phone involved. The daemon owns the setting (its "startup
 * app", `apps.get_startup` / `apps.set_startup`); the phone only flips it.
 *
 * The slot is daemon-wide: it can hold another app, set from the desktop
 * app. The switch then reads off, says which app it would replace, and puts
 * that app back when turned off again.
 */
import { rpcErrorReason, type ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { CONV_APP_NAME, createConvAppClient } from './client';

export interface StartupAppState {
  /** `null` until read, and for good on a daemon without the verbs. */
  enabled: boolean | null;
  /** Another app holding the slot, which turning the switch on replaces. */
  otherApp: string | null;
  /** A change is on its way to the robot; the switch is locked meanwhile. */
  busy: boolean;
  /** Why the last change did not land, as a sentence for the UI. */
  error: string | null;
}

export const INITIAL_STARTUP_APP_STATE: StartupAppState = {
  enabled: null,
  otherApp: null,
  busy: false,
  error: null,
};

/** Reads retried when the link, not the robot, failed to answer. */
export const STARTUP_READ_ATTEMPTS = 3;
export const STARTUP_READ_RETRY_MS = 1_500;

const NOT_CONNECTED = 'Reachy is not connected. Wait for it to come back, then retry.';

function describeError(err: unknown): string {
  switch (rpcErrorReason(err)) {
    case 'not_installed':
      return 'The conversation app is not installed on Reachy yet. Start a conversation from the phone once, then retry.';
    case undefined:
      return "Reachy didn't answer. Check it is still connected, then retry.";
    default:
      return err instanceof Error && err.message ? err.message : 'Reachy refused the change.';
  }
}

export interface StartupAppController {
  /** Reads the setting off the robot. Call when the link comes up. */
  refresh(): Promise<void>;
  toggle(next: boolean): Promise<void>;
  /** Stops every pending read and write from reporting. */
  dispose(): void;
}

export function createStartupAppController(
  getRobot: () => ReachyMiniInstance | null,
  onChange: (state: StartupAppState) => void,
  retryDelayMs: number = STARTUP_READ_RETRY_MS
): StartupAppController {
  let state = INITIAL_STARTUP_APP_STATE;
  let disposed = false;
  // Bumped by every write, so a read that was in flight cannot overwrite it.
  let writes = 0;
  // The app this phone took the slot from, to hand it back on "off".
  let displaced: string | null = null;

  const set = (patch: Partial<StartupAppState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    onChange(state);
  };

  return {
    async refresh() {
      for (let attempt = 1; attempt <= STARTUP_READ_ATTEMPTS && !disposed; attempt++) {
        const robot = getRobot();
        const writesBefore = writes;
        try {
          if (!robot) throw new Error('no robot');
          const name = await createConvAppClient(robot).getStartupApp();
          if (writes !== writesBefore) return;
          const enabled = name === CONV_APP_NAME;
          if (!enabled) displaced = null;
          set({ enabled, otherApp: enabled ? null : name });
          return;
        } catch (err) {
          // A reason means the robot answered: it has no such verb. Without
          // one the link dropped or timed out, which is worth another try.
          if (rpcErrorReason(err) !== undefined) {
            console.debug('[startup-app] apps.get_startup:', err);
            return;
          }
          if (attempt === STARTUP_READ_ATTEMPTS) {
            console.warn('[startup-app] apps.get_startup unreachable:', err);
            return;
          }
          await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
      }
    },

    async toggle(next) {
      if (state.enabled === null || state.busy || state.enabled === next) return;
      const robot = getRobot();
      if (!robot) {
        set({ error: NOT_CONNECTED });
        return;
      }
      const client = createConvAppClient(robot);
      const before = { enabled: state.enabled, otherApp: state.otherApp };
      writes++;
      set({ enabled: next, otherApp: next ? null : displaced, busy: true, error: null });
      try {
        if (next) {
          await client.setStartupApp(CONV_APP_NAME);
          displaced = before.otherApp;
        } else {
          try {
            await client.setStartupApp(displaced);
          } catch (err) {
            // The app we displaced was removed meanwhile: just clear the slot.
            if (displaced === null || rpcErrorReason(err) !== 'not_installed') throw err;
            await client.setStartupApp(null);
            set({ otherApp: null });
          }
          displaced = null;
        }
        set({ busy: false });
      } catch (err) {
        console.warn('[startup-app] apps.set_startup failed:', err);
        set({ ...before, busy: false, error: describeError(err) });
      }
    },

    dispose() {
      disposed = true;
    },
  };
}
