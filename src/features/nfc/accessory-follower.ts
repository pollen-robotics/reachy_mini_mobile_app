/**
 * Switch personality as accessories come and go, like the conversation app's
 * NFC reader does on desktop (`RfidController._process` in `rfid_routes.py`):
 *
 *   - an accessory naming a personality this robot has: switch to it;
 *   - a blank or unrecognised one: keep the personality running;
 *   - taken off: back to the personality from before the accessory.
 *
 * While a conversation runs, the conversation app does this itself and
 * announces it; the phone only tracks the accessory then, so that taking it
 * off after the conversation still brings the earlier personality back.
 */
import type { AccessoryView } from './accessory';

export interface FollowerState {
  /** The personality the accessory on the reader switched to. */
  accessoryPersonality: string | null;
  /** The active id to go back to when the accessory comes off. */
  restoreTo: string | null;
}

export const IDLE_FOLLOWER: FollowerState = { accessoryPersonality: null, restoreTo: null };

export type FollowerAction =
  | { kind: 'apply'; personality: string }
  | { kind: 'restore'; activeId: string }
  | null;

/**
 * One step of the follower, for a new reading of the accessory.
 *
 * `active` is the running personality as the robot names it, `activeId` the
 * same as the phone's store holds it (what `restore` gives back). A first
 * reading counts as the accessory arriving: the conversation app also starts
 * with the personality of an accessory already on the reader.
 */
export function followAccessory(
  previous: AccessoryView | null,
  next: AccessoryView,
  state: FollowerState,
  active: string,
  activeId: string
): { state: FollowerState; action: FollowerAction } {
  // No reader: nothing to compare with, like the app resetting its last read.
  if (next.state === 'unavailable') return { state, action: null };

  if (next.state === 'known' && next.personality) {
    if (next.personality === state.accessoryPersonality) return { state, action: null };
    return {
      state: {
        accessoryPersonality: next.personality,
        // Swapping one accessory for another keeps the personality from before both.
        restoreTo: state.restoreTo ?? activeId,
      },
      action: next.personality === active ? null : { kind: 'apply', personality: next.personality },
    };
  }

  // No reader before (not answered yet, or gone) counts as no reading.
  const hadReading = previous !== null && previous.state !== 'unavailable';
  // A first reading of an empty reader: an accessory taken off while the app
  // was closed left nothing to go back to.
  if (next.state === 'none' && !hadReading) return { state: IDLE_FOLLOWER, action: null };

  const removed = next.state === 'none' && hadReading && previous.state !== 'none';
  if (!removed || state.accessoryPersonality === null) return { state, action: null };
  // Picked by hand meanwhile: that choice stands.
  const stillOnAccessory = active === state.accessoryPersonality;
  return {
    state: IDLE_FOLLOWER,
    action:
      stillOnAccessory && state.restoreTo ? { kind: 'restore', activeId: state.restoreTo } : null,
  };
}
