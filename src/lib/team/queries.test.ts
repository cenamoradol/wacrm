import { describe, it, expect } from 'vitest';
import { computeFirstResponseByAgent } from './queries';

describe('computeFirstResponseByAgent', () => {
  it('records one sample per customer→agent pair in one conversation', () => {
    const out = computeFirstResponseByAgent([
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'agent',
        sender_id: 'agent-A',
        created_at: '2026-08-01T10:05:00Z',
      },
    ]);
    expect(out.get('agent-A')).toEqual([5]);
  });

  it('ignores a second customer message while the first is still pending', () => {
    const out = computeFirstResponseByAgent([
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T10:01:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'agent',
        sender_id: 'agent-A',
        created_at: '2026-08-01T10:04:00Z',
      },
    ]);
    // First customer msg = 4 min wait, second ignored because slot was
    // still pending. Inflating this is the bug we explicitly avoid.
    expect(out.get('agent-A')).toEqual([4]);
  });

  it('does not let bot replies consume the pending customer slot', () => {
    const out = computeFirstResponseByAgent([
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'bot',
        sender_id: 'bot-1',
        created_at: '2026-08-01T10:01:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'agent',
        sender_id: 'agent-A',
        created_at: '2026-08-01T10:03:00Z',
      },
    ]);
    // Bot did NOT count; agent response is measured against the original
    // customer timestamp = 3 min, not 2.
    expect(out.get('agent-A')).toEqual([3]);
  });

  it('returns an empty map when no agent ever replied', () => {
    const out = computeFirstResponseByAgent([
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'bot',
        sender_id: 'bot-1',
        created_at: '2026-08-01T10:01:00Z',
      },
    ]);
    expect(out.size).toBe(0);
  });

  it('splits samples per agent across different conversations', () => {
    const out = computeFirstResponseByAgent([
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'agent',
        sender_id: 'agent-A',
        created_at: '2026-08-01T10:02:00Z',
      },
      {
        conversation_id: 'c2',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T11:00:00Z',
      },
      {
        conversation_id: 'c2',
        sender_type: 'agent',
        sender_id: 'agent-B',
        created_at: '2026-08-01T11:10:00Z',
      },
    ]);
    expect(out.get('agent-A')).toEqual([2]);
    expect(out.get('agent-B')).toEqual([10]);
  });

  it('handles two separate customer→agent cycles in the same conversation', () => {
    const out = computeFirstResponseByAgent([
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'agent',
        sender_id: 'agent-A',
        created_at: '2026-08-01T10:03:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T11:00:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'agent',
        sender_id: 'agent-A',
        created_at: '2026-08-01T11:05:00Z',
      },
    ]);
    expect(out.get('agent-A')).toEqual([3, 5]);
  });

  it('resets the pending slot when a new conversation starts mid-stream', () => {
    const out = computeFirstResponseByAgent([
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T10:00:00Z',
      },
      // No agent reply — pending customer stays open.
      {
        conversation_id: 'c2',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T11:00:00Z',
      },
      {
        conversation_id: 'c2',
        sender_type: 'agent',
        sender_id: 'agent-A',
        created_at: '2026-08-01T11:02:00Z',
      },
    ]);
    // c1's unanswered customer does not leak into c2.
    expect(out.get('agent-A')).toEqual([2]);
  });

  it('drops negative-delta rows defensively (out-of-order input)', () => {
    const out = computeFirstResponseByAgent([
      {
        conversation_id: 'c1',
        sender_type: 'agent',
        sender_id: 'agent-A',
        created_at: '2026-08-01T10:00:00Z',
      },
      {
        conversation_id: 'c1',
        sender_type: 'customer',
        sender_id: null,
        created_at: '2026-08-01T09:00:00Z',
      },
    ]);
    // No customer message before the agent reply, so no sample.
    expect(out.size).toBe(0);
  });
});
