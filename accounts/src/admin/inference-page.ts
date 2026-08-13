import type { AdminInferenceOverview } from "./service";
import {
  adminPageResponse,
  errorNotice,
  escapeHtml,
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
    </section>`,
  });
}
