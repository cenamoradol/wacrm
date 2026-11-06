import type { ProviderResult } from '../types';
import {
  openAiCompatibleChat,
  type OpenAiCompatibleArgs,
} from './openai-compatible';

const MINIMAX_URL = 'https://api.minimax.io/v1';

/**
 * MiniMax adapter — OpenAI-compatible Chat Completions at api.minimax.io.
 *
 * MiniMax publishes its chat API with the same wire format as OpenAI
 * (POST /chat/completions, Authorization: Bearer, same body schema), so
 * the request is identical to OpenAI's apart from the base URL. Default
 * model is configured in `defaults.ts` (AI_PROVIDER_DEFAULT_MODEL).
 *
 * Two MiniMax-specific quirks are handled by the shared helper: failures
 * reported with HTTP 200 + `base_resp.status_code`, and reasoning models
 * that burn the output-token cap on `reasoning_content` and come back
 * with no text (finish_reason: length).
 */
export async function generateMiniMax(
  args: Omit<OpenAiCompatibleArgs, 'baseUrl'>
): Promise<ProviderResult> {
  return openAiCompatibleChat({
    ...args,
    baseUrl: MINIMAX_URL,
    providerName: 'MiniMax',
  });
}
