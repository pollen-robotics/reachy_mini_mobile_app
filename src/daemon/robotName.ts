/**
 * Robot-name validation helpers, mirrored from the daemon side.
 *
 * Keeping the rules in a single place lets us:
 *
 *  - render an inline error in the input field without a server round-trip;
 *  - precompute a normalized value (trim) that the user sees before
 *    pressing "Save", so they understand what will actually be persisted;
 *  - share the rules between the onboarding gate and the (future) rename
 *    flows in Settings / ScanScreen disambiguation.
 *
 * The server is the source of truth: any input that the daemon rejects
 * with HTTP 422 still surfaces an error from the network layer. The
 * client-side validation is a UX shortcut, not a security boundary.
 *
 * Rules (kept in lock-step with `reachy_mini/daemon/app/routers/daemon.py`):
 *
 *   - Length: 1-32 chars after trimming.
 *   - Charset: printable ASCII (0x20..0x7E). Letters, digits, common
 *     punctuation, spaces. No control characters, no emoji.
 *   - Whitespace is trimmed automatically; we never persist leading
 *     or trailing spaces.
 */

export const ROBOT_NAME_MIN_LEN = 1;
export const ROBOT_NAME_MAX_LEN = 32;

/** The daemon ships with this default; a `source: "default"` response
 *  means "user has never named this robot, prompt them now". */
export const DEFAULT_ROBOT_NAME = 'reachy_mini';

const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

export type RobotNameValidation =
  | { kind: 'ok'; trimmed: string }
  | { kind: 'empty' }
  | { kind: 'too-long'; max: number }
  | { kind: 'illegal-char' };

/**
 * Validate a candidate robot name. Returns the trimmed value when valid,
 * or a discriminated reason useful for error messaging.
 */
export function validateRobotName(raw: string): RobotNameValidation {
  const trimmed = raw.trim();
  if (trimmed.length < ROBOT_NAME_MIN_LEN) return { kind: 'empty' };
  if (trimmed.length > ROBOT_NAME_MAX_LEN) {
    return { kind: 'too-long', max: ROBOT_NAME_MAX_LEN };
  }
  if (!PRINTABLE_ASCII.test(trimmed)) return { kind: 'illegal-char' };
  return { kind: 'ok', trimmed };
}

/** Human-readable summary of a validation failure. */
export function formatRobotNameError(v: RobotNameValidation): string | null {
  switch (v.kind) {
    case 'ok':
      return null;
    case 'empty':
      return 'Pick a name with at least one visible character.';
    case 'too-long':
      return `Name must be ${v.max} characters or less.`;
    case 'illegal-char':
      return 'Use letters, digits, spaces, and basic punctuation only.';
  }
}

/**
 * Whether the daemon-reported name should trigger the "first time naming"
 * prompt: the literal default has never been customised by the user.
 *
 * The mobile app double-checks against the source field exposed by
 * `GET /api/daemon/robot-name` so a CLI-overridden name (`source === "cli"`)
 * is never overwritten by the prompt - the operator who launched the
 * daemon explicitly chose that label.
 */
export function shouldPromptRobotName(args: {
  name: string;
  source: 'default' | 'persisted' | 'cli' | string;
}): boolean {
  if (args.source === 'cli') return false;
  if (args.source === 'default') return true;
  // Belt-and-suspenders: if the daemon ever returns "default" implicitly
  // (older revision, or a config corruption) we still prompt when the
  // current name is the literal hard-coded default.
  return args.name === DEFAULT_ROBOT_NAME;
}
