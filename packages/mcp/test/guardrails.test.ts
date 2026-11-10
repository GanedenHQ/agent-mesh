import { describe, expect, it } from 'vitest';
import { checkQuota, limitsFromEnv, LoopGuardError, nextHop } from '../src/guardrails';

const limits = { hopLimit: 3, quotaPerMin: 2 };

describe('nextHop', () => {
  it('starts at 0 on a new thread', () => {
    expect(nextHop(null, limits)).toBe(0);
  });

  it('adds one per bounce between sessions', () => {
    expect(nextHop({ hop: 0, lastFromHuman: false }, limits)).toBe(1);
    expect(nextHop({ hop: 2, lastFromHuman: false }, limits)).toBe(3);
  });

  it('resets after a human message', () => {
    expect(nextHop({ hop: 3, lastFromHuman: true }, limits)).toBe(0);
  });

  it('refuses past the limit', () => {
    expect(() => nextHop({ hop: 3, lastFromHuman: false }, limits)).toThrow(LoopGuardError);
    expect(() => nextHop({ hop: 3, lastFromHuman: false }, limits)).toThrow(/loop guard/);
  });
});

describe('checkQuota', () => {
  it('counts only the last 60 seconds', () => {
    const now = 1_000_000;
    expect(checkQuota([now - 61_000, now - 1_000], now, limits)).toEqual([now - 1_000, now]);
  });

  it('refuses once the window is full', () => {
    const now = 1_000_000;
    expect(() => checkQuota([now - 2_000, now - 1_000], now, limits)).toThrow(/rate limit/);
  });
});

describe('limitsFromEnv', () => {
  it('reads positive integers and falls back otherwise', () => {
    expect(limitsFromEnv({ MESH_HOP_LIMIT: '5', MESH_QUOTA_PER_MIN: 'x' })).toEqual({
      hopLimit: 5,
      quotaPerMin: 30,
    });
    expect(limitsFromEnv({ MESH_HOP_LIMIT: '0' }).hopLimit).toBe(12);
  });
});
