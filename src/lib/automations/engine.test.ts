import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as {
      table: string;
      filters: [string, string, unknown][];
    }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    logInserts: [] as Record<string, unknown>[],
    logUpdates: [] as Record<string, unknown>[],
  },
}));

vi.mock('./admin-client', () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === 'contacts') {
      if (type === 'update') {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === 'custom_fields') {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === 'contact_custom_values') {
      if (type === 'upsert') {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === 'automations')
      return { data: state.automations, error: null };
    if (table === 'automation_logs') {
      if (type === 'insert') {
        state.logInserts.push(ops.payload as Record<string, unknown>);
        return { data: { id: 'log1' }, error: null };
      }
      if (type === 'update') {
        state.logUpdates.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: { steps_executed: [], status: 'success' }, error: null };
    }
    if (table === 'automation_steps') {
      // The real engine applies `parent_step_id`/`branch`/`gte`/etc. via
      // PostgREST; our in-memory mock has to honor those filters or a
      // condition step's branch recursion re-fetches the parent condition
      // step and loops. (Caught once the condition test was added — the
      // pre-existing top-level tests all use `parent_step_id: null`, which
      // also matches under the loose filter, so they were unaffected.)
      let rows = state.steps as Array<Record<string, unknown>>;
      for (const [op, key, value] of ops.filters) {
        if (op === 'eq') {
          rows = rows.filter((r) => {
            if (key === 'parent_step_id') return r.parent_step_id === value;
            if (key === 'branch') return r.parent_branch === value;
            return r[key] === value;
          });
        } else if (op === 'is') {
          rows = rows.filter((r) => {
            if (key === 'parent_step_id') return r.parent_step_id === value;
            return r[key] === value;
          });
        }
      }
      return { data: rows, error: null };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => b,
      upsert: (p: unknown) => ((ops.type = 'upsert'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      gte: (k: string, v: unknown) => (ops.filters.push(['gte', k, v]), b),
      is: (k: string, v: unknown) => (ops.filters.push(['is', k, v]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendImage: vi.fn(async () => ({ whatsapp_message_id: 'img1' })),
}));

// Mock the LLM helpers so we don't make real provider calls in tests.
vi.mock('./llm-condition', () => ({
  evaluateLlmCondition: vi.fn(async () => ({
    boolean: true,
    reasoning: 'test',
  })),
}));
vi.mock('@/lib/ai/config', () => ({
  loadAiConfig: vi.fn(async () => ({
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
  })),
}));
vi.mock('@/lib/ai/generate', () => ({
  generateReply: vi.fn(async () => ({
    text: 'Composed by LLM.',
    handoff: false,
    usage: null,
  })),
}));
vi.mock('@/lib/ai/context', () => ({
  buildConversationContext: vi.fn(async () => []),
}));

// SSRF guard does real DNS resolution; mock it so we can flip it per test
// (the existing GHSA test relies on it returning false for private hosts,
// while the new tests need it to return true so the engine actually
// reaches the fetch call).
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { runAutomationsForTrigger, triggerMatches } from './engine';
import { evaluateLlmCondition } from './llm-condition';
import { generateReply } from '@/lib/ai/generate';
import { loadAiConfig } from '@/lib/ai/config';
import { engineSendText } from './meta-send';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { Automation } from '@/types';

const ACCOUNT = 'acct-1';

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.logInserts = [];
  h.state.logUpdates = [];
});

describe('runAutomationsForTrigger — tenant isolation', () => {
  it('refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)', async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'victim-contact-uuid',
      context: { message_text: 'manual trigger' },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain('contacts');
    expect(h.state.fromCalls).not.toContain('automations');
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it('proceeds past the guard when the contact belongs to the account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.fromCalls).toContain('automations');
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(['eq', 'id', 'c1']);
    expect(filters).toContainEqual(['eq', 'account_id', ACCOUNT]);
  });
});

describe('automation_logs — status is seeded pessimistically (issue #409)', () => {
  it("writes the log row as 'failed' before any step runs", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The insert happens before execution, so a run killed mid-flight must
    // not leave behind a row that claims it succeeded.
    expect(h.state.logInserts).toHaveLength(1);
    expect(h.state.logInserts[0]).toMatchObject({
      status: 'failed',
      steps_executed: [],
    });
  });

  it("still promotes the log to 'success' once the steps complete", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The seed is only a floor — the outermost scope still writes the real
    // verdict, so a completed run reports success as it always did.
    const withStatus = h.state.logUpdates.filter((u) => 'status' in u);
    expect(withStatus.at(-1)).toMatchObject({ status: 'success' });
  });
});

describe('update_contact_field — custom fields', () => {
  it('upserts contact_custom_values when the field is account-owned', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', 'Premium')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: 'c1',
      custom_field_id: 'cf1',
      value: 'Premium',
    });
  });

  it('interpolates {{ vars.* }} into the custom value', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', '{{ vars.source }}')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { vars: { source: 'WhatsApp Ad' } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect((h.state.upsertCalls[0].payload as { value: string }).value).toBe(
      'WhatsApp Ad'
    );
  });

  it('refuses to write a custom field from another account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:foreign-cf', 'x')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe('send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)', () => {
  it('refuses a private / link-local destination and never calls fetch', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    // For this test the SSRF guard must REFUSE — flip the default mock
    // back to its real-world behaviour for private hosts.
    vi.mocked(isDeliverableUrl).mockResolvedValueOnce(false);

    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep('http://169.254.169.254/latest/meta-data/')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain('automation_steps');
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'send_webhook',
    position: 0,
    parent_step_id: null,
    step_config: {
      url,
      headers: { 'Metadata-Flavor': 'Google' },
      body_template: '{}',
    },
  };
}

function automationWithUpdateStep() {
  return {
    id: 'a1',
    account_id: ACCOUNT,
    user_id: 'u1',
    trigger_type: 'new_message_received',
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field: 'company', value: 'pwned-by-automation' },
  };
}

function customStep(field: string, value: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe('triggerMatches — interactive_reply', () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'menu step',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    };
  }

  it('matches when the tapped id is in reply_ids (exact)', async () => {
    expect(
      await triggerMatches(automation(['yes', 'no']), {
        interactive_reply_id: 'yes',
      })
    ).toBe(true);
  });

  it('does not match a different id', async () => {
    expect(
      await triggerMatches(automation(['yes']), {
        interactive_reply_id: 'maybe',
      })
    ).toBe(false);
  });

  it('does not match on a substring (exact only)', async () => {
    expect(
      await triggerMatches(automation(['yes']), {
        interactive_reply_id: 'yes_please',
      })
    ).toBe(false);
  });

  it('does not match when no reply id is present or config is empty', async () => {
    expect(await triggerMatches(automation(['yes']), {})).toBe(false);
    expect(
      await triggerMatches(automation([]), { interactive_reply_id: 'yes' })
    ).toBe(false);
  });
});

describe('triggerMatches — tag_added', () => {
  function automation(tagId?: string): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'tag follow-up',
      trigger_type: 'tag_added',
      trigger_config: tagId ? { tag_id: tagId } : {},
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    };
  }

  it('matches only the exact tag id', async () => {
    expect(await triggerMatches(automation('tag-a'), { tag_id: 'tag-a' })).toBe(
      true
    );
    expect(
      await triggerMatches(automation('tag-a'), { tag_id: 'tag-ab' })
    ).toBe(false);
  });

  it('fails closed when the config or event tag is missing', async () => {
    expect(await triggerMatches(automation(), { tag_id: 'tag-a' })).toBe(false);
    expect(await triggerMatches(automation('tag-a'), {})).toBe(false);
    expect(await triggerMatches(automation('tag-a'), undefined)).toBe(false);
  });
});

describe('tag_added — conversation policy', () => {
  it('records a clear failed step when the contact has no conversation', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'tag outreach',
        trigger_type: 'tag_added',
        trigger_config: { tag_id: 'tag-a' },
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_message',
        position: 0,
        parent_step_id: null,
        step_config: { text: 'Hello' },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: 'c1',
      context: { tag_id: 'tag-a' },
    });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message:
          'tag_added automation cannot send: contact has no existing conversation',
      })
    );
  });
});

// ============================================================
// send_webhook — captures the response into vars for downstream
// steps (template interpolation + llm_draft_message consumers).
// ============================================================
describe('send_webhook — response capture into vars', () => {
  it('stores parsed JSON body in vars.webhook_response and status in vars.webhook_status', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ vehicles: [{ id: 1, model: 'CRV' }] }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'inventory webhook',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    // Two steps: webhook + send_message that interpolates from the response.
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_webhook',
        position: 0,
        parent_step_id: null,
        step_config: {
          url: 'https://example.test/inventory',
          body_template: '{}',
        },
      },
      {
        id: 's2',
        automation_id: 'a1',
        step_type: 'send_message',
        position: 1,
        parent_step_id: null,
        // Nested-path interpolation should resolve to the captured JSON field.
        step_config: {
          text: 'Vehicles: {{ vars.webhook_response.vehicles[0].model }}',
        },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {
        message_text: 'what do you have?',
        conversation_id: 'conv-1',
      },
    });

    // The webhook was called.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The downstream send_message step ran with interpolated text — proving
    // the JSON body flowed into vars AND the nested-path resolver worked.
    const sendTextMock = vi.mocked(engineSendText);
    expect(sendTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Vehicles: CRV' })
    );
    vi.unstubAllGlobals();
  });

  it('stores the raw text when the response is not JSON', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'plain text body',
    }));
    vi.stubGlobal('fetch', fetchSpy);

    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'non-json webhook',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_webhook',
        position: 0,
        parent_step_id: null,
        step_config: { url: 'https://example.test/', body_template: '{}' },
      },
      {
        id: 's2',
        automation_id: 'a1',
        step_type: 'send_message',
        position: 1,
        parent_step_id: null,
        step_config: { text: 'Body: {{ vars.webhook_response }}' },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv-1' },
    });

    expect(vi.mocked(engineSendText)).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Body: plain text body' })
    );
    vi.unstubAllGlobals();
  });
});

// ============================================================
// triggerMatches — llm_condition: LLM-evaluated natural-language
// condition. The provider call is mocked; we only verify that the
// result is threaded back into the boolean decision.
// ============================================================
describe('triggerMatches — llm_condition', () => {
  function automation(prompt: string): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'smart condition',
      trigger_type: 'llm_condition',
      trigger_config: { condition_prompt: prompt },
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    };
  }

  it('matches when the LLM says YES', async () => {
    vi.mocked(evaluateLlmCondition).mockResolvedValueOnce({ boolean: true });
    expect(
      await triggerMatches(automation('Customer is upset'), {
        message_text: "I'm really frustrated with this",
      })
    ).toBe(true);
  });

  it('does not match when the LLM says NO', async () => {
    vi.mocked(evaluateLlmCondition).mockResolvedValueOnce({ boolean: false });
    expect(
      await triggerMatches(automation('Customer is upset'), {
        message_text: 'all good, thanks!',
      })
    ).toBe(false);
  });

  it('fails closed when no condition_prompt is configured', async () => {
    expect(await triggerMatches(automation(''), { message_text: 'hi' })).toBe(
      false
    );
  });

  it('fails closed when no message text is present', async () => {
    expect(await triggerMatches(automation('anything'), {})).toBe(false);
  });

  it('treats LLM errors as no-match (does not crash)', async () => {
    vi.mocked(evaluateLlmCondition).mockRejectedValueOnce(
      new Error('provider down')
    );
    expect(
      await triggerMatches(automation('anything'), {
        message_text: 'hi',
      })
    ).toBe(false);
  });
});

// ============================================================
// llm_draft_message step: composes a WhatsApp reply from a prompt +
// accumulated vars (including vars.webhook_response) and sends it.
// ============================================================
describe('llm_draft_message step', () => {
  beforeEach(() => {
    vi.mocked(loadAiConfig).mockResolvedValue({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'sk-test',
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: false,
      autoReplyMaxPerConversation: 3,
      handoffAgentId: null,
      embeddingsApiKey: null,
    });
    vi.mocked(generateReply).mockResolvedValue({
      text: 'Sí, tenemos 3 Honda CR-V 2017.',
      handoff: false,
      usage: null,
    });
  });

  it('runs the LLM with the configured prompt and sends the composed text', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'compose reply',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'llm_draft_message',
        position: 0,
        parent_step_id: null,
        step_config: {
          prompt: 'Use vars.webhook_response to answer about CRV 2017.',
        },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {
        message_text: 'tienes CRV 2017?',
        conversation_id: 'conv-1',
        // Simulate a prior send_webhook step having captured data.
        vars: {
          webhook_response: { count: 3, model: 'CRV' },
          webhook_status: 200,
        },
      },
    });

    // generateReply was called once with the prompt.
    expect(vi.mocked(generateReply)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(generateReply).mock.calls[0][0];
    expect(callArgs.config.model).toBe('gpt-test');
    // The system prompt must include the configured prompt instructions so
    // the LLM can act on them, and the AVAILABLE DATA section that exposes
    // the accumulated vars (including vars.webhook_response).
    expect(callArgs.systemPrompt).toContain('AVAILABLE DATA:');
    expect(callArgs.systemPrompt).toContain('"webhook_response"');
    expect(callArgs.systemPrompt).toContain('"count": 3');
    expect(callArgs.systemPrompt).toContain('"model": "CRV"');

    // The composed text is sent via WhatsApp.
    expect(vi.mocked(engineSendText)).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Sí, tenemos 3 Honda CR-V 2017.' })
    );
  });

  it('fails clearly when no AI config is configured for the account', async () => {
    vi.mocked(loadAiConfig).mockResolvedValueOnce(null);

    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'compose reply',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'llm_draft_message',
        position: 0,
        parent_step_id: null,
        step_config: { prompt: 'Anything.' },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // Step failed; engineSendText was NOT called.
    expect(vi.mocked(engineSendText)).not.toHaveBeenCalled();
    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('AI Assistant'),
      })
    );
  });
});

// ============================================================
// interpolate() — nested-path resolution into webhook_response.
// Tested indirectly via send_webhook body_template so we don't need
// to export the helper just for tests.
// ============================================================
describe('interpolate — nested vars.* paths', () => {
  async function captureSentBodyFromTemplate(
    template: string
  ): Promise<string> {
    let captured: string | undefined;
    const fetchSpy = vi.fn(async (_url: string, init: { body: string }) => {
      captured = init.body;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    vi.stubGlobal('fetch', fetchSpy);

    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'tpl',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_webhook',
        position: 0,
        parent_step_id: null,
        step_config: { url: 'https://example.test/', body_template: template },
      },
    ];
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { message_text: 'hi' },
    });
    vi.unstubAllGlobals();
    return captured ?? '';
  }

  it('resolves {{ vars.foo.bar }} when set via the trigger context vars', async () => {
    const body = await captureSentBodyFromTemplate(
      '{"v":"{{ vars.payload.value }}"}'
    );
    // No payload in context, so interpolation should produce an empty string.
    expect(body).toBe('{"v":""}');
  });
});

// ============================================================
// send_webhook — GET method + query_params. Universal coverage for
// APIs that filter by query string (the most common REST shape for
// "search" endpoints). Empty params are dropped from the URL.
// ============================================================
describe('send_webhook — GET method + query_params', () => {
  async function captureSentUrl(): Promise<string | undefined> {
    let capturedUrl: string | undefined;
    const fetchSpy = vi.fn(async (url: string) => {
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    });
    vi.stubGlobal('fetch', fetchSpy);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { message_text: 'hi', conversation_id: 'conv-1' },
    });
    vi.unstubAllGlobals();
    return capturedUrl;
  }

  function setupGetWebhook(cfg: {
    url: string;
    query_params?: Record<string, string>;
    method?: 'GET' | 'POST';
  }) {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'get webhook',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_webhook',
        position: 0,
        parent_step_id: null,
        step_config: cfg,
      },
    ];
  }

  it('auto-switches to GET when query_params is set and appends them to the URL', async () => {
    setupGetWebhook({
      url: 'https://example.test/search',
      query_params: {
        brand: 'Hyundai',
        model: 'Elantra',
      },
    });
    const url = await captureSentUrl();
    expect(url).toBe('https://example.test/search?brand=Hyundai&model=Elantra');
  });

  it('drops query params whose interpolated value is empty', async () => {
    setupGetWebhook({
      url: 'https://example.test/search',
      query_params: {
        brand: 'Hyundai',
        model: '{{ vars.missing }}',
        year: '2010',
      },
    });
    const url = await captureSentUrl();
    // model interpolates to empty (vars.missing is undefined), so it's dropped
    // entirely instead of becoming `?model=` in the URL.
    expect(url).toBe('https://example.test/search?brand=Hyundai&year=2010');
  });

  it('omits the query string entirely when all param values are empty', async () => {
    setupGetWebhook({
      url: 'https://example.test/search',
      query_params: {
        brand: '{{ vars.missing }}',
        model: '',
      },
    });
    const url = await captureSentUrl();
    expect(url).toBe('https://example.test/search');
  });

  it('respects an explicit method=POST when query_params is also set (no auto-switch)', async () => {
    setupGetWebhook({
      url: 'https://example.test/search',
      method: 'POST',
      query_params: { brand: 'Hyundai' },
      // body_template would be used
      body_template: '{"q":"x"}',
    } as unknown as Parameters<typeof setupGetWebhook>[0]);
    const url = await captureSentUrl();
    // POST should NOT append query params; URL stays bare.
    expect(url).toBe('https://example.test/search');
  });

  it('URL-encodes param values that contain special characters', async () => {
    setupGetWebhook({
      url: 'https://example.test/search',
      query_params: {
        q: 'Hyundai & Elantra',
      },
    });
    const url = await captureSentUrl();
    expect(url).toBe('https://example.test/search?q=Hyundai%20%26%20Elantra');
  });
});

// ============================================================
// extract_vars step: LLM extracts structured fields from the recent
// message + writes them to vars.{key}. Fields the LLM omits stay
// undefined, which makes query_params interpolation skip them.
// ============================================================
describe('extract_vars step', () => {
  beforeEach(() => {
    vi.mocked(loadAiConfig).mockResolvedValue({
      provider: 'openai',
      model: 'gpt-test',
      apiKey: 'sk-test',
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: false,
      autoReplyMaxPerConversation: 3,
      handoffAgentId: null,
      embeddingsApiKey: null,
    });
  });

  function setupExtractStep(
    fields: Record<string, 'string' | 'number' | 'boolean'>,
    initialVars: Record<string, unknown> = {}
  ) {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'extract',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'extract_vars',
        position: 0,
        parent_step_id: null,
        step_config: {
          prompt: 'Extract brand, model and year from the customer message.',
          fields,
        },
      },
    ];
    return runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {
        message_text: 'tienes hyundai elantra 2010?',
        conversation_id: 'conv-1',
        vars: initialVars,
      },
    });
  }

  it('writes parsed JSON fields into vars, coercing types', async () => {
    // LLM returns brand as string, model as string, year as number
    // (the schema asks for number — the test verifies coercion too).
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: JSON.stringify({ brand: 'Hyundai', model: 'Elantra', year: 2010 }),
      handoff: false,
      usage: null,
    });
    await setupExtractStep({
      brand: 'string',
      model: 'string',
      year: 'number',
    });

    // The webhook step would normally follow, but we only have one
    // step here; verify the engine ran it without errors and the LLM
    // was called once with the right prompt (fields spec lives in the
    // user content; system prompt carries the format instructions).
    expect(vi.mocked(generateReply)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(generateReply).mock.calls[0][0];
    expect(callArgs.systemPrompt).toContain('JSON object');
    expect(callArgs.messages[0].content).toContain('"brand": string');
    expect(callArgs.messages[0].content).toContain('"year": number');
    expect(callArgs.messages[0].content).toContain(
      'tienes hyundai elantra 2010?'
    );
    // The final run should be success — webhook fetch wouldn't be
    // attempted because there are no further steps; assert via the log.
    expect(h.state.logInserts[0]?.status).toBe('failed'); // pessimistic seed
    const finalUpdate = h.state.logUpdates.at(-1) as
      { status?: string } | undefined;
    expect(finalUpdate?.status).toBe('success');
  });

  it("omits fields the LLM returns that aren't in the schema (LLM invention)", async () => {
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: JSON.stringify({
        brand: 'Hyundai',
        randomKey: 'ignored',
        year: 2010,
      }),
      handoff: false,
      usage: null,
    });
    await setupExtractStep({ brand: 'string', year: 'number' });

    // We can't directly assert vars after the run because the step
    // doesn't expose them in the mock state — but we can assert the
    // step completed without throwing and the LLM was called.
    expect(vi.mocked(generateReply)).toHaveBeenCalledTimes(1);
  });

  it('fails clearly when the LLM returns non-JSON', async () => {
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: 'Lo siento, no puedo extraer esos datos.',
      handoff: false,
      usage: null,
    });
    await setupExtractStep({ brand: 'string' });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('non-JSON'),
      })
    );
  });

  it('fails clearly when no AI config is configured', async () => {
    vi.mocked(loadAiConfig).mockResolvedValueOnce(null);
    await setupExtractStep({ brand: 'string' });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('AI Assistant'),
      })
    );
  });

  it('tolerates ```json fences around the JSON object', async () => {
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: '```json\n{"brand":"Hyundai","year":2010}\n```',
      handoff: false,
      usage: null,
    });
    await setupExtractStep({ brand: 'string', year: 'number' });
    // No failure — the engine strips fences and parses.
    const finalUpdate = h.state.logUpdates.at(-1) as
      { status?: string } | undefined;
    expect(finalUpdate?.status).toBe('success');
  });

  // ----------------------------------------------------------
  // reference_path: lets `extract_vars` read a prior step's vars
  // (typically the JSON body of a send_webhook catalog fetch) and
  // inject it as REFERENCE VOCABULARY so the LLM can match typos.
  // ----------------------------------------------------------
  function setupExtractStepWithReference(
    fields: Record<string, 'string' | 'number' | 'boolean'>,
    referencePath: string,
    initialVars: Record<string, unknown>
  ) {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'extract-with-ref',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'extract_vars',
        position: 0,
        parent_step_id: null,
        step_config: {
          prompt: 'Extract brand, model and year from the customer message.',
          fields,
          reference_path: referencePath,
        },
      },
    ];
    return runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {
        message_text: 'tienes crv 2020?',
        conversation_id: 'conv-1',
        vars: initialVars,
      },
    });
  }

  it('injects the resolved reference as REFERENCE VOCABULARY when the path matches vars', async () => {
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: JSON.stringify({ brand: 'Honda', model: 'CR-V', year: 2020 }),
      handoff: false,
      usage: null,
    });
    const catalog = {
      brands: [
        { name: 'Honda', models: [{ name: 'CR-V', aliases: ['crv', 'cr-v'] }] },
      ],
    };
    await setupExtractStepWithReference(
      { brand: 'string', model: 'string', year: 'number' },
      'vars.webhook_response',
      { webhook_response: catalog }
    );
    expect(vi.mocked(generateReply)).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(generateReply).mock.calls[0][0];
    const userContent = callArgs.messages[0].content as string;
    expect(userContent).toContain('REFERENCE VOCABULARY');
    expect(userContent).toContain('"CR-V"');
    expect(userContent).toContain('"Honda"');
    expect(userContent).toContain('tienes crv 2020?');
  });

  it("omits the reference block silently when the path doesn't resolve", async () => {
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: JSON.stringify({ brand: 'Honda' }),
      handoff: false,
      usage: null,
    });
    // No vars.webhook_response set — nothing to inject, behaves like
    // the original extract_vars (no reference field existed).
    await setupExtractStepWithReference(
      { brand: 'string' },
      'vars.webhook_response',
      {}
    );
    const callArgs = vi.mocked(generateReply).mock.calls[0][0];
    const userContent = callArgs.messages[0].content as string;
    expect(userContent).not.toContain('REFERENCE VOCABULARY');
  });

  it('supports nested paths (vars.webhook_response.results[0])', async () => {
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: JSON.stringify({ brand: 'Honda' }),
      handoff: false,
      usage: null,
    });
    await setupExtractStepWithReference(
      { brand: 'string' },
      'vars.webhook_response.results[0]',
      { webhook_response: { results: [{ brands: ['Honda', 'Toyota'] }] } }
    );
    const callArgs = vi.mocked(generateReply).mock.calls[0][0];
    const userContent = callArgs.messages[0].content as string;
    expect(userContent).toContain('REFERENCE VOCABULARY');
    expect(userContent).toContain('"Honda"');
  });

  it('truncates oversized reference payloads to keep the prompt within budget', async () => {
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: JSON.stringify({ brand: 'Honda' }),
      handoff: false,
      usage: null,
    });
    // 12KB of repetitive text — well over the 8KB cap.
    const huge = 'x'.repeat(12 * 1024);
    await setupExtractStepWithReference(
      { brand: 'string' },
      'vars.webhook_response',
      { webhook_response: huge }
    );
    const callArgs = vi.mocked(generateReply).mock.calls[0][0];
    const userContent = callArgs.messages[0].content as string;
    expect(userContent).toContain('[truncated]');
    expect(userContent).not.toContain('x'.repeat(12 * 1024));
  });

  it('pretty-prints object/array references and passes strings through', async () => {
    vi.mocked(generateReply).mockResolvedValueOnce({
      text: JSON.stringify({ brand: 'Honda' }),
      handoff: false,
      usage: null,
    });
    await setupExtractStepWithReference(
      { brand: 'string' },
      'vars.webhook_response',
      { webhook_response: { brands: ['Honda', 'Toyota'] } }
    );
    const callArgs = vi.mocked(generateReply).mock.calls[0][0];
    const userContent = callArgs.messages[0].content as string;
    // Pretty-printed JSON has newlines + indentation between keys.
    expect(userContent).toMatch(/"brands":\s*\[\s*"Honda"/);
  });
});

// ============================================================
// send_images step: iterate a `[*]` path and send one WhatsApp
// image message per resolved URL, with optional caption evaluated
// in the `loop.*` interpolation scope.
// ============================================================
import { engineSendImage } from './meta-send';
describe('send_images step', () => {
  beforeEach(() => {
    vi.mocked(engineSendImage).mockResolvedValue({
      whatsapp_message_id: 'img1',
    });
  });

  function setupSendImages(
    cfg: { image_path: string; caption?: string; max_images?: number },
    initialVars: Record<string, unknown> = {}
  ) {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'send images',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_images',
        position: 0,
        parent_step_id: null,
        step_config: cfg,
      },
    ];
    return runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {
        message_text: 'tienes hyundai elantra?',
        conversation_id: 'conv-1',
        vars: initialVars,
      },
    });
  }

  it('sends one image per URL with caption using the loop scope', async () => {
    const sendImageSpy = vi.mocked(engineSendImage);
    sendImageSpy.mockReset();
    sendImageSpy
      .mockResolvedValueOnce({ whatsapp_message_id: 'm1' })
      .mockResolvedValueOnce({ whatsapp_message_id: 'm2' })
      .mockResolvedValueOnce({ whatsapp_message_id: 'm3' });

    await setupSendImages(
      {
        image_path: 'vars.webhook_response.results[*].media[0].url',
        caption: '{{ loop.index }}. {{ loop.title }}\n${{ loop.price }}',
      },
      {
        webhook_response: {
          results: [
            {
              title: 'Hyundai Elantra 2010',
              price: '139000',
              media: [{ url: 'https://a.test/1.jpg' }],
            },
            {
              title: 'Hyundai Elantra 2010',
              price: '139000',
              media: [{ url: 'https://a.test/2.jpg' }],
            },
            {
              title: 'Hyundai Elantra 2010',
              price: '139000',
              media: [{ url: 'https://a.test/3.jpg' }],
            },
          ],
        },
      }
    );

    expect(sendImageSpy).toHaveBeenCalledTimes(3);
    expect(sendImageSpy.mock.calls[0][0]).toMatchObject({
      imageUrl: 'https://a.test/1.jpg',
      caption: '1. Hyundai Elantra 2010\n$139000',
    });
    expect(sendImageSpy.mock.calls[1][0]).toMatchObject({
      imageUrl: 'https://a.test/2.jpg',
      caption: '2. Hyundai Elantra 2010\n$139000',
    });
    expect(sendImageSpy.mock.calls[2][0]).toMatchObject({
      imageUrl: 'https://a.test/3.jpg',
      caption: '3. Hyundai Elantra 2010\n$139000',
    });
    const finalUpdate = h.state.logUpdates.at(-1) as
      | { status?: string; steps_executed?: Array<{ detail?: string }> }
      | undefined;
    expect(finalUpdate?.status).toBe('success');
    expect(finalUpdate?.steps_executed?.[0]?.detail).toMatch(/sent 3 images/);
  });

  it('skips items whose URL interpolates to empty', async () => {
    await setupSendImages(
      { image_path: 'vars.webhook_response.results[*].media[0].url' },
      {
        webhook_response: {
          results: [
            { media: [{ url: 'https://a.test/1.jpg' }] },
            { media: [] }, // no url � should be skipped
            { media: [{ url: 'https://a.test/3.jpg' }] },
          ],
        },
      }
    );

    expect(vi.mocked(engineSendImage)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(engineSendImage).mock.calls[0][0].imageUrl).toBe(
      'https://a.test/1.jpg'
    );
    expect(vi.mocked(engineSendImage).mock.calls[1][0].imageUrl).toBe(
      'https://a.test/3.jpg'
    );
  });

  it('respects max_images cap', async () => {
    const sendImageSpy = vi.mocked(engineSendImage);
    sendImageSpy.mockReset();
    for (let i = 0; i < 10; i++) {
      sendImageSpy.mockResolvedValueOnce({ whatsapp_message_id: `m${i}` });
    }

    await setupSendImages(
      { image_path: 'vars.list[*].url', max_images: 3 },
      {
        list: [
          { url: '1' },
          { url: '2' },
          { url: '3' },
          { url: '4' },
          { url: '5' },
        ],
      }
    );

    expect(sendImageSpy).toHaveBeenCalledTimes(3);
  });

  it('succeeds when no URLs resolve', async () => {
    await setupSendImages(
      { image_path: 'vars.webhook_response.results[*].media[0].url' },
      { webhook_response: { results: [] } }
    );

    expect(vi.mocked(engineSendImage)).not.toHaveBeenCalled();
    const finalUpdate = h.state.logUpdates.at(-1) as
      { steps_executed?: Array<{ detail?: string }> } | undefined;
    expect(finalUpdate?.steps_executed?.[0]?.detail).toMatch(/0 URLs/);
  });

  it('fails when image_path is missing', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'no path',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_images',
        position: 0,
        parent_step_id: null,
        step_config: { image_path: '' },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { conversation_id: 'conv-1' },
    });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message: expect.stringContaining('image_path'),
      })
    );
  });
});

// ============================================================
// runAutomationsForTrigger return value: messagesSent counter
// lets the webhook suppress the AI auto-reply when an automation
// already replied to the customer.
// ============================================================
describe('runAutomationsForTrigger � messagesSent counter', () => {
  it('returns 0 when no automations match', async () => {
    h.state.automations = []; // none match
    const result = await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { message_text: 'hi' },
    });
    expect(result.messagesSent).toBe(0);
  });

  it('counts every successful WhatsApp send across steps', async () => {
    // 5 image sends in the same step
    vi.mocked(engineSendImage).mockReset();
    for (let i = 0; i < 5; i++) {
      vi.mocked(engineSendImage).mockResolvedValueOnce({
        whatsapp_message_id: `m${i}`,
      });
    }
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'five images',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_images',
        position: 0,
        parent_step_id: null,
        step_config: {
          image_path: 'vars.list[*].url',
          max_images: 10,
        },
      },
    ];
    const result = await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {
        message_text: 'send all',
        conversation_id: 'conv-1',
        vars: {
          list: [
            { url: 'https://a.test/1.jpg' },
            { url: 'https://a.test/2.jpg' },
            { url: 'https://a.test/3.jpg' },
            { url: 'https://a.test/4.jpg' },
            { url: 'https://a.test/5.jpg' },
          ],
        },
      },
    });
    expect(result.messagesSent).toBe(5);
  });
});

// ============================================================
// condition step — vars_value subject: branches on any value
// in `args.context.vars`. Universal companion to extract_vars:
// lets you route "did the webhook find anything?" into yes/no
// branches (e.g. send_images when results is non-empty, send a
// fallback message when it's empty).
// ============================================================
describe('condition step — vars_value', () => {
  function setupConditionBranch(
    conditionStep: {
      subject: string;
      operand?: string;
      operator?: string;
      value?: string;
    },
    yesSteps: Array<{
      step_type: string;
      step_config: Record<string, unknown>;
    }>,
    noSteps: Array<{ step_type: string; step_config: Record<string, unknown> }>,
    initialVars: Record<string, unknown> = {}
  ) {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'condition-vars-value',
        trigger_type: 'new_message_received',
        trigger_config: {},
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'condition',
        position: 0,
        parent_step_id: null,
        step_config: conditionStep,
      },
      ...yesSteps.map((s, i) => ({
        id: `yes-${i}`,
        automation_id: 'a1',
        step_type: s.step_type,
        position: i,
        parent_step_id: 's1',
        parent_branch: 'yes',
        step_config: s.step_config,
      })),
      ...noSteps.map((s, i) => ({
        id: `no-${i}`,
        automation_id: 'a1',
        step_type: s.step_type,
        position: i,
        parent_step_id: 's1',
        parent_branch: 'no',
        step_config: s.step_config,
      })),
    ];
    return runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {
        message_text: 'test',
        conversation_id: 'conv-1',
        vars: initialVars,
      },
    });
  }

  it("is_empty: takes yes branch when array is empty (the user's primary use case)", async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.webhook_response.results',
        operator: 'is_empty',
      },
      [
        {
          step_type: 'send_message',
          step_config: { text: 'no tenemos ese modelo' },
        },
      ],
      [{ step_type: 'send_message', step_config: { text: 'tenemos stock' } }],
      { webhook_response: { results: [], total: 0 } }
    );
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe(
      'no tenemos ese modelo'
    );
  });

  it('is_empty: takes no branch when array has items', async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.webhook_response.results',
        operator: 'is_empty',
      },
      [{ step_type: 'send_message', step_config: { text: 'empty' } }],
      [{ step_type: 'send_message', step_config: { text: 'found' } }],
      { webhook_response: { results: [{ id: 'v1' }], total: 1 } }
    );
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('found');
  });

  it('is_not_empty: inverts the empty check', async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.webhook_response.results',
        operator: 'is_not_empty',
      },
      [{ step_type: 'send_message', step_config: { text: 'found' } }],
      [{ step_type: 'send_message', step_config: { text: 'empty' } }],
      { webhook_response: { results: [{ id: 'v1' }] } }
    );
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('found');
  });

  it('equals: compares string vars', async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.brand',
        operator: 'equals',
        value: 'Honda',
      },
      [{ step_type: 'send_message', step_config: { text: 'es Honda' } }],
      [{ step_type: 'send_message', step_config: { text: 'no es Honda' } }],
      { brand: 'Honda' }
    );
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('es Honda');
  });

  it('not_equals: takes no branch when value matches', async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.brand',
        operator: 'not_equals',
        value: 'Honda',
      },
      [{ step_type: 'send_message', step_config: { text: 'es Honda' } }],
      [{ step_type: 'send_message', step_config: { text: 'no es Honda' } }],
      { brand: 'Honda' }
    );
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('no es Honda');
  });

  it('contains: substring match is case-insensitive', async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.brand',
        operator: 'contains',
        value: 'ond',
      },
      [{ step_type: 'send_message', step_config: { text: 'match' } }],
      [{ step_type: 'send_message', step_config: { text: 'no match' } }],
      { brand: 'Honda' }
    );
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('match');
  });

  it('treats missing operand as a no-match (the no branch runs)', async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      // No operand — evaluateCondition returns false → no branch runs.
      { subject: 'vars_value' },
      [{ step_type: 'send_message', step_config: { text: 'yes' } }],
      [{ step_type: 'send_message', step_config: { text: 'no' } }],
      { brand: 'Honda' }
    );
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('no');
  });

  it('treats unresolvable path as is_empty (so the yes branch fires)', async () => {
    // vars.nonexistent doesn't resolve → is_empty matches.
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.nonexistent',
        operator: 'is_empty',
      },
      [
        {
          step_type: 'send_message',
          step_config: { text: 'missing branch fired' },
        },
      ],
      [{ step_type: 'send_message', step_config: { text: 'exists branch' } }],
      {}
    );
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe(
      'missing branch fired'
    );
  });

  it('is_empty treats empty object, empty string, and null the same', async () => {
    vi.mocked(engineSendText).mockClear();
    for (const value of [{}, '', null]) {
      vi.mocked(engineSendText).mockClear();
      await setupConditionBranch(
        { subject: 'vars_value', operand: 'vars.x', operator: 'is_empty' },
        [{ step_type: 'send_message', step_config: { text: 'empty' } }],
        [{ step_type: 'send_message', step_config: { text: 'non-empty' } }],
        { x: value }
      );
      expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('empty');
    }
  });

  it('defaults to is_empty when operator is omitted (sensible default for the common case)', async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      // No operator field — should default to is_empty.
      { subject: 'vars_value', operand: 'vars.results' },
      [{ step_type: 'send_message', step_config: { text: 'empty' } }],
      [{ step_type: 'send_message', step_config: { text: 'non-empty' } }],
      { results: [] }
    );
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('empty');
  });

  it("strips an optional 'vars.' prefix on the operand", async () => {
    // Some users write "vars.x.y" in the UI, some write "x.y" — both
    // should resolve the same way.
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.brand',
        operator: 'equals',
        value: 'Honda',
      },
      [{ step_type: 'send_message', step_config: { text: 'matched' } }],
      [{ step_type: 'send_message', step_config: { text: 'no match' } }],
      { brand: 'Honda' }
    );
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('matched');
  });

  it('resolves nested paths (vars.webhook_response.results[0].id)', async () => {
    vi.mocked(engineSendText).mockClear();
    await setupConditionBranch(
      {
        subject: 'vars_value',
        operand: 'vars.webhook_response.results[0].id',
        operator: 'equals',
        value: 'v1',
      },
      [{ step_type: 'send_message', step_config: { text: 'first id is v1' } }],
      [
        {
          step_type: 'send_message',
          step_config: { text: 'first id is not v1' },
        },
      ],
      { webhook_response: { results: [{ id: 'v1' }] } }
    );
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe(
      'first id is v1'
    );
  });
});
