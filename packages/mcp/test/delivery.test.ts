import { describe, expect, it, vi } from 'vitest';
import { deliveryStatus, type PresenceView } from '../src/delivery';

/** Presence that answers for ONE username — anyone else is absent. */
const presenceOf = (...online: string[]): PresenceView => ({
  presenceObserved: true,
  isOnline: (username) => online.includes(username),
});

describe('deliveryStatus', () => {
  it('reports a connected session as a session, never as a delivery', () => {
    const text = deliveryStatus('bob', presenceOf('bob'));
    expect(text).toContain('presence');
    expect(text).not.toContain('✅');
    expect(text).toMatch(/not a delivery receipt/);
  });

  it('tells where the message waits when no session is connected', () => {
    expect(deliveryStatus('bob', presenceOf())).toContain('inbox');
  });

  it('asks about THIS recipient, not whoever happens to be online', () => {
    // The bug this guards: reporting someone else's presence as the recipient's.
    // A fixture whose isOnline ignores its argument would let that through.
    expect(deliveryStatus('bob', presenceOf('alice'))).toContain('no session seen');
    const isOnline = vi.fn((u: string) => u === 'bob');
    deliveryStatus('bob', { presenceObserved: true, isOnline });
    expect(isOnline).toHaveBeenCalledWith('bob');
  });

  it('admits it observed nothing until presence has synced once', () => {
    // Not the same as "nobody is connected": between start() and the first sync
    // the online set is empty because nothing has been read yet.
    const isOnline = vi.fn(() => true);
    expect(deliveryStatus('bob', { presenceObserved: false, isOnline })).toContain(
      'nothing observed',
    );
    expect(isOnline).not.toHaveBeenCalled();
  });

  it('every state leads with the one fact it has', () => {
    const states = [
      deliveryStatus('bob', presenceOf('bob')),
      deliveryStatus('bob', presenceOf()),
      deliveryStatus('bob', { presenceObserved: false, isOnline: () => false }),
    ];
    for (const state of states) expect(state.startsWith('📤 sent')).toBe(true);
    expect(new Set(states).size).toBe(states.length);
  });
});
