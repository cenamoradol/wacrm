import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

/**
 * Shared OpenAI-compatible Chat Completions call.
 *
 * Both OpenAI and providers that mirror its wire format (MiniMax,
 * Together, Groq, etc.) hit the same endpoint shape: POST {baseUrl}/chat/completions,
 * Authorization: Bearer <key>, body { model, messages, max_completion_tokens }.
 * The wrappers (`openai.ts`, `minimax.ts`) only differ in the base URL.
 */
export interface OpenAiCompatibleArgs extends ProviderArgs {
  baseUrl: string
}

export async function openAiCompatibleChat(
  args: OpenAiCompatibleArgs,
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, baseUrl } = args

  let res: Response
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...mergeConsecutive(messages),
        ],
        max_completion_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI-compatible', res)
  }

  const data = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string } }[]
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  } | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError('OpenAI-compatible provider returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text, usage }
}
