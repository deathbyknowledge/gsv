/**
 * Wizard Types and State
 */

export type WizardMode = "quickstart" | "advanced";

export type LLMProvider = "anthropic" | "openai" | "google" | "openrouter";

export interface LLMProviderConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
}

export interface ChannelConfig {
  whatsapp: boolean;
  discord: boolean;
  discordBotToken?: string;
}

export interface WizardState {
  /** Wizard mode */
  mode: WizardMode;
  
  /** Stack/deployment name */
  stackName: string;
  
  /** Auth token for Gateway */
  authToken: string;
  
  /** LLM provider configuration */
  llm: LLMProviderConfig;
  
  /** Channel configuration */
  channels: ChannelConfig;
  
  /** Deploy workspace templates */
  deployTemplates: boolean;
  
  /** Deploy web UI */
  deployUI: boolean;
  
  /** Deployment results */
  deployment?: {
    gatewayUrl?: string;
    whatsappUrl?: string;
    discordUrl?: string;
  };
}

export const DEFAULT_STATE: WizardState = {
  mode: "quickstart",
  stackName: "gsv",
  authToken: "",
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    apiKey: "",
  },
  channels: {
    whatsapp: false,
    discord: false,
  },
  deployTemplates: true,
  deployUI: true,
};

export const PROVIDER_MODELS: Record<LLMProvider, { id: string; name: string }[]> = {
  anthropic: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4 (Recommended)" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4 (Most Capable)" },
    { id: "claude-3-7-sonnet-20250219", name: "Claude 3.7 Sonnet" },
    { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku (Fast)" },
  ],
  openai: [
    { id: "gpt-4.1", name: "GPT-4.1 (Recommended)" },
    { id: "gpt-4.1-mini", name: "GPT-4.1 Mini (Fast)" },
    { id: "gpt-4.1-nano", name: "GPT-4.1 Nano (Fastest)" },
    { id: "o3", name: "o3 (Reasoning)" },
    { id: "o4-mini", name: "o4-mini (Fast Reasoning)" },
  ],
  google: [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (Recommended)" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
    { id: "anthropic/claude-opus-4", name: "Claude Opus 4" },
    { id: "openai/gpt-4.1", name: "GPT-4.1" },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "deepseek/deepseek-r1", name: "DeepSeek R1 (Reasoning)" },
  ],
};

export const PROVIDER_INFO: Record<LLMProvider, { name: string; keyPrefix: string; keyUrl: string }> = {
  anthropic: {
    name: "Anthropic",
    keyPrefix: "sk-ant-",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    name: "OpenAI",
    keyPrefix: "sk-",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  google: {
    name: "Google AI",
    keyPrefix: "AIza",
    keyUrl: "https://aistudio.google.com/apikey",
  },
  openrouter: {
    name: "OpenRouter",
    keyPrefix: "sk-or-",
    keyUrl: "https://openrouter.ai/keys",
  },
};
