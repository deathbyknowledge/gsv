import type { ContextState } from "../../types";

export function ContextMeter({ state }: { state: ContextState | null }) {
  if (!state) {
    return null;
  }
  const pressure = state.pressure === null ? 0 : Math.max(0, Math.min(1, state.pressure));
  const percent = state.pressure === null ? null : Math.round(pressure * 100);
  const label = percent === null ? "?" : `${percent}%`;
  const title = contextMeterTitle(state, label);
  return (
    <div class={`context-meter is-${state.level}`} title={title}>
      <span class="context-track"><span style={{ width: `${Math.round(pressure * 100)}%` }} /></span>
      <span>{label}</span>
    </div>
  );
}

export function ConversationCost({ state }: { state: ContextState | null }) {
  const usage = state?.conversationUsage;
  const cost = usage?.cost;
  if (!usage) {
    return null;
  }
  const label = cost
    ? `${usage.costIncomplete ? "~" : ""}${formatCurrencyCost(cost.total)}`
    : "n/a";
  const title = [
    cost ? `conversation cost ${label}` : "conversation cost unavailable",
    `${formatCompactTokens(usage.totalTokens)} tokens`,
    cost ? cost.source === "model-pricing" ? "model pricing" : cost.source : "pricing unavailable",
  ].join(" · ");
  return (
    <div class="conversation-cost" title={title} aria-label={title}>
      $
    </div>
  );
}

function contextMeterTitle(state: ContextState, label: string): string {
  if (state.inputTokens && state.availableInputTokens) {
    return `${formatCompactTokens(state.inputTokens)}/${formatCompactTokens(state.availableInputTokens)} (${label})`;
  }
  return "context unknown";
}

function formatCurrencyCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function formatCompactTokens(value: number | null): string {
  if (!value || !Number.isFinite(value)) return "0";
  if (value >= 1000000) return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (value >= 1000) return (value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(Math.round(value));
}
