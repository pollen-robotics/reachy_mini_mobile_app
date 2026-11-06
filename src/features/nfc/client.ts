/**
 * Typed client for the daemon's NFC reader, over the SDK's JSON-RPC
 * (`rpcCall`, answered by the daemon's `jsonrpc_relay.py` across the WebRTC
 * data channel). The `nfc.*` methods mirror the desktop's `/api/nfc` routes,
 * which the phone cannot reach.
 */
import { rpcErrorReason, type ReachyMiniInstance } from '@/features/robot-session/sdk-types';

import { READER_DISABLED } from './nfcState';
import type { NfcStatus, NfcTag, NfcTagResult, NfcWriteContent } from './nfcState';

const READ_TIMEOUT_MS = 3_000;
// The daemon waits up to 15 s for a tag before answering an erase, and a full
// erase writes every page; leave room on top of that.
const ERASE_TIMEOUT_MS = 25_000;
// The daemon waits up to 6 s for a tag before answering a write.
const WRITE_TIMEOUT_MS = 12_000;
// Switching off joins the daemon's reader thread, which answers within a poll.
const TOGGLE_TIMEOUT_MS = 8_000;

export interface NfcClient {
  status(): Promise<NfcStatus>;
  tag(): Promise<NfcTag>;
  setEnabled(enabled: boolean): Promise<NfcStatus>;
  /** Never rejects: every failure is folded into the result. */
  erase(full: boolean): Promise<NfcTagResult>;
  /** Never rejects: every failure is folded into the result. */
  write(content: NfcWriteContent): Promise<NfcTagResult>;
}

/** Run one tag-modifying call, folding every failure into the result. */
async function tagOperation(
  label: string,
  call: () => Promise<NfcTagResult>
): Promise<NfcTagResult> {
  try {
    return await call();
  } catch (err) {
    const reason = rpcErrorReason(err);
    if (reason === 'nfc_disabled') return { success: false, error: READER_DISABLED };
    if (reason) return { success: false, error: `${label} request failed (${reason})` };
    return { success: false, error: 'LINK_LOST' };
  }
}

export function createNfcClient(robot: ReachyMiniInstance): NfcClient {
  return {
    status() {
      return robot.rpcCall<NfcStatus>('nfc.status', {}, { timeoutMs: READ_TIMEOUT_MS });
    },
    tag() {
      return robot.rpcCall<NfcTag>('nfc.tag', {}, { timeoutMs: READ_TIMEOUT_MS });
    },
    setEnabled(enabled) {
      return robot.rpcCall<NfcStatus>(
        'nfc.set_enabled',
        { enabled },
        { timeoutMs: TOGGLE_TIMEOUT_MS }
      );
    },
    erase(full) {
      return tagOperation(full ? 'NFC full erase' : 'NFC erase', () =>
        robot.rpcCall<NfcTagResult>('nfc.erase', { full }, { timeoutMs: ERASE_TIMEOUT_MS })
      );
    },
    write(content) {
      return tagOperation('NFC write', () =>
        robot.rpcCall<NfcTagResult>('nfc.write', content, { timeoutMs: WRITE_TIMEOUT_MS })
      );
    },
  };
}
