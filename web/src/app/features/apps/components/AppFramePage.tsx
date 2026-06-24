import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../../components/ui/Button";
import { ConsoleHeader } from "../../../components/ui/ConsoleHeader";
import { Icon } from "../../../components/ui/Icon";
import { Spinner } from "../../../components/ui/Spinner";
import { useGateway } from "../../../services/gateway/GatewayProvider";
import type { DesktopApp } from "../../desktop/domain/desktopApp";
import { createAppRuntime } from "../../desktop/runtime/appsRuntime";
import type { AppInstance } from "../../desktop/runtime/appRuntime";
import { usePackageApps } from "../../packages/usePackageApps";
import type { ShellAppRoute } from "../../gsv-shell/domain/shellModel";
import { normalizeShellAppRoute } from "../../gsv-shell/domain/shellModel";
import "./AppFramePage.css";

type AppFramePageProps = {
  appRoute: ShellAppRoute;
  onBackToDesktop: () => void;
  onOpenAppRoute: (route: ShellAppRoute, title?: string) => string;
};

function normalizedRouteBase(app: DesktopApp): string {
  const url = new URL(app.routeBase, window.location.origin);
  return url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
}

function runtimeRouteForAppRoute(app: DesktopApp, appRoute: ShellAppRoute): string {
  const route = normalizeShellAppRoute(appRoute);
  const base = normalizedRouteBase(app);
  const suffix = route.suffix === "/" ? "/" : route.suffix;
  return `${base}${suffix}${route.search}${route.hash}`;
}

function appRouteFromRuntimeRoute(app: DesktopApp, route: string): ShellAppRoute {
  const url = new URL(route || app.routeBase, window.location.origin);
  const base = normalizedRouteBase(app);
  const suffix = url.pathname === base || url.pathname === `${base}/`
    ? "/"
    : url.pathname.startsWith(`${base}/`)
      ? `/${url.pathname.slice(base.length + 1)}`
      : "/";

  return normalizeShellAppRoute({
    appId: app.id,
    suffix,
    search: url.search,
    hash: url.hash,
  });
}

function AppFrameEmpty({
  actionLabel,
  message,
  onAction,
  title,
}: {
  actionLabel?: string;
  message: string;
  onAction?: () => void;
  title: string;
}) {
  return (
    <div class="gsv-app-frame-empty">
      <span class="gsv-app-frame-empty-icon">
        <Icon name="stars" size={26} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{message}</p>
      </div>
      {actionLabel && onAction ? <Button variant="secondary" label={actionLabel} onClick={onAction} /> : null}
    </div>
  );
}

export function AppFramePage({
  appRoute,
  onBackToDesktop,
  onOpenAppRoute,
}: AppFramePageProps) {
  const { client: gatewayClient, connected } = useGateway();
  const packageApps = usePackageApps({ gatewayClient, enabled: connected });
  const hostRef = useRef<HTMLDivElement>(null);
  const onOpenAppRouteRef = useRef(onOpenAppRoute);
  const windowIdRef = useRef(`native-app-${crypto.randomUUID()}`);
  const [title, setTitle] = useState<string | null>(null);
  const [badge, setBadge] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const app = useMemo(
    () => packageApps.data?.find((candidate) => candidate.id === appRoute.appId) ?? null,
    [appRoute.appId, packageApps.data],
  );
  const runtimeRoute = useMemo(
    () => app ? runtimeRouteForAppRoute(app, appRoute) : null,
    [app, appRoute],
  );
  const displayTitle = title?.trim() || app?.name || appRoute.appId;

  useEffect(() => {
    onOpenAppRouteRef.current = onOpenAppRoute;
  }, [onOpenAppRoute]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !app || !runtimeRoute) {
      return;
    }

    const registry = createAppRuntime(gatewayClient);
    const instance: AppInstance = registry.createInstance(app);
    host.replaceChildren();

    void instance.mount(host, {
      app,
      route: runtimeRoute,
      windowId: windowIdRef.current,
      requestFocus: () => host.focus(),
      setTitle,
      setBadge,
      setDirty,
      requestNewWindow: (route) => onOpenAppRouteRef.current(
        appRouteFromRuntimeRoute(app, route ?? runtimeRoute),
        app.name,
      ),
    });

    return () => {
      void instance.terminate?.();
      host.replaceChildren();
    };
  }, [app, gatewayClient, runtimeRoute]);

  return (
    <section class="gsv-app-frame-page" aria-label={`${displayTitle} app`}>
      <ConsoleHeader
        crumbs={[
          { label: "GSV", onClick: onBackToDesktop, notLast: true },
          { label: "APPLICATIONS", notLast: true },
          { label: displayTitle },
        ]}
        tail="GSV · APP"
        onBack={onBackToDesktop}
      />
      <div class="gsv-app-frame-toolbar">
        <div class="gsv-app-frame-identity">
          <span class="gsv-app-frame-icon">
            <Icon name="stars" size={18} />
          </span>
          <div>
            <strong>{displayTitle}</strong>
            <span>
              {app?.launch.kind === "package" ? app.launch.packageName : appRoute.appId}
              {badge ? ` · ${badge}` : ""}
              {dirty ? " · UNSAVED" : ""}
            </span>
          </div>
        </div>
        <span class="gsv-app-frame-route">{runtimeRoute ?? "/open"}</span>
      </div>
      <div class="gsv-app-frame-host-shell">
        {!connected ? (
          <AppFrameEmpty
            title="GATEWAY OFFLINE"
            message="Package entrypoints are unavailable until the shell reconnects."
            actionLabel="BACK TO DESKTOP"
            onAction={onBackToDesktop}
          />
        ) : packageApps.isLoading ? (
          <AppFrameEmpty
            title="LOADING APP"
            message="Package entrypoints are being loaded from the gateway."
          />
        ) : packageApps.isError ? (
          <AppFrameEmpty
            title="APP LIST UNAVAILABLE"
            message="The package app registry could not be loaded."
            actionLabel="BACK TO DESKTOP"
            onAction={onBackToDesktop}
          />
        ) : app ? (
          <div class="gsv-app-frame-host" ref={hostRef} tabIndex={-1} />
        ) : (
          <AppFrameEmpty
            title="APP NOT FOUND"
            message="This route does not match a launchable web UI package."
            actionLabel="BACK TO DESKTOP"
            onAction={onBackToDesktop}
          />
        )}
        {app && !runtimeRoute ? (
          <div class="gsv-app-frame-loading">
            <Spinner size={22} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
