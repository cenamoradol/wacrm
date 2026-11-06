import { AiError, type ProviderResult } from '../types';
import { MAX_OUTPUT_TOKENS } from '../defaults';
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared';

/**
 * Shared OpenAI-compatible Chat Completions call.
 *
 * Both OpenAI and providers that mirror its wire format (MiniMax,
 * Together, Groq, etc.) hit the same endpoint shape: POST {baseUrl}/chat/completions,
 * Authorization: Bearer <key>, body { model, messages, max_completion_tokens }.
 * The wrappers (`openai.ts`, `minimax.ts`) only differ in the base URL.
 */
export interface OpenAiCompatibleArgs extends ProviderArgs {
  baseUrl: string;
  /** Name used in error messages. Defaults to 'OpenAI-compatible'. */
  providerName?: string;
}

export async function openAiCompatibleChat(
  args: OpenAiCompatibleArgs
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, baseUrl } = args;
  const providerName = args.providerName ?? 'OpenAI-compatible';

  let res: Response;
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
    });
  } catch (err) {
    throw toNetworkError(err);
  }

  if (!res.ok) {
    throw await providerHttpError(providerName, res);
  }

  const data = (await res.json().catch(() => null)) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
    base_resp?: { status_code?: number; status_msg?: string };
  } | null;

  // MiniMax reports some failures with HTTP 200 and a non-zero
  // base_resp.status_code. Without this check they surface as an
  // "empty response" and the real reason never reaches the user.
  const baseCode = data?.base_resp?.status_code;
  if (typeof baseCode === 'number' && baseCode !== 0) {
    throw new AiError(
      `${providerName} error ${baseCode}: ${
        data?.base_resp?.status_msg || 'unknown error'
      }`,
      { code: 'provider_error' }
    );
  }

  const choice = data?.choices?.[0];
  const text = choice?.message?.content;
  if (!text || typeof text !== 'string' || !text.trim()) {
    // MiniMax's reasoning models spend part of the output budget on
    // `reasoning_content`; when the cap is hit first the reply comes back
    // empty. Name the cause instead of a bare "empty response".
    const reason = choice?.finish_reason;
    throw new AiError(
      reason === 'length'
        ? `${providerName} returned no text — the output-token cap was hit before the reply was written (finish_reason: length). Raise the output-token cap.`
        : `${providerName} returned an empty response.`,
      {
        code: 'empty_response',
      }
    );
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  });
  return { text, usage };
}
