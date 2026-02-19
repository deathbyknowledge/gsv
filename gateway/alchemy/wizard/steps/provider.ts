/**
 * LLM Provider Selection Step
 */

import type { Prompter } from "../prompter";
import type { WizardMode, LLMProvider, LLMProviderConfig } from "../types";
import { isCancelled, handleCancel } from "../prompter";
import { PROVIDER_MODELS, PROVIDER_INFO } from "../types";
import pc from "picocolors";

export async function providerStep(
  p: Prompter,
  mode: WizardMode
): Promise<LLMProviderConfig> {
  // Select provider
  const provider = await p.select<LLMProvider>({
    message: "Which LLM provider do you want to use?",
    options: [
      {
        value: "anthropic",
        label: "Anthropic Claude",
        hint: "Recommended for coding",
      },
      {
        value: "openai",
        label: "OpenAI",
        hint: "GPT-4o, o1",
      },
      {
        value: "google",
        label: "Google AI",
        hint: "Gemini models",
      },
      {
        value: "openrouter",
        label: "OpenRouter",
        hint: "Access multiple providers",
      },
    ],
    initialValue: "anthropic",
  });

  if (isCancelled(provider)) {
    handleCancel();
  }

  // Select model
  const models = PROVIDER_MODELS[provider];
  let model: string;

  if (mode === "quickstart") {
    // Use default model in quickstart
    model = models[0].id;
    p.log(`Using model: ${pc.cyan(models[0].name)}`);
  } else {
    // Add "Custom" option to model list
    const modelOptions = [
      ...models.map((m) => ({
        value: m.id,
        label: m.name,
      })),
      {
        value: "__custom__",
        label: "Custom model ID",
        hint: "Enter a specific model ID",
      },
    ];

    const selectedModel = await p.select<string>({
      message: "Which model do you want to use?",
      options: modelOptions,
      initialValue: models[0].id,
    });

    if (isCancelled(selectedModel)) {
      handleCancel();
    }

    if (selectedModel === "__custom__") {
      // Prompt for custom model ID
      const customModel = await p.text({
        message: "Enter the model ID",
        placeholder: models[0].id,
        validate: (value) => {
          if (!value || value.trim().length === 0) {
            return "Model ID is required";
          }
        },
      });

      if (isCancelled(customModel)) {
        handleCancel();
      }

      model = customModel.trim();
    } else {
      model = selectedModel;
    }
  }

  // Get API key
  const info = PROVIDER_INFO[provider];
  p.note(
    `Get your ${info.name} API key at:\n${pc.cyan(info.keyUrl)}`,
    `${info.name} API Key`
  );

  const apiKey = await p.password({
    message: `Enter your ${info.name} API key`,
    validate: (value) => {
      if (!value) {
        return "API key is required";
      }
      // Basic prefix validation
      if (info.keyPrefix && !value.startsWith(info.keyPrefix)) {
        return `Key should start with "${info.keyPrefix}"`;
      }
    },
  });

  if (isCancelled(apiKey)) {
    handleCancel();
  }

  p.log(`✓ Provider: ${provider}`);
  p.log(`✓ Model: ${model}`);
  p.log(`✓ API Key: ${apiKey.slice(0, 8)}${apiKey.length > 8 ? '...' : ''}`);

  return { provider, model, apiKey };
}
