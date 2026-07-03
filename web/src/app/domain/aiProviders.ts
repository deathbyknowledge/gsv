export type AiProviderOption = {
  value: string;
  label: string;
};

// Keep this to providers GSV can configure for chat/default model paths with
// its current provider/model/API key fields.
export const AI_PROVIDER_OPTIONS: ReadonlyArray<AiProviderOption> = [
  { value: "workers-ai", label: "Workers AI (gateway binding)" },
  { value: "custom", label: "Custom endpoint" },
  { value: "ant-ling", label: "Ant Ling" },
  { value: "anthropic", label: "Anthropic" },
  { value: "cerebras", label: "Cerebras" },
  { value: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "fireworks", label: "Fireworks AI" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "google", label: "Google AI" },
  { value: "google-vertex", label: "Google Vertex AI" },
  { value: "groq", label: "Groq" },
  { value: "huggingface", label: "Hugging Face" },
  { value: "kimi-coding", label: "Kimi Coding" },
  { value: "minimax", label: "MiniMax" },
  { value: "minimax-cn", label: "MiniMax China" },
  { value: "mistral", label: "Mistral AI" },
  { value: "moonshotai", label: "Moonshot AI" },
  { value: "moonshotai-cn", label: "Moonshot AI China" },
  { value: "nvidia", label: "NVIDIA" },
  { value: "openai", label: "OpenAI" },
  { value: "opencode", label: "OpenCode" },
  { value: "opencode-go", label: "OpenCode Go" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "together", label: "Together AI" },
  { value: "vercel-ai-gateway", label: "Vercel AI Gateway" },
  { value: "xai", label: "xAI" },
  { value: "xiaomi", label: "Xiaomi" },
  { value: "xiaomi-token-plan-ams", label: "Xiaomi Token Plan AMS" },
  { value: "xiaomi-token-plan-cn", label: "Xiaomi Token Plan China" },
  { value: "xiaomi-token-plan-sgp", label: "Xiaomi Token Plan Singapore" },
  { value: "zai", label: "Z.ai" },
  { value: "zai-coding-cn", label: "Z.ai Coding China" },
];

export const AI_OPENAI_WORKERS_PROVIDER_OPTIONS: ReadonlyArray<AiProviderOption> = [
  { value: "workers-ai", label: "Workers AI (gateway binding)" },
  { value: "openai", label: "OpenAI" },
];

export function aiProviderOptionsForValue(
  value: string,
  baseOptions: ReadonlyArray<AiProviderOption> = AI_PROVIDER_OPTIONS,
): AiProviderOption[] {
  if (!value.trim() || baseOptions.some((option) => option.value === value)) {
    return [...baseOptions];
  }
  return [
    ...baseOptions,
    { value, label: `${value} (custom)` },
  ];
}

export function aiProviderSelectIndex(options: readonly AiProviderOption[], value: string): number {
  return Math.max(0, options.findIndex((option) => option.value === value));
}
