/** Keep modern OpenAI reasoning requests compatible without changing other providers. */
export function chatParameters(provider: string, model: string, maxTokens = 256) {
  const reasoning = provider === 'openai' && /^(?:gpt-[56](?:[.-]|$)|o[134](?:-|$))/i.test(model);
  return reasoning
    ? { max_completion_tokens: Math.max(maxTokens, 4096), reasoning_effort: 'low' }
    : { max_tokens: maxTokens, temperature: 0 };
}
