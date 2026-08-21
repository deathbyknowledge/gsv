import type { AdminInferenceOverview } from "./service";
import {
  adminPageResponse,
  errorNotice,
  escapeHtml,
  formatDate,
  formatInteger,
  formatNanoUsd,
  metric,
  stateBadge,
} from "./page";

export function adminInferencePage(
  inference: AdminInferenceOverview,
  error?: string,
  head = false,
  status = 200,
): Response {
  const incomplete = inference.failed
    + inference.aborted
    + inference.abandoned;
  return adminPageResponse({
    title: "Managed inference",
    section: "inference",
    head,
    status,
    content: `<section class="stack">
      <div class="page-heading">
        <div><p class="eyebrow">GLOBAL POLICY</p><h1>Managed inference</h1></div>
        ${stateBadge(inference.enabled ? "enabled" : "paused")}
      </div>
      ${error ? errorNotice(error) : ""}
      <section class="metrics" aria-label="Platform inference usage">
        ${metric("Spend", formatNanoUsd(inference.costNanoUsd))}
        ${metric("Requests", formatInteger(inference.requests))}
        ${metric("Tokens", formatInteger(inference.tokens))}
        ${metric("Incomplete", formatInteger(incomplete))}
      </section>
      <section class="panel narrow">
        <p class="eyebrow">PLATFORM SWITCH</p>
        <h2>${inference.enabled ? "Requests enabled" : "Requests paused"}</h2>
        <p>This switch applies before every new platform-funded inference request. Installation allowances remain independently enforced.</p>
        <dl class="definition-list">
          <dt>Current period</dt><dd>${escapeHtml(inference.period)}</dd>
          <dt>Failed</dt><dd>${formatInteger(inference.failed)}</dd>
          <dt>Aborted</dt><dd>${formatInteger(inference.aborted)}</dd>
          <dt>Abandoned</dt><dd>${formatInteger(inference.abandoned)}</dd>
          <dt>Mail intake</dt><dd>${formatInteger(inference.mailIntake.requests)} requests · ${formatInteger(inference.mailIntake.tokens)} tokens · ${formatNanoUsd(inference.mailIntake.costNanoUsd)}</dd>
        </dl>
        <form class="form-actions" method="post" action="/admin/inference">
          <button class="${inference.enabled ? "danger" : ""}" type="submit" name="enabled" value="${inference.enabled ? "false" : "true"}">${inference.enabled ? "Pause all inference" : "Enable inference"}</button>
        </form>
      </section>
      <section class="panel">
        <p class="eyebrow">GSV/DEFAULT ROUTE</p>
        <h2>${escapeHtml(inference.routing.displayName)}</h2>
        <p>Users and agents continue to request <code>gsv/default</code>. This private operator route selects the OpenRouter model, acceptable providers, quantization, and the prices used for allowance accounting.</p>
        <form class="stack" method="post" action="/admin/inference/routing">
          <div class="grid">
            <label><span>OpenRouter model ID</span><input name="modelId" required maxlength="200" value="${escapeHtml(inference.routing.modelId)}"></label>
            <label><span>Operator display name</span><input name="displayName" required maxlength="200" value="${escapeHtml(inference.routing.displayName)}"></label>
            <label><span>Context window</span><input name="contextWindow" required inputmode="numeric" value="${inference.routing.contextWindow}"></label>
            <label><span>Maximum output tokens</span><input name="maxOutputTokens" required inputmode="numeric" value="${inference.routing.maxOutputTokens}"></label>
            <label><span>Reasoning</span><select name="reasoning">${booleanOptions(inference.routing.reasoning)}</select></label>
            <label><span>Provider sort</span><select name="sort">${selectOptions(["default", "price", "throughput", "latency"], inference.routing.provider.sort)}</select></label>
            <label><span>Input USD / million tokens</span><input name="inputUsdPerMillion" required inputmode="decimal" value="${formatRate(inference.routing.inputNanoUsdPerToken)}"></label>
            <label><span>Output USD / million tokens</span><input name="outputUsdPerMillion" required inputmode="decimal" value="${formatRate(inference.routing.outputNanoUsdPerToken)}"></label>
            <label><span>Cache read USD / million tokens</span><input name="cacheReadUsdPerMillion" required inputmode="decimal" value="${formatRate(inference.routing.cacheReadNanoUsdPerToken)}"></label>
            <label><span>Cache write USD / million tokens</span><input name="cacheWriteUsdPerMillion" required inputmode="decimal" value="${formatRate(inference.routing.cacheWriteNanoUsdPerToken)}"></label>
            <label><span>Allow fallback providers</span><select name="allowFallbacks">${booleanOptions(inference.routing.provider.allowFallbacks)}</select></label>
            <label><span>Require every request parameter</span><select name="requireParameters">${booleanOptions(inference.routing.provider.requireParameters)}</select></label>
            <label><span>Provider data collection</span><select name="dataCollection">${selectOptions(["deny", "allow"], inference.routing.provider.dataCollection)}</select></label>
            <label><span>Zero data retention only</span><select name="zdr">${booleanOptions(inference.routing.provider.zdr)}</select></label>
            <label><span>Preferred minimum throughput</span><input name="preferredMinThroughput" inputmode="decimal" placeholder="unset" value="${optionalNumber(inference.routing.provider.preferredMinThroughput)}"></label>
            <label><span>Preferred maximum latency (seconds)</span><input name="preferredMaxLatency" inputmode="decimal" placeholder="unset" value="${optionalNumber(inference.routing.provider.preferredMaxLatency)}"></label>
          </div>
          <label><span>Provider order (comma separated)</span><input name="order" maxlength="2048" value="${escapeHtml(inference.routing.provider.order.join(", "))}"></label>
          <label><span>Only these providers (comma separated)</span><input name="only" maxlength="2048" value="${escapeHtml(inference.routing.provider.only.join(", "))}"></label>
          <label><span>Ignore these providers (comma separated)</span><input name="ignore" maxlength="2048" value="${escapeHtml(inference.routing.provider.ignore.join(", "))}"></label>
          <label><span>Allowed quantizations (comma separated)</span><input name="quantizations" maxlength="256" placeholder="fp16, bf16, fp8" value="${escapeHtml(inference.routing.provider.quantizations.join(", "))}"></label>
          <div class="form-actions"><button type="submit">Update gsv/default route</button><small>${inference.routing.updatedAt === 0 ? "Using the deployment default" : `Last changed ${formatDate(inference.routing.updatedAt)}`}</small></div>
        </form>
      </section>
    </section>`,
  });
}

function booleanOptions(selected: boolean): string {
  return selectOptions(["true", "false"], String(selected));
}

function selectOptions(values: readonly string[], selected: string): string {
  return values.map((value) =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`
  ).join("");
}

function formatRate(nanoUsdPerToken: number): string {
  const value = (nanoUsdPerToken / 1_000).toFixed(3);
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function optionalNumber(value: number | undefined): string {
  return value === undefined ? "" : escapeHtml(String(value));
}
