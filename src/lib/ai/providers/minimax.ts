import type { ProviderResult } from '../types'
import { openAiCompatibleChat, type OpenAiCompatibleArgs } from './openai-compatible'

const MINIMAX_URL = 'https://api.minimax.io/v1'

/**
 * MiniMax adapter — OpenAI-compatible Chat Completions at api.minimax.io.
 *
 * MiniMax publishes its chat API with the same wire format as OpenAI
 * (POST /chat/completions, Authorization: Bearer, same body schema), so
 * the request is identical to OpenAI's apart from the base URL. Default
 * model is configured in `defaults.ts` (MINIMAX_DEFAULT_MODEL).
 */
export async function generateMiniMax(
  args: Omit<OpenAiCompatibleArgs, 'baseUrl'>,
): Promise<ProviderResult> {
  return openAiCompatibleChat({ ...args, baseUrl: MINIMAX_URL })
}
