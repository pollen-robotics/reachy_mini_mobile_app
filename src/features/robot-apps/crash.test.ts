import { describe, expect, it } from 'vitest';

import { crashSummary } from './crash';

describe('crashSummary', () => {
  it('keeps the exit line and the tail of a long error', () => {
    const error = ['Process exited with code 1', 'a', 'b', 'c', 'd', 'e', 'RuntimeError: x'].join(
      '\n'
    );
    expect(crashSummary(error)).toEqual([
      'Process exited with code 1',
      '…',
      'c',
      'd',
      'e',
      'RuntimeError: x',
    ]);
  });

  it('returns a short error whole', () => {
    expect(crashSummary('Process exited with code -9\n')).toEqual(['Process exited with code -9']);
  });
});
