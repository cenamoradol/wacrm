import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  state: {
    accounts: [] as Record<string, unknown>[],
    conversations: [] as Record<string, unknown>[],
    summaries: [] as Record<string, unknown>[],
    updates: [] as { payload: Record<string, unknown> }[],
  },
}));

vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: h.sendMessage,
  SendMessageError: class SendMessageError extends Error {
    code: string;
    status: number;
    constructor(code: string, message: string, status: number) {
      super(message);
      this.name = 'SendMessageError';
      this.code = code;
      this.status = status;
    }
  },
}));

import {
  summarizeThreads,
  decideAutoArchive,
  sweepInactiveConversations,
  CUSTOMER_WINDOW_HOURS,
  type ThreadSummary,
} from './auto-archive';

// ---------------------------------------------------------------
// Fake Supabase client
// ---------------------------------------------------------------

type Filter = {
  op: 'eq' | 'not' | 'in' | 'lt';
  column: string;
  value: unknown;
};

function applyFilters(
  rows: Record<string, unknown>[],
  filters: Filter[]
): Record<string, unknown>[] {
  return rows.filter((row) =>
    filters.every((f) => {
      const v = row[f.column];
      switch (f.op) {
        case 'eq':
          return v === f.value;
        case 'not':
          // `.not(column, 'is', null)` — keep rows where the column is set.
          return f.value === null ? v !== null : true;
        case 'in':
          return Array.isArray(f.value) && f.value.includes(v);
        case 'lt':
          return typeof v === 'string' && v < (f.value as string);
        default:
          return true;
      }
    })
  );
}

function createFakeDb() {
  const db = {
    from(table: string) {
      const filters: Filter[] = [];
      let limit: number | null = null;

      const rows = () => {
        const source =
          table === 'accounts'
            ? h.state.accounts
            : table === 'conversations'
              ? h.state.conversations
              : [];
        const filtered = applyFilters(source, filters);
        return limit === null ? filtered : filtered.slice(0, limit);
      };

      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (payload: Record<string, unknown>) => {
          if (table === 'conversations') h.state.updates.push({ payload });
          return chain;
        },
        eq: (column: string, value: unknown) => {
          filters.push({ op: 'eq', column, value });
          return chain;
        },
        in: (column: string, value: unknown) => {
          filters.push({ op: 'in', column, value });
          return chain;
        },
        not: (column: string, _op: string, value: unknown) => {
          filters.push({ op: 'not', column, value });
          return chain;
        },
        lt: (column: string, value: unknown) => {
          filters.push({ op: 'lt', column, value });
          return chain;
        },
        order: () => chain,
        limit: (n: number) => {
          limit = n;
          return chain;
        },
        then: (
          resolve: (value: { data: unknown; error: null }) => unknown,
          reject: (reason: unknown) => unknown
        ) =>
          Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
      };
      return chain;
    },
    rpc: () => Promise.resolve({ data: h.state.summaries, error: null }),
  };
  return db as unknown as SupabaseClient;
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

const NOW = new Date('2026-01-01T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * HOUR).toISOString();
}

function accountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-1',
    auto_archive_enabled: true,
    auto_archive_after_hours: 2,
    auto_archive_message: 'We closed this chat. Write us again anytime.',
    ...overrides,
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    account_id: 'acct-1',
    archived: false,
    status: 'open',
    assigned_agent_id: 'agent-1',
    last_message_at: hoursAgo(3),
    ...overrides,
  };
}

function messageRow(
  conversationId: string,
  senderType: 'customer' | 'agent' | 'bot',
  createdAt: string
) {
  return {
    conversation_id: conversationId,
    last_sender_type: senderType,
    last_at: createdAt,
    last_customer_at: senderType === 'customer' ? createdAt : null,
  };
}

beforeEach(() => {
  h.state.accounts = [];
  h.state.conversations = [];
  h.state.summaries = [];
  h.state.updates = [];
  h.sendMessage.mockReset();
  h.sendMessage.mockResolvedValue({ messageId: 'm1', whatsappMessageId: 'w1' });
});

// ---------------------------------------------------------------
// summarizeThreads
// ---------------------------------------------------------------

describe('summarizeThreads', () => {
  it('maps the RPC rows onto per-thread facts', () => {
    const threads = summarizeThreads([
      messageRow('conv-1', 'customer', hoursAgo(1)),
      messageRow('conv-2', 'agent', hoursAgo(3)),
    ]);

    expect(threads.get('conv-1')).toEqual({
      lastAt: hoursAgo(1),
      lastSender: 'customer',
      lastCustomerAt: hoursAgo(1),
    });
    expect(threads.get('conv-2')).toEqual({
      lastAt: hoursAgo(3),
      lastSender: 'agent',
      lastCustomerAt: null,
    });
  });

  it('keeps the customer timestamp when the agent spoke last', () => {
    const threads = summarizeThreads([
      {
        conversation_id: 'conv-1',
        last_sender_type: 'agent',
        last_at: hoursAgo(3),
        last_customer_at: hoursAgo(3.5),
      },
    ]);

    expect(threads.get('conv-1')).toEqual({
      lastAt: hoursAgo(3),
      lastSender: 'agent',
      lastCustomerAt: hoursAgo(3.5),
    });
  });
});

// ---------------------------------------------------------------
// decideAutoArchive
// ---------------------------------------------------------------

function summary(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    lastAt: hoursAgo(3),
    lastSender: 'agent',
    lastCustomerAt: hoursAgo(3.5),
    ...overrides,
  };
}

describe('decideAutoArchive', () => {
  const options = { hours: 2, message: 'closed' };

  it('skips a thread with no messages', () => {
    expect(decideAutoArchive(undefined, options, NOW)).toEqual({
      action: 'skip',
      reason: 'no_messages',
    });
  });

  it('skips a thread the customer wrote last', () => {
    expect(
      decideAutoArchive(summary({ lastSender: 'customer' }), options, NOW)
    ).toEqual({ action: 'skip', reason: 'customer_spoke_last' });
  });

  it('skips a thread whose last message came from a bot', () => {
    expect(
      decideAutoArchive(summary({ lastSender: 'bot' }), options, NOW)
    ).toEqual({ action: 'skip', reason: 'customer_spoke_last' });
  });

  it('skips a thread that is not idle long enough', () => {
    expect(
      decideAutoArchive(summary({ lastAt: hoursAgo(1) }), options, NOW)
    ).toEqual({ action: 'skip', reason: 'not_idle_long_enough' });
  });

  it('archives without a notice when the customer never wrote', () => {
    expect(
      decideAutoArchive(summary({ lastCustomerAt: null }), options, NOW)
    ).toEqual({ action: 'archive', notify: false });
  });

  it('archives without a notice outside the 24h customer window', () => {
    const decision = decideAutoArchive(
      summary({
        lastAt: hoursAgo(CUSTOMER_WINDOW_HOURS + 2),
        lastCustomerAt: hoursAgo(CUSTOMER_WINDOW_HOURS + 3),
      }),
      options,
      NOW
    );
    expect(decision).toEqual({ action: 'archive', notify: false });
  });

  it('notifies the customer inside the 24h customer window', () => {
    const decision = decideAutoArchive(
      summary({ lastCustomerAt: hoursAgo(CUSTOMER_WINDOW_HOURS - 1) }),
      options,
      NOW
    );
    expect(decision).toEqual({ action: 'notify', message: 'closed' });
  });
});

// ---------------------------------------------------------------
// sweepInactiveConversations
// ---------------------------------------------------------------

describe('sweepInactiveConversations', () => {
  it('notifies the customer and archives the thread', async () => {
    h.state.accounts = [accountRow()];
    h.state.conversations = [conversationRow()];
    h.state.summaries = [
      {
        conversation_id: 'conv-1',
        last_sender_type: 'agent',
        last_at: hoursAgo(3),
        last_customer_at: hoursAgo(3.5),
      },
    ];

    const result = await sweepInactiveConversations(createFakeDb(), NOW);

    expect(result).toMatchObject({
      accounts: 1,
      candidates: 1,
      archived: 1,
      notified: 1,
      failed: 0,
    });
    expect(h.sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      expect.objectContaining({
        conversationId: 'conv-1',
        messageType: 'text',
        contentText: 'We closed this chat. Write us again anytime.',
        skipFlowPause: true,
      })
    );
    expect(h.state.updates).toEqual([
      { payload: { archived: true, auto_archived_at: NOW.toISOString() } },
    ]);
  });

  it('archives silently when the customer is outside the 24h window', async () => {
    h.state.accounts = [accountRow()];
    h.state.conversations = [
      conversationRow({ last_message_at: hoursAgo(30) }),
    ];
    h.state.summaries = [
      {
        conversation_id: 'conv-1',
        last_sender_type: 'agent',
        last_at: hoursAgo(30),
        last_customer_at: hoursAgo(31),
      },
    ];

    const result = await sweepInactiveConversations(createFakeDb(), NOW);

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ archived: 1, notified: 0, failed: 0 });
    expect(h.state.updates).toHaveLength(1);
  });

  it('leaves a thread alone when the customer spoke last', async () => {
    h.state.accounts = [accountRow()];
    h.state.conversations = [conversationRow()];
    h.state.summaries = [
      {
        conversation_id: 'conv-1',
        last_sender_type: 'customer',
        last_at: hoursAgo(5),
        last_customer_at: hoursAgo(5),
      },
    ];

    const result = await sweepInactiveConversations(createFakeDb(), NOW);

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ archived: 0, notified: 0, failed: 0 });
    expect(h.state.updates).toHaveLength(0);
  });

  it('does not archive when the notice could not be sent', async () => {
    const { SendMessageError } = await import('@/lib/whatsapp/send-message');
    h.sendMessage.mockRejectedValue(
      new SendMessageError('meta_error', 'boom', 502)
    );
    h.state.accounts = [accountRow()];
    h.state.conversations = [conversationRow()];
    h.state.summaries = [
      {
        conversation_id: 'conv-1',
        last_sender_type: 'agent',
        last_at: hoursAgo(3),
        last_customer_at: hoursAgo(3.5),
      },
    ];

    const result = await sweepInactiveConversations(createFakeDb(), NOW);

    expect(result).toMatchObject({ archived: 0, notified: 0, failed: 1 });
    expect(h.state.updates).toHaveLength(0);
  });

  it('archives without a notice when the account has no message text', async () => {
    h.state.accounts = [accountRow({ auto_archive_message: '   ' })];
    h.state.conversations = [conversationRow()];
    h.state.summaries = [
      {
        conversation_id: 'conv-1',
        last_sender_type: 'agent',
        last_at: hoursAgo(3),
        last_customer_at: hoursAgo(3.5),
      },
    ];

    const result = await sweepInactiveConversations(createFakeDb(), NOW);

    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ archived: 1, notified: 0, failed: 0 });
  });

  it('archives without a notice when the contact can never be reached', async () => {
    const { SendMessageError } = await import('@/lib/whatsapp/send-message');
    h.sendMessage.mockRejectedValue(
      new SendMessageError('bad_request', 'Contact phone number not found', 400)
    );
    h.state.accounts = [accountRow()];
    h.state.conversations = [conversationRow()];
    h.state.summaries = [
      {
        conversation_id: 'conv-1',
        last_sender_type: 'agent',
        last_at: hoursAgo(3),
        last_customer_at: hoursAgo(3.5),
      },
    ];

    const result = await sweepInactiveConversations(createFakeDb(), NOW);

    expect(result).toMatchObject({ archived: 1, notified: 0, failed: 0 });
    expect(h.state.updates).toHaveLength(1);
  });

  it('ignores conversations that are archived or unassigned', async () => {
    h.state.accounts = [accountRow()];
    h.state.conversations = [
      conversationRow({ id: 'conv-archived', archived: true }),
      conversationRow({ id: 'conv-unassigned', assigned_agent_id: null }),
      conversationRow({ id: 'conv-closed', status: 'closed' }),
    ];
    h.state.summaries = [
      messageRow('conv-archived', 'agent', hoursAgo(3)),
      messageRow('conv-unassigned', 'agent', hoursAgo(3)),
      messageRow('conv-closed', 'agent', hoursAgo(3)),
    ];

    const result = await sweepInactiveConversations(createFakeDb(), NOW);

    expect(result).toMatchObject({ candidates: 0, archived: 0 });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('skips accounts that did not switch the feature on', async () => {
    h.state.accounts = [accountRow({ auto_archive_enabled: false })];
    h.state.conversations = [conversationRow()];
    h.state.summaries = [messageRow('conv-1', 'agent', hoursAgo(3))];

    const result = await sweepInactiveConversations(createFakeDb(), NOW);

    expect(result).toMatchObject({ accounts: 0, candidates: 0, archived: 0 });
  });
});
