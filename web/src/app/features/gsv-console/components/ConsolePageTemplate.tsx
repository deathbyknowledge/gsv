import type { ComponentChildren } from "preact";
import { StatusDot, type StatusTone } from "../../../components/ui/StatusDot";
import type { ConsoleResourceState } from "../domain/consoleModels";
import "./ConsolePageTemplate.css";

export type ConsolePageStateKind = "loading" | "error" | "empty" | "offline";

type ConsolePageProps = {
  children: ComponentChildren;
  flush?: boolean;
  className?: string;
};

type ConsoleResourceBoundaryProps<T> = {
  resource: ConsoleResourceState<T>;
  emptyLabel: string;
  errorLabel: string;
  loadingLabel?: string;
  render: (data: T) => ComponentChildren;
};

const STATE_LABEL: Record<ConsolePageStateKind, string> = {
  loading: "LOADING",
  error: "ERROR",
  empty: "NO DATA",
  offline: "WAITING FOR GATEWAY",
};

const STATE_TONE: Record<ConsolePageStateKind, StatusTone> = {
  loading: "live",
  error: "error",
  empty: "idle",
  offline: "idle",
};

export function ConsolePage({ children, flush = false, className = "" }: ConsolePageProps) {
  const classes = ["gsv-console-page", flush ? "is-flush" : "", className].filter(Boolean).join(" ");
  return (
    <section class={classes}>
      <div class="gsv-console-page-body">{children}</div>
    </section>
  );
}

export function ConsolePageState({
  kind,
  label,
  detail,
}: {
  kind: ConsolePageStateKind;
  label?: string;
  detail?: string;
}) {
  const resolvedLabel = label ?? STATE_LABEL[kind];
  const text = detail ? `${resolvedLabel} · ${detail}` : resolvedLabel;

  return (
    <div
      class="gsv-console-state"
      role={kind === "error" ? "alert" : "status"}
      aria-live={kind === "loading" ? "polite" : undefined}
    >
      <span class="gsv-console-state-copy">
        <StatusDot tone={STATE_TONE[kind]} size={7} />
        <span>{text}</span>
      </span>
    </div>
  );
}

export function ConsoleResourceBoundary<T>({
  resource,
  emptyLabel,
  errorLabel,
  loadingLabel,
  render,
}: ConsoleResourceBoundaryProps<T>) {
  if (resource.isUnavailable) {
    return <ConsolePageState kind="offline" detail="CONNECTION REQUIRED" />;
  }
  if (resource.isError) {
    return <ConsolePageState kind="error" detail={resource.errorText || errorLabel} />;
  }
  if (resource.isLoading) {
    return <ConsolePageState kind="loading" label={loadingLabel} />;
  }
  if (resource.isEmpty || resource.data === null) {
    return <ConsolePageState kind="empty" label={emptyLabel} />;
  }
  return <>{render(resource.data)}</>;
}
