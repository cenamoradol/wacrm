import { describe, it, expect } from 'vitest';
import {
  canReceiveConversations,
  filterByParticipants,
  pickAutoAssignCandidate,
  type AutoAssignCandidate,
} from './auto-assign';

function candidate(
  overrides: Partial<AutoAssignCandidate> & { user_id: string }
): AutoAssignCandidate {
  return {
    full_name: overrides.user_id,
    openLoad: 0,
    lastActivityAt: 0,
    presence: 'offline',
    ...overrides,
  };
}

describe('canReceiveConversations', () => {
  it('accepts every role that can reply', () => {
    expect(canReceiveConversations('owner')).toBe(true);
    expect(canReceiveConversations('admin')).toBe(true);
    expect(canReceiveConversations('agent')).toBe(true);
  });

  it('excludes viewers (read-only) and unknown roles', () => {
    expect(canReceiveConversations('viewer')).toBe(false);
    expect(canReceiveConversations(null)).toBe(false);
    expect(canReceiveConversations('nonsense')).toBe(false);
  });
});

describe('filterByParticipants', () => {
  const pool = [
    candidate({ user_id: 'a' }),
    candidate({ user_id: 'b' }),
    candidate({ user_id: 'c' }),
  ];

  it('keeps everyone when no explicit list is set', () => {
    expect(filterByParticipants(pool)).toHaveLength(3);
  });

  it('keeps only the members the step allows', () => {
    expect(filterByParticipants(pool, ['b']).map((c) => c.user_id)).toEqual([
      'b',
    ]);
  });

  it('returns nobody when the list is explicitly empty', () => {
    expect(filterByParticipants(pool, [])).toEqual([]);
  });

  it('ignores ids that are not in the pool', () => {
    expect(filterByParticipants(pool, ['zzz'])).toEqual([]);
  });
});

describe('pickAutoAssignCandidate', () => {
  it('returns null when nobody can take the conversation', () => {
    expect(pickAutoAssignCandidate([])).toBeNull();
  });

  it('prefers an online member over an offline one with a lower load', () => {
    const picked = pickAutoAssignCandidate([
      candidate({ user_id: 'a', openLoad: 0, presence: 'offline' }),
      candidate({ user_id: 'b', openLoad: 9, presence: 'online' }),
    ]);
    expect(picked?.user_id).toBe('b');
  });

  it('spreads the load: fewest open conversations wins', () => {
    const picked = pickAutoAssignCandidate([
      candidate({ user_id: 'a', openLoad: 3 }),
      candidate({ user_id: 'b', openLoad: 1 }),
      candidate({ user_id: 'c', openLoad: 2 }),
    ]);
    expect(picked?.user_id).toBe('b');
  });

  it('rotates to the least recently active member', () => {
    const picked = pickAutoAssignCandidate([
      candidate({ user_id: 'a', lastActivityAt: 3_000 }),
      candidate({ user_id: 'b', lastActivityAt: 1_000 }),
      candidate({ user_id: 'c', lastActivityAt: 2_000 }),
    ]);
    expect(picked?.user_id).toBe('b');
  });

  it('sends the conversation to a member with no activity at all', () => {
    const picked = pickAutoAssignCandidate([
      candidate({ user_id: 'a', lastActivityAt: 5_000 }),
      candidate({ user_id: 'b', lastActivityAt: 0 }),
    ]);
    expect(picked?.user_id).toBe('b');
  });

  it('breaks ties deterministically by user_id', () => {
    const picked = pickAutoAssignCandidate([
      candidate({ user_id: 'zzz' }),
      candidate({ user_id: 'aaa' }),
      candidate({ user_id: 'mmm' }),
    ]);
    expect(picked?.user_id).toBe('aaa');
  });

  it('does not mutate the input array', () => {
    const candidates = [
      candidate({ user_id: 'b', openLoad: 1 }),
      candidate({ user_id: 'a', openLoad: 0 }),
    ];
    pickAutoAssignCandidate(candidates);
    expect(candidates.map((c) => c.user_id)).toEqual(['b', 'a']);
  });
});
