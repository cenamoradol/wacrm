import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'
import { AiError } from '@/lib/ai/types'

// ============================================================
// LLM-evaluated trigger condition.
//
// The `llm_condition` automation trigger is universal: the user writes
// any natural-language condition ("El cliente pregunta por inventario",
// "El cliente está molesto", "Pide hablar con humano") and we ask the
// LLM whether the recent customer message satisfies it.
//
// The LLM is asked to answer with exactly one line starting with YES
// or NO, followed by an optional one-line explanation. We parse the
// first line and ignore the rest — the explanation is surfaced only
// in the automation log for debugging.
//
// Reuses `loadAiConfig` + `generateReply`, so this works with the same
// provider the account already configured (OpenAI / Anthropic /
// MiniMax). The LLM call is wrapped in `supabaseAdmin()` because the
// trigger fires from the inbound webhook, which has no auth.uid().
// ============================================================

export interface EvaluateLlmConditionArgs {
  accountId: string
  /** Natural-language condition the LLM evaluates. */
  prompt: string
  /** The customer's most recent text message. */
  recentMessage: string
  /** Optional: short recent conversation to give the LLM context. */
  conversationSnippet?: string
}

export interface LlmConditionResult {
  boolean: boolean
  /** Optional one-line reasoning the LLM returned after YES/NO. */
  reasoning?: string
  /** Provider-reported usage, propagated to the calling context. */
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null
}

/**
 * Ask the account's LLM whether the recent message satisfies the
 * given natural-language condition. Returns the boolean verdict and
 * the LLM's optional reasoning (for logs).
 *
 * Throws `AiError` if the account has no AI config, or any provider
 * failure (the caller should catch and log — a failed condition check
 * is treated as `false` by the engine so the automation just doesn't
 * fire, rather than crashing the whole run).
 */
export async function evaluateLlmCondition(
  args: EvaluateLlmConditionArgs,
): Promise<LlmConditionResult> {
  const db = supabaseAdmin()
  const config = await loadAiConfig(db, args.accountId)
  if (!config) {
    throw new AiError(
      'LLM condition trigger requires an active AI configuration. Set one up in Settings → AI Assistant.',
      { code: 'ai_not_configured', status: 400 },
    )
  }

  const userContent =
    `CONDITION:\n${args.prompt.trim()}\n\n` +
    (args.conversationSnippet
      ? `RECENT CONVERSATION:\n${args.conversationSnippet.trim()}\n\n`
      : '') +
    `LATEST CUSTOMER MESSAGE:\n${args.recentMessage.trim()}\n\n` +
    `Does the customer's message satisfy the condition? Reply YES or NO on the first line, then optionally a brief one-line explanation. Nothing else.`

  const { text, usage } = await generateReply({
    config,
    systemPrompt:
      'You are a precise condition evaluator. Read the condition and the customer message(s), then decide if the condition is satisfied. Output exactly one line starting with YES or NO, followed optionally by a single short line of reasoning. No preamble, no labels, no quotes.',
    messages: [{ role: 'user', content: userContent }],
  })

  const firstLine = text.trim().split('\n')[0] ?? ''
  const verdict = firstLine.trim().toUpperCase()
  const boolean = verdict.startsWith('YES')

  // The reasoning lives on every line after the first; trim it.
  const rest = text.split('\n').slice(1).join(' ').trim()
  const reasoning = rest || undefined

  return { boolean, reasoning, usage }
}