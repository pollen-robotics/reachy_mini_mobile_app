/**
 * The Bluetooth tools' protocol helpers.
 *
 * `CMD_<NAME>` is the awkward one: the robot never acks a successful script
 * (it blocks, then replies nothing), so the phone sees a transport timeout
 * or a stale reply. These tests pin that only an explicit `ERROR:` (or the
 * old-firmware `ECHO:`) is a failure, and that the transport is mocked out -
 * no plugin, no radio.
 */
import { beforeEach, expect, it, vi } from 'vitest';

const sendCommandMock = vi.fn();
const readCharacteristicMock = vi.fn();

async function load() {
  vi.resetModules();
  vi.doMock('@/features/ble/bleWifi', () => ({
    AVAILABLE_COMMANDS_CHAR: 'cdef6',
    sendCommand: sendCommandMock,
    readCharacteristic: readCharacteristicMock,
  }));
  return import('./toolsProtocol');
}

beforeEach(() => {
  sendCommandMock.mockReset();
  readCharacteristicMock.mockReset();
});

it('parses the AVAILABLE_COMMANDS list', async () => {
  const { parseAvailableCommands } = await load();

  expect(parseAvailableCommands('HOTSPOT, RESTART_DAEMON, SOFTWARE_RESET, WIFI_RESET')).toEqual([
    'HOTSPOT',
    'RESTART_DAEMON',
    'SOFTWARE_RESET',
    'WIFI_RESET',
  ]);
  expect(parseAvailableCommands('HOTSPOT,HOTSPOT , ')).toEqual(['HOTSPOT']);
});

it.each(['None', 'none', '', null])('treats %j as no scripts', async raw => {
  const { parseAvailableCommands } = await load();

  expect(parseAvailableCommands(raw)).toEqual([]);
});

it.each(['', 'OK: Connected', 'PONG', 'anything else'])(
  'reads %j as a dispatched script',
  async reply => {
    const { interpretScriptReply } = await load();

    expect(interpretScriptReply(reply)).toEqual({ ok: true });
  }
);

it('reads an ERROR reply as a failure, without the prefix', async () => {
  const { interpretScriptReply } = await load();

  expect(interpretScriptReply("ERROR: Command 'X.sh' not found")).toEqual({
    ok: false,
    message: "Command 'X.sh' not found",
  });
  expect(interpretScriptReply('ERROR:')).toMatchObject({ ok: false });
});

it('reads an ECHO reply as unsupported firmware', async () => {
  const { interpretScriptReply } = await load();

  expect(interpretScriptReply('ECHO: CMD_HOTSPOT')).toMatchObject({ ok: false });
});

it('flags a full journal chunk even after the reply was trimmed', async () => {
  const { isFullJournalChunk, JOURNAL_CHUNK_CHARS } = await load();

  expect(isFullJournalChunk('x'.repeat(JOURNAL_CHUNK_CHARS))).toBe(true);
  expect(isFullJournalChunk('x'.repeat(JOURNAL_CHUNK_CHARS - 1))).toBe(true);
  expect(isFullJournalChunk('x'.repeat(200))).toBe(false);
  expect(isFullJournalChunk('')).toBe(false);
});

it('runScript settles a transport error with a PING and throws on ERROR', async () => {
  const { runScript } = await load();

  // Blocked/failed write (the robot never acks a script), link still up → ran.
  sendCommandMock.mockRejectedValueOnce(new Error('write CMD_HOTSPOT timed out after 8000ms'));
  sendCommandMock.mockResolvedValueOnce('PONG');
  await expect(runScript('HOTSPOT')).resolves.toBeUndefined();

  // Stale sync reply (the PIN_ ack) → ran.
  sendCommandMock.mockResolvedValueOnce('OK: Connected');
  await expect(runScript('RESTART_DAEMON')).resolves.toBeUndefined();

  sendCommandMock.mockResolvedValueOnce('ERROR: Not connected. Please authenticate first.');
  await expect(runScript('RESTART_DAEMON')).rejects.toThrow('Not connected');

  // Write failed AND the link is gone → the original error surfaces.
  sendCommandMock.mockRejectedValueOnce(new Error('Characteristic cdef1 not available'));
  sendCommandMock.mockRejectedValueOnce(new Error('write PING timed out after 8000ms'));
  await expect(runScript('RESTART_DAEMON')).rejects.toThrow('not available');

  // A non-Error rejection (the native plugin) is still reported as an Error.
  sendCommandMock.mockRejectedValueOnce(undefined);
  sendCommandMock.mockRejectedValueOnce(undefined);
  await expect(runScript('RESTART_DAEMON')).rejects.toBeInstanceOf(Error);

  expect(sendCommandMock.mock.calls.map(([cmd]) => cmd)).toEqual([
    'CMD_HOTSPOT',
    'PING',
    'CMD_RESTART_DAEMON',
    'CMD_RESTART_DAEMON',
    'CMD_RESTART_DAEMON',
    'PING',
    'CMD_RESTART_DAEMON',
    'PING',
  ]);
});

it('journalRead returns the chunk, empty when idle, and throws when not running', async () => {
  const { journalRead } = await load();

  sendCommandMock.mockResolvedValueOnce('Sep 18 10:00:00 reachy daemon[1]: hello');
  await expect(journalRead()).resolves.toBe('Sep 18 10:00:00 reachy daemon[1]: hello');

  sendCommandMock.mockResolvedValueOnce('');
  await expect(journalRead()).resolves.toBe('');

  sendCommandMock.mockResolvedValueOnce('ERROR: Journal not running');
  await expect(journalRead()).rejects.toThrow('Journal not running');
});

it('readAvailableCommands falls back to an empty list', async () => {
  const { readAvailableCommands } = await load();

  readCharacteristicMock.mockResolvedValueOnce('HOTSPOT, RESTART_DAEMON');
  await expect(readAvailableCommands()).resolves.toEqual(['HOTSPOT', 'RESTART_DAEMON']);

  readCharacteristicMock.mockRejectedValueOnce(new Error('read cdef6 timed out after 6000ms'));
  await expect(readAvailableCommands()).resolves.toEqual([]);
});
