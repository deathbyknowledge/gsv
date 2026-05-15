import type { ComponentChildren } from "preact";
import { formatJson, formatStructuredValue, humanizeKey, plainObjectEntries } from "../../utils/format";
import { workflowStateLabel } from "../../domain/messageWorkflow";

export function IconButton(props: {
  label: string;
  glyph: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      class={`social-icon-button${props.danger ? " is-danger" : ""}`}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.glyph}
    </button>
  );
}

export function EmptyState(props: { title: string; body?: string }) {
  return (
    <section class="social-empty-state">
      <h2>{props.title}</h2>
      {props.body ? <p>{props.body}</p> : null}
    </section>
  );
}

export function StatusDot(props: { status: string }) {
  return <span class={`social-status-dot is-${props.status}`} aria-hidden="true" />;
}

export function StatusPill(props: { status: string; children?: ComponentChildren }) {
  return (
    <span class={`social-pill is-${props.status}`}>
      {props.children ?? workflowStateLabel(props.status)}
    </span>
  );
}

export function PaneHeader(props: {
  eyebrow?: string;
  title: string;
  meta?: ComponentChildren;
  actions?: ComponentChildren;
}) {
  return (
    <header class="social-pane-header">
      <div class="social-pane-title">
        {props.eyebrow ? <p class="social-eyebrow">{props.eyebrow}</p> : null}
        <h2>{props.title}</h2>
        {props.meta ? <div class="social-pane-meta">{props.meta}</div> : null}
      </div>
      {props.actions ? <div class="social-pane-actions">{props.actions}</div> : null}
    </header>
  );
}

export function FieldList(props: { children: ComponentChildren }) {
  return <dl class="social-field-list">{props.children}</dl>;
}

export function FieldRow(props: { label: string; value: ComponentChildren }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

export function StructuredDetails(props: { value: unknown; maxRows?: number }) {
  if (props.value === undefined) {
    return null;
  }
  if (typeof props.value === "string") {
    return <p class="social-structured-text">{props.value}</p>;
  }
  const entries = plainObjectEntries(props.value);
  const maxRows = props.maxRows ?? 5;
  if (entries.length === 0) {
    return (
      <details class="social-raw-details">
        <summary>Raw details</summary>
        <pre>{formatJson(props.value)}</pre>
      </details>
    );
  }
  return (
    <div class="social-field-list is-compact">
      {entries.slice(0, maxRows).map(([key, value]) => (
        <div key={key}>
          <dt>{humanizeKey(key)}</dt>
          <dd>{formatStructuredValue(value)}</dd>
        </div>
      ))}
      {entries.length > maxRows ? (
        <details class="social-raw-details">
          <summary>{entries.length - maxRows} more</summary>
          <pre>{formatJson(props.value)}</pre>
        </details>
      ) : null}
    </div>
  );
}
