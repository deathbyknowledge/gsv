/**
 * Inline directive parsing for GSV
 * 
 * Directives are inline settings that can be included in any message.
 * They are stripped from the message before sending to the LLM.
 * 
 * Supported directives:
 * - /think:level or /t:level - Set thinking level for this message
 * - /model:model-id - Use current provider + model for this message
 * - /model:provider/model-id - Use provider + model for this message
 * - /status - Include status info in response
 * 
 * Examples:
 * - "Hello /think:high" → thinking=high, message="Hello"
 * - "/t:low What's 2+2?" → thinking=low, message="What's 2+2?"
 * - "/model:anthropic/claude-opus-4-6 Explain quantum physics"
 */

import {
  MODEL_SELECTOR_HELP,
  normalizeThinkLevel,
  parseModelSelection,
  type ThinkLevel,
} from "./commands";

export type ParsedDirectives = {
  /** Message with directives stripped */
  cleaned: string;
  
  /** Thinking level directive */
  thinkLevel?: ThinkLevel;
  hasThinkDirective: boolean;
  
  /** Model directive */
  model?: { provider: string; id: string };
  hasModelDirective: boolean;
  rawModelDirective?: string;
  
  /** Status directive - show status in response */
  hasStatusDirective: boolean;
};

/**
 * Extract a directive with optional argument
 * Pattern: /name or /name:value
 */
function extractDirective(
  text: string,
  names: string[],
): { cleaned: string; value?: string; hasDirective: boolean } {
  // Build pattern for all name variants
  const namePattern = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  
  // Match /name or /name:value (value is any non-whitespace token)
  const regex = new RegExp(
    `(?:^|\\s)\\/(?:${namePattern})(?::([^\\s]+))?(?=\\s|$)`,
    "gi"
  );
  
  const match = regex.exec(text);
  if (!match) {
    return { cleaned: text.trim(), hasDirective: false };
  }
  
  const value = match[1]; // captured group (the value after :)
  const cleaned = text
    .slice(0, match.index)
    .concat(" ")
    .concat(text.slice(match.index + match[0].length))
    .replace(/\s+/g, " ")
    .trim();
  
  return { cleaned, value, hasDirective: true };
}

/**
 * Parse all inline directives from a message
 */
export function parseDirectives(
  text: string,
  fallbackModelProvider?: string,
): ParsedDirectives {
  let current = text;
  
  // Extract /think directive
  const think = extractDirective(current, ["thinking", "think", "t"]);
  current = think.cleaned;
  const thinkLevel = think.hasDirective ? normalizeThinkLevel(think.value) : undefined;
  
  // Extract /model directive
  const model = extractDirective(current, ["model", "m"]);
  current = model.cleaned;
  const resolvedModel = model.hasDirective && model.value 
    ? parseModelSelection(model.value, fallbackModelProvider)
    : undefined;
  
  // Extract /status directive (no value)
  const status = extractDirective(current, ["status"]);
  current = status.cleaned;
  
  return {
    cleaned: current,
    thinkLevel,
    hasThinkDirective: think.hasDirective,
    model: resolvedModel,
    hasModelDirective: model.hasDirective,
    rawModelDirective: model.value,
    hasStatusDirective: status.hasDirective,
  };
}

/**
 * Check if message is ONLY directives (no actual content)
 */
export function isDirectiveOnly(text: string): boolean {
  const parsed = parseDirectives(text);
  const hasAnyDirective = parsed.hasThinkDirective || parsed.hasModelDirective || parsed.hasStatusDirective;
  return hasAnyDirective && parsed.cleaned.length === 0;
}

/**
 * Format directive acknowledgment message
 */
export function formatDirectiveAck(directives: ParsedDirectives): string | undefined {
  const parts: string[] = [];
  
  if (directives.hasThinkDirective && directives.thinkLevel) {
    parts.push(`Thinking: ${directives.thinkLevel}`);
  }
  
  if (directives.hasModelDirective) {
    if (directives.model) {
      parts.push(`Model: ${directives.model.provider}/${directives.model.id}`);
    } else if (directives.rawModelDirective) {
      parts.push(
        `Invalid model selector: ${directives.rawModelDirective} (${MODEL_SELECTOR_HELP})`,
      );
    }
  }
  
  if (parts.length === 0) return undefined;
  return `_${parts.join(" | ")}_`;
}
