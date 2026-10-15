import {describe, expect, it} from 'vitest';
import {formatRemaining} from '../src/utils/time';

describe('formatRemaining', () => {
  it.each([
    [-5, 'now'],
    [0, 'now'],
    [1, '0m 01s'],
    [59_000, '0m 59s'],
    [60_000, '1m 00s'],
    [12 * 60_000 + 5_000, '12m 05s'],
    [3_600_000, '1h 00m'],
    [5_100_000, '1h 25m'],
  ])('%i ms -> %s', (ms, want) => {
    expect(formatRemaining(ms)).toBe(want);
  });
});
