import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export function getWorkersAiModels(): Model<"openai-completions">[] {
  const models = getBuiltinModels("cloudflare-workers-ai").filter(
    (model): model is Model<"openai-completions"> => model.api === "openai-completions",
  );
  return models.map((model): Model<"openai-completions"> => {
    if (model.compat?.thinkingFormat !== "deepseek") return model;
    return {
      ...model,
      compat: {
        ...model.compat,
        // Workers AI accepts chat_template_kwargs.enable_thinking, rather than
        // the native DeepSeek API's top-level thinking object in pi-ai's catalog.
        thinkingFormat: "chat-template",
        chatTemplateKwargs: {
          enable_thinking: { $var: "thinking.enabled" },
        },
      },
    };
  });
}
