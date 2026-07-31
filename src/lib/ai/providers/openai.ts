import type { ProviderResult } from '../types'
import { openAiCompatibleChat, type OpenAiCompatibleArgs } from './openai-compatible'

const OPENAI_URL = 'https://api.openai.com/v1'

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateOpenAi(
  args: Omit<OpenAiCompatibleArgs, 'baseUrl'>,
): Promise<ProviderResult> {
  return openAiCompatibleChat({ ...args, baseUrl: OPENAI_URL })
}
