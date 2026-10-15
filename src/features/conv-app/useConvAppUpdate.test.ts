/** The About panel's conversation-app update flow, against a fake daemon. */
import { describe, expect, it, vi } from 'vitest';

import type { ConvAppClient, ConvAppUpdate } from './client';
import { readUpdateState, runUpdate } from './useConvAppUpdate';

function fakeClient(checks: Array<ConvAppUpdate | Error>) {
  return {
    checkConvAppUpdate: vi.fn(async () => {
      const next = checks.shift();
      if (next instanceof Error || next === undefined) throw next ?? new Error('no more');
      return next;
    }),
    updateConvApp: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConvAppClient & { updateConvApp: ReturnType<typeof vi.fn> };
}

const base: ConvAppUpdate = {
  installed: true,
  version: '1.0.1',
  update_available: false,
  updating: false,
  error: null,
};
const state = async (reply: ConvAppUpdate | Error) =>
  (await readUpdateState(fakeClient([reply]))).state;

describe('readUpdateState', () => {
  it('maps the daemon reply to what the panel shows', async () => {
    expect(await readUpdateState(fakeClient([{ ...base, update_available: true }]))).toEqual({
      state: 'available',
      version: '1.0.1',
    });
    expect(await state(base)).toBe('up-to-date');
    expect(await state({ ...base, installed: false })).toBe('not-installed');
    expect(await state({ ...base, updating: true })).toBe('updating');
    expect(await state({ ...base, error: 'boom' })).toBe('failed');
  });

  it('reads an old daemon without the verb as unknown', async () => {
    expect(await readUpdateState(fakeClient([new Error('method_not_found')]))).toEqual({
      state: 'unknown',
      version: null,
    });
  });
});

describe('runUpdate', () => {
  const current = { state: 'available' as const, version: '1.0.1' };

  it('polls until the background update ends, keeping the old version meanwhile', async () => {
    const client = fakeClient([
      { ...base, version: null, updating: true },
      { ...base, version: '1.1.0' },
    ]);
    const views: unknown[] = [];

    const final = await runUpdate(
      client,
      current,
      v => views.push(v),
      async () => {}
    );

    expect(client.updateConvApp).toHaveBeenCalledOnce();
    expect(final).toEqual({ state: 'up-to-date', version: '1.1.0' });
    expect(views).toEqual([{ state: 'updating', version: '1.0.1' }, final]);
  });

  it('reports a failed update', async () => {
    const client = fakeClient([{ ...base, error: 'space not found' }]);
    expect(
      (
        await runUpdate(
          client,
          current,
          () => {},
          async () => {}
        )
      ).state
    ).toBe('failed');
  });
});
