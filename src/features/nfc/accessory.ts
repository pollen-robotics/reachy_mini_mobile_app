/**
 * What accessory is on the NFC reader, as the conversation app's web UI shows
 * it in its "Accessory" badge (`static/js/accessory-badge.js`).
 *
 * The conversation app only runs on the robot while a conversation does, so
 * the phone works this out itself from the daemon's reading, with the same
 * rules as the app's `rfid_routes.py` and `personality_tag.py`.
 */
import type { NfcState, NfcTag } from './nfcState';

/** `unavailable`: no reader. `none`: nothing on it. `known`: names a personality this robot has. */
export type AccessoryState = 'unavailable' | 'none' | 'blank' | 'known' | 'unknown';

export interface AccessoryView {
  state: AccessoryState;
  /** The personality a `known` accessory names, as the robot names it. */
  personality: string | null;
}

export const NO_ACCESSORY_READER: AccessoryView = { state: 'unavailable', personality: null };

// The tag text is a contract with the conversation app
// (`personality_tag.py`, tested in `tests/test_personality_tag.py` there):
// accessory.test.ts uses the same vectors. Change both together.
const BUILTIN_TOKEN_PREFIX = 'hf_';
const USER_TOKEN_PREFIX = 'usr_';
const USER_PERSONALITIES_DIRNAME = 'user_personalities';

/** The text to write on a tag for a personality, as the robot names it, or null for an empty name. */
export function toTagToken(personality: string | null | undefined): string | null {
  const s = (personality ?? '').trim();
  if (!s) return null;
  if (s.startsWith(`${USER_PERSONALITIES_DIRNAME}/`)) {
    const name = s.slice(USER_PERSONALITIES_DIRNAME.length + 1).replace(/^\/+|\/+$/g, '');
    return name ? `${USER_TOKEN_PREFIX}${name}` : null;
  }
  return `${BUILTIN_TOKEN_PREFIX}${s}`;
}

/**
 * Whether the badge offers to link the accessory to the running personality:
 * an accessory carrying nothing this robot knows, or another personality.
 */
export function canLinkAccessory(view: AccessoryView, activePersonality: string | null): boolean {
  if (!activePersonality) return false;
  if (view.state === 'blank' || view.state === 'unknown') return true;
  return view.state === 'known' && view.personality !== activePersonality;
}

/** The personality a tag's text refers to (`hf_noir_detective`, `usr_my_bot`), or null. */
export function fromTagToken(token: string | null | undefined): string | null {
  const t = (token ?? '').trim();
  if (t.startsWith(USER_TOKEN_PREFIX)) {
    const name = t.slice(USER_TOKEN_PREFIX.length);
    return name ? `${USER_PERSONALITIES_DIRNAME}/${name}` : null;
  }
  if (t.startsWith(BUILTIN_TOKEN_PREFIX)) {
    return t.slice(BUILTIN_TOKEN_PREFIX.length) || null;
  }
  return null;
}

const NO_TAG: NfcTag = { present: false };

/**
 * The reading to show, holding the last one while a tag cannot be read.
 *
 * A tag whose content did not come through is neither blank nor known; the
 * daemon reads it again on its next polls, so the last reading stands until
 * then: the accessory that was there, or none if the UID is a new one.
 */
export function settleTag(tag: NfcTag | null, previous: NfcTag | null): NfcTag | null {
  if (!tag || !tag.present || tag.readable !== false || tag.blank) return tag;
  if (!previous?.present) return NO_TAG;
  // Older daemons do not report the UID: then any tag is the same one.
  if (!tag.uid || !previous.uid || tag.uid === previous.uid) return previous;
  return NO_TAG;
}

/** Describe the accessory on the reader. `personalities` holds the robot's names. */
export function describeAccessory(
  readerState: NfcState,
  tag: NfcTag | null,
  personalities: ReadonlySet<string>
): AccessoryView {
  if (readerState === 'unavailable' || readerState === 'disabled') return NO_ACCESSORY_READER;
  if (!tag?.present) return { state: 'none', personality: null };
  if (tag.blank || !tag.content) return { state: 'blank', personality: null };
  const personality = fromTagToken(tag.content);
  if (personality && personalities.has(personality)) return { state: 'known', personality };
  // Carries something this robot cannot act on: an old opaque code, a deleted
  // personality, or a tag written elsewhere.
  return { state: 'unknown', personality: null };
}
