/**
 * Switch personality as accessories come and go (same rules as `RfidController`
 * in the conversation app):
 *
 *   - first reading: the accessory's personality, else the fallback;
 *   - an accessory naming a known personality: switch to it;
 *   - a blank or unrecognised one: keep the running personality;
 *   - taken off: back to the fallback;
 *   - no reader: the next reading is not compared.
 *
 * Personalities are robot names.
 */
import type { AccessoryView } from './accessory';

export interface FollowerState {
  /** False until the first reading. */
  launched: boolean;
  /** The personality the accessory on the reader switched to. */
  current: string | null;
}

export const IDLE_FOLLOWER: FollowerState = { launched: false, current: null };

export interface FollowerContext {
  /** The personality running. */
  active: string;
  /** The one to go back to when the accessory comes off; null: the active one. */
  fallback: string | null;
}

export interface FollowerStep {
  state: FollowerState;
  fallback: string | null;
  /** The personality to switch to, or null to leave the running one. */
  switchTo: string | null;
}

function switchFor(target: string, ctx: FollowerContext): string | null {
  return target === ctx.active ? null : target;
}

function arrive(personality: string, ctx: FollowerContext): FollowerStep {
  return {
    state: { launched: true, current: personality },
    fallback: ctx.fallback ?? (personality === ctx.active ? null : ctx.active),
    switchTo: switchFor(personality, ctx),
  };
}

function revert(ctx: FollowerContext): FollowerStep {
  return {
    state: { launched: true, current: null },
    fallback: null,
    switchTo: switchFor(ctx.fallback ?? ctx.active, ctx),
  };
}

/**
 * One step of the follower, for a new reading of the accessory.
 *
 * `previous` is the reading before, or null when there is none to compare
 * with: the reader was gone (or not read yet).
 */
export function followAccessory(
  previous: AccessoryView | null,
  next: AccessoryView,
  state: FollowerState,
  ctx: FollowerContext
): FollowerStep {
  const unchanged: FollowerStep = { state, fallback: ctx.fallback, switchTo: null };
  if (next.state === 'unavailable') return unchanged;
  const known = next.state === 'known' ? next.personality : null;

  if (!state.launched) {
    if (known) return arrive(known, ctx);
    return ctx.fallback === null
      ? { ...unchanged, state: { launched: true, current: null } }
      : revert(ctx);
  }

  if (previous === null) return unchanged;

  if (next.state === 'none') {
    if (previous.state === 'none' || state.current === null) return unchanged;
    return revert(ctx);
  }

  const arrived = previous.state !== 'known' || previous.personality !== known;
  if (!known || !arrived || known === state.current) return unchanged;
  return arrive(known, ctx);
}
