import { describe, expect, it } from 'vitest';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from './validate';

describe('validateStepsForActivation', () => {
  it('rejects empty or missing step lists', () => {
    expect(validateStepsForActivation([])).toEqual([
      { path: 'steps', message: 'active automations need at least one step' },
    ]);
    expect(validateStepsForActivation(undefined as unknown as never[])).toEqual(
      [{ path: 'steps', message: 'active automations need at least one step' }]
    );
  });

  it('passes a fully-populated step set', () => {
    const issues = validateStepsForActivation([
      { step_type: 'send_message', step_config: { text: 'hi' } },
      {
        step_type: 'wait',
        step_config: { amount: 5, unit: 'minutes' },
      },
      { step_type: 'add_tag', step_config: { tag_id: 'tag-uuid' } },
      { step_type: 'close_conversation', step_config: {} },
    ]);
    expect(issues).toEqual([]);
  });

  it('flags every required field that is missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'send_message', step_config: { text: '  ' } },
      { step_type: 'send_template', step_config: {} },
      { step_type: 'add_tag', step_config: { tag_id: '' } },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].text',
      'steps[1].template_name',
      'steps[2].tag_id',
    ]);
  });

  it('checks wait amount and unit boundaries', () => {
    const issues = validateStepsForActivation([
      { step_type: 'wait', step_config: { amount: 0, unit: 'minutes' } },
      { step_type: 'wait', step_config: { amount: 5, unit: 'seconds' } },
      { step_type: 'wait', step_config: { amount: -1, unit: 'hours' } },
      {
        step_type: 'wait',
        step_config: { amount: Number.POSITIVE_INFINITY, unit: 'days' },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].amount',
      'steps[1].unit',
      'steps[2].amount',
      'steps[3].amount',
    ]);
  });

  it('validates webhook URLs', () => {
    const good = validateStepsForActivation([
      {
        step_type: 'send_webhook',
        step_config: { url: 'https://hooks.example.com/in' },
      },
    ]);
    expect(good).toEqual([]);

    const noUrl = validateStepsForActivation([
      { step_type: 'send_webhook', step_config: {} },
    ]);
    expect(noUrl.map((i) => i.message)).toContain('webhook URL is required');

    const wrongProtocol = validateStepsForActivation([
      {
        step_type: 'send_webhook',
        step_config: { url: 'ftp://files.example.com' },
      },
    ]);
    expect(wrongProtocol.map((i) => i.message)).toContain(
      'webhook URL must use http or https'
    );

    const garbage = validateStepsForActivation([
      { step_type: 'send_webhook', step_config: { url: 'not a url' } },
    ]);
    expect(garbage.map((i) => i.message)).toContain(
      'webhook URL is not a valid URL'
    );
  });

  it("validates assign_conversation only when mode is 'specific'", () => {
    const roundRobinNoAgent = validateStepsForActivation([
      {
        step_type: 'assign_conversation',
        step_config: { mode: 'round_robin' },
      },
    ]);
    expect(roundRobinNoAgent).toEqual([]);

    const specificMissingAgent = validateStepsForActivation([
      { step_type: 'assign_conversation', step_config: { mode: 'specific' } },
    ]);
    expect(specificMissingAgent.map((i) => i.path)).toEqual([
      'steps[0].agent_id',
    ]);
  });

  it('flags create_deal when required fields are missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'create_deal', step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'steps[0].pipeline_id',
      'steps[0].stage_id',
      'steps[0].title',
    ]);
  });

  it('validates send_buttons / send_list interactive payloads', () => {
    const good = validateStepsForActivation([
      {
        step_type: 'send_buttons',
        step_config: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [{ id: 'yes', title: 'Yes' }],
        },
      },
    ]);
    expect(good).toEqual([]);

    const tooMany = validateStepsForActivation([
      {
        step_type: 'send_buttons',
        step_config: {
          kind: 'buttons',
          body: 'Pick one',
          buttons: [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
            { id: 'c', title: 'C' },
            { id: 'd', title: 'D' },
          ],
        },
      },
    ]);
    expect(tooMany.map((i) => i.path)).toEqual(['steps[0].interactive']);
  });

  it('flags update_contact_field when field or value is missing', () => {
    const issues = validateStepsForActivation([
      { step_type: 'update_contact_field', step_config: { field: 'name' } },
      {
        step_type: 'update_contact_field',
        step_config: { field: '', value: 'x' },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].value',
      'steps[1].field',
    ]);
  });

  it('recursively walks condition branches with stable dot-paths', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: { subject: 'tag', operand: 'vip' },
        branches: {
          yes: [{ step_type: 'add_tag', step_config: { tag_id: '' } }],
          no: [
            {
              step_type: 'send_message',
              step_config: { text: '' },
            },
          ],
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual([
      'steps[0].yes.steps[0].tag_id',
      'steps[0].no.steps[0].text',
    ]);
  });

  it('reports an issue for unknown step types', () => {
    const issues = validateStepsForActivation([
      { step_type: 'do_a_barrel_roll', step_config: {} },
    ]);
    expect(issues).toEqual([
      { path: 'steps[0]', message: 'unknown step type: do_a_barrel_roll' },
    ]);
  });

  it('flags condition subject/operand independently', () => {
    const issues = validateStepsForActivation([
      { step_type: 'condition', step_config: {} },
    ]);
    expect(issues.map((i) => i.path).sort()).toEqual([
      'steps[0].operand',
      'steps[0].subject',
    ]);
  });

  it('accepts extract_vars with a valid reference_path', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'extract_vars',
        step_config: {
          prompt: 'Extract brand and model.',
          fields: { brand: 'string', model: 'string' },
          reference_path: 'vars.webhook_response',
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('accepts extract_vars without a reference_path (the field is optional)', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'extract_vars',
        step_config: {
          prompt: 'Extract brand and model.',
          fields: { brand: 'string' },
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('flags extract_vars reference_path that exceeds 200 chars', () => {
    const longPath = 'vars.' + 'x'.repeat(250);
    const issues = validateStepsForActivation([
      {
        step_type: 'extract_vars',
        step_config: {
          prompt: 'Extract brand.',
          fields: { brand: 'string' },
          reference_path: longPath,
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toEqual(['steps[0].reference_path']);
  });

  it('flags extract_vars reference_path with newlines or semicolons', () => {
    const withNewline = validateStepsForActivation([
      {
        step_type: 'extract_vars',
        step_config: {
          prompt: 'Extract brand.',
          fields: { brand: 'string' },
          reference_path: 'vars.webhook_response\nignore previous',
        },
      },
    ]);
    expect(withNewline.map((i) => i.message)).toContain(
      'reference_path cannot contain newlines or semicolons'
    );

    const withSemicolon = validateStepsForActivation([
      {
        step_type: 'extract_vars',
        step_config: {
          prompt: 'Extract brand.',
          fields: { brand: 'string' },
          reference_path: 'vars.webhook_response;drop',
        },
      },
    ]);
    expect(withSemicolon.map((i) => i.message)).toContain(
      'reference_path cannot contain newlines or semicolons'
    );
  });

  it('treats empty string reference_path the same as omitted', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'extract_vars',
        step_config: {
          prompt: 'Extract brand.',
          fields: { brand: 'string' },
          reference_path: '',
        },
      },
    ]);
    expect(issues).toEqual([]);
  });
});

describe('validateStepsForActivation — condition (vars_value subject)', () => {
  it('accepts vars_value with is_empty and no operand-required value', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: {
          subject: 'vars_value',
          operand: 'vars.webhook_response.results',
          operator: 'is_empty',
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('accepts vars_value without operator (defaults to is_empty)', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: {
          subject: 'vars_value',
          operand: 'vars.results',
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('flags vars_value with no operand', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: {
          subject: 'vars_value',
          operator: 'is_empty',
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toContain('steps[0].operand');
  });

  it('flags vars_value with unknown operator', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: {
          subject: 'vars_value',
          operand: 'vars.x',
          operator: 'starts_with',
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toContain('steps[0].operator');
  });

  it('requires value for equals / not_equals / contains', () => {
    for (const op of ['equals', 'not_equals', 'contains']) {
      const issues = validateStepsForActivation([
        {
          step_type: 'condition',
          step_config: {
            subject: 'vars_value',
            operand: 'vars.x',
            operator: op,
            value: '',
          },
        },
      ]);
      expect(issues.map((i) => i.path)).toContain(`steps[0].value`);
    }
  });

  it('accepts vars_value with equals + value', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: {
          subject: 'vars_value',
          operand: 'vars.brand',
          operator: 'equals',
          value: 'Honda',
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it('does not require value for is_empty / is_not_empty', () => {
    for (const op of ['is_empty', 'is_not_empty']) {
      const issues = validateStepsForActivation([
        {
          step_type: 'condition',
          step_config: {
            subject: 'vars_value',
            operand: 'vars.x',
            operator: op,
          },
        },
      ]);
      expect(issues).toEqual([]);
    }
  });

  it('flags operand longer than 200 chars', () => {
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: {
          subject: 'vars_value',
          operand: 'vars.' + 'x'.repeat(250),
          operator: 'is_empty',
        },
      },
    ]);
    expect(issues.map((i) => i.path)).toContain('steps[0].operand');
  });

  it('does not apply the operator/value rules to other subjects', () => {
    // A message_content condition without value would normally fail its
    // own way (the engine treats empty value as substring of empty),
    // but it must NOT trigger the vars_value-specific error paths.
    const issues = validateStepsForActivation([
      {
        step_type: 'condition',
        step_config: {
          subject: 'message_content',
          operand: 'foo',
          value: 'bar',
        },
      },
    ]);
    expect(issues).toEqual([]);
  });
});

describe('validateTriggerForActivation', () => {
  it('accepts a valid keyword_match config', () => {
    expect(
      validateTriggerForActivation('keyword_match', {
        keywords: ['hello', 'hi'],
        match_type: 'exact',
      })
    ).toEqual([]);
  });

  it('rejects keyword_match with empty keyword array', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: [],
      match_type: 'exact',
    });
    expect(issues.map((i) => i.path)).toContain('trigger.keywords');
  });

  it('rejects keyword_match with whitespace-only entries', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: ['hi', '   '],
      match_type: 'contains',
    });
    expect(issues.map((i) => i.message)).toContain(
      'keywords cannot be empty strings'
    );
  });

  it('rejects keyword_match with an unknown match_type', () => {
    const issues = validateTriggerForActivation('keyword_match', {
      keywords: ['hi'],
      match_type: 'fuzzy',
    });
    expect(issues.map((i) => i.path)).toContain('trigger.match_type');
  });

  it('accepts keyword_match with a missing match_type (defaults to contains)', () => {
    expect(
      validateTriggerForActivation('keyword_match', { keywords: ['hi'] })
    ).toEqual([]);
  });

  it('requires schedule on time_based triggers', () => {
    expect(validateTriggerForActivation('time_based', {})).toEqual([
      { path: 'trigger.schedule', message: 'schedule is required' },
    ]);
    expect(
      validateTriggerForActivation('time_based', { schedule: '0 9 * * *' })
    ).toEqual([]);
  });

  it('requires tag_id on tag_added triggers', () => {
    expect(validateTriggerForActivation('tag_added', {})).toEqual([
      { path: 'trigger.tag_id', message: 'tag is required' },
    ]);
    expect(
      validateTriggerForActivation('tag_added', { tag_id: 'tag-uuid' })
    ).toEqual([]);
  });

  it('requires reply_ids on interactive_reply triggers', () => {
    expect(validateTriggerForActivation('interactive_reply', {})).toEqual([
      {
        path: 'trigger.reply_ids',
        message: 'at least one reply id is required',
      },
    ]);
    expect(
      validateTriggerForActivation('interactive_reply', {
        reply_ids: ['yes', 'no'],
      })
    ).toEqual([]);
    const empties = validateTriggerForActivation('interactive_reply', {
      reply_ids: ['yes', '  '],
    });
    expect(empties.map((i) => i.message)).toContain(
      'reply ids cannot be empty strings'
    );
  });

  it('does not flag unknown trigger types (handled elsewhere)', () => {
    expect(validateTriggerForActivation('some_future_trigger', {})).toEqual([]);
  });
});
