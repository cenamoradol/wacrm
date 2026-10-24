import type { ProviderResult } from '../types';
import {
  openAiCompatibleChat,
  type OpenAiCompatibleArgs,
} from './openai-compatible';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

/**
 * OpenRouter adapter — OpenAI-compatible Chat Completions at openrouter.ai.
 *
 * One key fronts every model OpenRouter serves (OpenAI, Anthropic,
 * Google, ...) under `provider/model` ids, so the request is identical
 * to OpenAI's apart from the base URL. Default model is configured in
 * `defaults.ts` (AI_PROVIDER_DEFAULT_MODEL.openrouter).
 */
export async function generateOpenRouter(
  args: Omit<OpenAiCompatibleArgs, 'baseUrl'>
): Promise<ProviderResult> {
  return openAiCompatibleChat({ ...args, baseUrl: OPENROUTER_URL });
}
