/**
 * NFC reader types and the pure logic around them, ported from the desktop
 * app (`views/active-robot/nfc/nfcState.ts`) so both apps word the reader the
 * same way.
 */

/** Why the reader is not serving: the daemon's `NfcStatus.error_code`. */
export type NfcStatusError =
  | 'DISABLED'
  | 'NO_BOARD'
  | 'DRIVER_MISSING'
  | 'PORT_CONFLICT'
  | 'LINK_ERROR';

/** Mirrors the daemon's `NfcStatus` (`nfc.status`). */
export interface NfcStatus {
  connected: boolean;
  /** Switched on or off from Settings. Absent on daemons without the switch. */
  enabled?: boolean;
  chip_detected: boolean;
  driver_available: boolean;
  port?: string | null;
  /** From the board's USB product string ("Winnie NFC 1.2"). Absent on older daemons. */
  board_version?: string | null;
  chip_version?: string | null;
  /** For people; branch on `error_code`, the wording may change. */
  error?: string | null;
  error_code?: NfcStatusError | null;
  last_seen_at?: string | null;
}

/** One NDEF record. `kind` is "text", "uri" or "other". */
export interface NfcRecord {
  kind: 'text' | 'uri' | 'other' | string;
  value?: string | null;
  type_name?: string | null;
  data_hex?: string | null;
}

/** Mirrors the daemon's `NfcTag` (`nfc.tag`). */
export interface NfcTag {
  present: boolean;
  uid?: string | null;
  model?: string | null;
  records?: NfcRecord[];
  content?: string | null;
  blank?: boolean;
  readable?: boolean;
  writable?: boolean;
  capacity?: number | null;
  raw_hex?: string | null;
  error?: string | null;
  last_read_at?: string | null;
}

/** Mirrors the daemon's `NfcWriteResult`, answered by both erase and write. */
export interface NfcTagResult {
  success: boolean;
  error?: string | null;
}

/** What `nfc.write` puts on the tag: one text or URI record. */
export type NfcWriteContent = { text: string } | { uri: string };

/** What the reader is doing. */
export type NfcState =
  | 'disabled'
  | 'unavailable'
  | 'connecting'
  | 'not_responding'
  | 'idle'
  | 'tag';

/**
 * Error code for a tag operation refused because the reader is off. The
 * daemon refuses with the RPC reason `nfc_disabled` rather than a result.
 */
export const READER_DISABLED = 'DISABLED';

/** Stable error codes returned by the daemon's erase and write. */
const TAG_ERROR_MESSAGES: Record<string, string> = {
  NO_TAG: 'No tag on the reader',
  TOO_LONG: 'Too long for this tag',
  LOCKED: 'Tag is locked and can no longer be written',
  UNKNOWN_TAG: 'Unrecognised tag model',
  WRITE_REFUSED: 'Tag refused the write',
  WRITE_ERROR: 'Write failed partway through',
  COLLISION: 'Several tags on the reader, present only one',
  NOT_CONNECTED: 'NFC reader not connected',
  LINK_LOST: 'Lost the link to the NFC reader',
  TIMEOUT: 'Tag was not presented in time',
  UNCERTAIN: 'The write may not have finished: check the tag',
  BUSY: 'The NFC reader is busy, try again',
  DRIVER_MISSING: 'NFC driver not installed on the robot',
  [READER_DISABLED]: 'NFC reader is switched off',
};

/**
 * Turn an erase or write error code into a line for the user. Unknown codes are shown
 * as-is: a code we have never seen is more useful than a generic message.
 */
export function describeTagError(code: string | null | undefined): string {
  if (!code) return 'Unknown error';
  return TAG_ERROR_MESSAGES[code] ?? code;
}

// None of these change without restarting the daemon, which drops the
// session. The board is not hot-plugged: the robot is switched off to fit it.
const ABSENT_FOR_GOOD: ReadonlyArray<NfcStatusError> = [
  'NO_BOARD',
  'DRIVER_MISSING',
  'PORT_CONFLICT',
];

/** No reader will show up this session (same rule as the desktop app). */
export function isReaderAbsentForGood(status: NfcStatus): boolean {
  return status.error_code != null && ABSENT_FOR_GOOD.includes(status.error_code);
}

/**
 * Collapse the daemon's status and tag into one state.
 *
 * "disabled" is the user's choice and wins over everything else. A reader
 * that is not connected is "unavailable" only when it is absent for good
 * (or the daemon did not answer); otherwise it is starting, for instance
 * right after being switched back on, and reads as "connecting", or as
 * "not_responding" while the daemon retries a failed link.
 */
export function deriveNfcState(status: NfcStatus | null, tag: NfcTag | null): NfcState {
  if (status?.enabled === false) return 'disabled';
  if (!status) return 'unavailable';
  if (!status.connected) {
    if (isReaderAbsentForGood(status)) return 'unavailable';
    return status.error_code === 'LINK_ERROR' ? 'not_responding' : 'connecting';
  }
  return tag?.present ? 'tag' : 'idle';
}

/**
 * True when the tag holds a payload that is not NDEF (a bare code written
 * straight into memory), which only a full erase removes.
 */
export function needsFullErase(tag: NfcTag | null): boolean {
  if (!tag?.present) return false;
  return Boolean(tag.raw_hex) && (tag.records?.length ?? 0) === 0;
}

/** The daemon's `RAW_PREVIEW_BYTES`. */
const RAW_PREVIEW_BYTES = 32;

export function isRawPreviewTruncated(rawHex: string): boolean {
  return rawHex.length >= RAW_PREVIEW_BYTES * 2;
}

// Driver order: the index of the longest matching prefix is written on the tag.
// prettier-ignore
const URI_PREFIXES = [
  '', 'http://www.', 'https://www.', 'http://', 'https://', 'tel:',
  'mailto:', 'ftp://anonymous:anonymous@', 'ftp://ftp.', 'ftps://',
  'sftp://', 'smb://', 'nfs://', 'ftp://', 'dav://', 'news:',
  'telnet://', 'imap:', 'rtsp://', 'urn:', 'pop:', 'sip:', 'sips:',
  'tftp:', 'btspp://', 'btl2cap://', 'btgoep://', 'tcpobex://',
  'irdaobex://', 'file://', 'urn:epc:id:', 'urn:epc:tag:',
  'urn:epc:pat:', 'urn:epc:raw:', 'urn:epc:', 'urn:nfc:',
];

const TEXT_LANG = 'en';

/** Size of the NDEF message the driver writes (`winnie_nfc.ndef.build_text` / `build_uri`). */
export function ndefMessageBytes(content: NfcWriteContent): number {
  const utf8 = (s: string): number => new TextEncoder().encode(s).length;
  let payload: number;
  if ('uri' in content) {
    const prefix = URI_PREFIXES.reduce(
      (best, p) => (p && content.uri.startsWith(p) && p.length > best.length ? p : best),
      ''
    );
    payload = 1 + utf8(content.uri.slice(prefix.length));
  } else {
    payload = 1 + TEXT_LANG.length + utf8(content.text);
  }
  // Record: header, type length, payload length (1 byte up to 255, else 4), type "T"/"U".
  const record = 2 + (payload <= 0xff ? 1 : 4) + 1 + payload;
  // TLV: tag, length (1 byte up to 254, else 3), message, terminator.
  return 1 + (record <= 0xfe ? 1 : 3) + record + 1;
}
