import { useEffect, useState } from "preact/hooks";
import { ConsoleHeader, type ConsoleCrumb } from "../../../components/ui/ConsoleHeader";
import { FilesSurfaceSummary } from "../../files/components/FilesSurfaceSummary";
import { TerminalSurfaceSummary } from "../../terminal/components/TerminalSurfaceSummary";
import { shellSurfaceLabel, type ShellSurfaceId } from "../../gsv-shell/domain/shellModel";
import { ConsoleAgentPage } from "../pages/ConsoleAgentPage";
import { ConsoleConfigPage, type ConsoleConfigKind } from "../pages/ConsoleConfigPage";
import { ConsoleCrewPage } from "../pages/ConsoleCrewPage";
import { ConsoleListPage, type ConsoleListKind } from "../pages/ConsoleListPage";
import { ConsoleOverviewPage, type ConsoleOverviewTarget } from "../pages/ConsoleOverviewPage";

type GsvConsoleProps = {
  activeSurface: Exclude<ShellSurfaceId, "desktop">;
  onBackToDesktop: () => void;
  onOpenSurface?: (surface: Exclude<ShellSurfaceId, "desktop">) => void;
  onSettingsRouteChange?: (route: SettingsRouteRequestRoute) => void;
  settingsRouteRequest?: SettingsRouteRequest | null;
};

type SettingsRoute =
  | { view: "overview" }
  | { view: "list"; kind: ConsoleListKind; detailId?: string; detailLabel?: string; createNew?: boolean }
  | { view: "config"; kind: ConsoleConfigKind }
  | { view: "crew" }
  | { view: "agent"; accountUid: number | null; createNew?: boolean };
type SettingsListSurface = "machines" | "messengers" | "integrations" | "applications" | "library" | "runtime";
export type SettingsRouteTarget = "overview" | "crew" | "tasks" | "models" | "overrides";
export type SettingsRouteRequestRoute = SettingsRoute;
export type SettingsRouteRequest = {
  id: number;
} & (
  | { target: SettingsRouteTarget }
  | { route: SettingsRouteRequestRoute }
);

function surfaceTail(surface: ShellSurfaceId): string {
  if (surface === "files") {
    return "GSV · STORAGE";
  }
  if (surface === "library") {
    return "GSV · PACKAGES";
  }
  if (surface === "terminal") {
    return "GSV · CONSOLE";
  }
  if (surface === "runtime") {
    return "GSV · RUNTIME";
  }
  if (surface === "messengers") {
    return "GSV · MESSENGERS";
  }
  if (surface === "integrations") {
    return "GSV · INTEGRATIONS";
  }
  if (surface === "applications") {
    return "GSV · APPLICATIONS";
  }
  if (surface === "crew" || surface === "agent") {
    return "GSV · CREW";
  }
  return "GSV · CONTROL";
}

function isSettingsListSurface(surface: Exclude<ShellSurfaceId, "desktop">): surface is SettingsListSurface {
  return surface === "machines"
    || surface === "messengers"
    || surface === "integrations"
    || surface === "applications"
    || surface === "library"
    || surface === "runtime";
}

function listKindForSurface(surface: SettingsListSurface): ConsoleListKind {
  return surface === "runtime" ? "tasks" : surface;
}

function settingsRouteLabel(route: SettingsRoute): string {
  if (route.view === "overview") {
    return "SETTINGS";
  }
  if (route.view === "crew") {
    return "CREW";
  }
  if (route.view === "agent") {
    if (route.createNew) {
      return "NEW AGENT";
    }
    return "AGENT";
  }
  if (route.view === "config") {
    return route.kind === "models" ? "MODELS" : "OVERRIDES";
  }
  if (route.createNew) {
    if (route.kind === "machines") return "NEW MACHINE";
    if (route.kind === "integrations") return "NEW INTEGRATION";
    if (route.kind === "applications") return "NEW APPLICATION";
  }
  if (route.detailLabel) {
    return route.detailLabel;
  }
  return route.kind === "tasks" ? "TASKS" : shellSurfaceLabel(route.kind);
}

function settingsListRouteLabel(kind: ConsoleListKind): string {
  return kind === "tasks" ? "TASKS" : shellSurfaceLabel(kind);
}

function settingsListDetailLabel(route: Extract<SettingsRoute, { view: "list" }>): string {
  if (route.createNew) {
    if (route.kind === "machines") return "NEW MACHINE";
    if (route.kind === "integrations") return "NEW INTEGRATION";
    if (route.kind === "applications") return "NEW APPLICATION";
    if (route.kind === "messengers") return "NEW MESSENGER";
    if (route.kind === "library") return "NEW PACKAGE";
    return "NEW TASK";
  }
  return route.detailLabel ?? route.detailId ?? settingsListRouteLabel(route.kind);
}

function hasSettingsListDetail(route: SettingsRoute): route is Extract<SettingsRoute, { view: "list" }> {
  return route.view === "list" && (Boolean(route.detailId) || route.createNew === true);
}

function settingsRouteTail(route: SettingsRoute): string {
  if (route.view === "overview") {
    return "GSV · CONTROL";
  }
  if (route.view === "crew" || route.view === "agent") {
    return "GSV · CREW";
  }
  if (route.view === "config") {
    return route.kind === "models" ? "GSV · MODELS" : "GSV · CONFIG";
  }
  if (route.kind === "tasks") {
    return "GSV · RUNTIME";
  }
  return surfaceTail(route.kind);
}

function settingsRouteForTarget(target: SettingsRouteTarget): SettingsRoute {
  if (target === "overview") {
    return { view: "overview" };
  }
  if (target === "crew") {
    return { view: "crew" };
  }
  if (target === "tasks") {
    return { view: "list", kind: "tasks" };
  }
  return { view: "config", kind: target };
}

function settingsRouteForRequest(request: SettingsRouteRequest): SettingsRoute {
  if ("route" in request) {
    return request.route;
  }
  return settingsRouteForTarget(request.target);
}

export function GsvConsole({
  activeSurface,
  onBackToDesktop,
  onOpenSurface,
  onSettingsRouteChange,
  settingsRouteRequest,
}: GsvConsoleProps) {
  const [selectedAgentUid, setSelectedAgentUid] = useState<number | null>(null);
  const [settingsRoute, setSettingsRoute] = useState<SettingsRoute>({ view: "overview" });
  const navigateSettingsRoute = (route: SettingsRoute) => {
    setSettingsRoute(route);
    onSettingsRouteChange?.(route);
  };
  const openAgent = (uid: number) => {
    setSelectedAgentUid(uid);
    onOpenSurface?.("agent");
  };
  const backToCrew = () => onOpenSurface?.("crew");
  const openSettingsAgent = (uid: number) => {
    setSelectedAgentUid(uid);
    navigateSettingsRoute({ view: "agent", accountUid: uid });
  };
  const openSettingsNewAgent = () => {
    navigateSettingsRoute({ view: "agent", accountUid: null, createNew: true });
  };
  const openCreatedSettingsAgent = (uid: number) => {
    setSelectedAgentUid(uid);
    navigateSettingsRoute({ view: "agent", accountUid: uid });
  };
  const backToSettingsCrew = () => navigateSettingsRoute({ view: "crew" });
  const openSettingsListDetail = (kind: ConsoleListKind, detailId: string, detailLabel?: string) => {
    navigateSettingsRoute({ view: "list", kind, detailId, detailLabel });
  };
  const openSettingsListCreate = (kind: ConsoleListKind) => {
    navigateSettingsRoute({ view: "list", kind, createNew: true });
  };
  const handleSettingsListSelectionChange = (
    kind: ConsoleListKind,
    selection: { detailId?: string; detailLabel?: string; createNew?: boolean } | null,
  ) => {
    navigateSettingsRoute(selection ? { view: "list", kind, ...selection } : { view: "list", kind });
  };
  const openSettingsSurface = (surface: ConsoleOverviewTarget) => {
    if (surface === "settings") {
      navigateSettingsRoute({ view: "overview" });
      return;
    }
    if (surface === "models" || surface === "overrides") {
      navigateSettingsRoute({ view: "config", kind: surface });
      return;
    }
    if (surface === "crew") {
      navigateSettingsRoute({ view: "crew" });
      return;
    }
    if (surface === "tasks") {
      navigateSettingsRoute({ view: "list", kind: "tasks" });
      return;
    }
    if (surface === "new-agent") {
      openSettingsNewAgent();
      return;
    }
    if (surface === "agent") {
      navigateSettingsRoute({ view: "agent", accountUid: selectedAgentUid });
      return;
    }
    if (isSettingsListSurface(surface)) {
      navigateSettingsRoute({ view: "list", kind: listKindForSurface(surface) });
      return;
    }
    onOpenSurface?.(surface);
  };

  useEffect(() => {
    if (activeSurface !== "settings") {
      setSettingsRoute({ view: "overview" });
      return;
    }
    if (settingsRouteRequest) {
      setSettingsRoute(settingsRouteForRequest(settingsRouteRequest));
    }
  }, [activeSurface, settingsRouteRequest]);

  const inNestedSettings = activeSurface === "settings" && settingsRoute.view !== "overview";
  const inSettingsListDetail = activeSurface === "settings" && hasSettingsListDetail(settingsRoute);
  const crumbs: ConsoleCrumb[] = activeSurface === "settings"
    ? [
        { label: "GSV", onClick: onBackToDesktop, notLast: true },
        {
          label: "SETTINGS",
          onClick: inNestedSettings ? () => navigateSettingsRoute({ view: "overview" }) : undefined,
          notLast: inNestedSettings,
        },
        ...(inSettingsListDetail ? [
          {
            label: settingsListRouteLabel(settingsRoute.kind),
            onClick: () => navigateSettingsRoute({ view: "list", kind: settingsRoute.kind }),
            notLast: true,
          },
          { label: settingsListDetailLabel(settingsRoute) },
        ] : inNestedSettings ? [{ label: settingsRouteLabel(settingsRoute) }] : []),
      ]
    : [
        { label: "GSV", onClick: onBackToDesktop, notLast: true },
        { label: shellSurfaceLabel(activeSurface) },
      ];
  const headerBack = activeSurface === "settings" && settingsRoute.view !== "overview"
    ? () => {
        if (settingsRoute.view === "agent") {
          navigateSettingsRoute({ view: "crew" });
          return;
        }
        if (inSettingsListDetail && settingsRoute.view === "list") {
          navigateSettingsRoute({ view: "list", kind: settingsRoute.kind });
          return;
        }
        navigateSettingsRoute({ view: "overview" });
      }
    : onBackToDesktop;
  const tail = activeSurface === "settings" ? settingsRouteTail(settingsRoute) : surfaceTail(activeSurface);

  return (
    <section class="gsv-console-frame" aria-label={`${shellSurfaceLabel(activeSurface)} surface`}>
      <ConsoleHeader
        crumbs={crumbs}
        tail={tail}
        onBack={headerBack}
      />
      <div class="gsv-console-stage">
        {activeSurface === "settings" ? (
          settingsRoute.view === "overview" ? (
            <ConsoleOverviewPage
              onOpenAgent={openSettingsAgent}
              onOpenListCreate={openSettingsListCreate}
              onOpenListDetail={openSettingsListDetail}
              onOpenSurface={openSettingsSurface}
            />
          ) : settingsRoute.view === "list" ? (
            <ConsoleListPage
              initialCreate={settingsRoute.createNew === true}
              initialDetailId={settingsRoute.detailId}
              initialDetailLabel={settingsRoute.detailLabel}
              kind={settingsRoute.kind}
              onSelectionChange={(selection) => handleSettingsListSelectionChange(settingsRoute.kind, selection)}
            />
          ) : settingsRoute.view === "config" ? (
            <ConsoleConfigPage kind={settingsRoute.kind} />
          ) : settingsRoute.view === "crew" ? (
            <ConsoleCrewPage onManageAgent={openSettingsAgent} onCreateAgent={openSettingsNewAgent} />
          ) : (
            <ConsoleAgentPage
              accountUid={settingsRoute.accountUid}
              createNew={settingsRoute.createNew === true}
              onAgentCreated={openCreatedSettingsAgent}
              onBackToCrew={backToSettingsCrew}
            />
          )
        ) : activeSurface === "runtime" ? (
          <ConsoleListPage kind="tasks" />
        ) : activeSurface === "crew" ? (
          <ConsoleCrewPage onManageAgent={openAgent} />
        ) : activeSurface === "agent" ? (
          <ConsoleAgentPage accountUid={selectedAgentUid} onBackToCrew={backToCrew} />
        ) : activeSurface === "machines" ? (
          <ConsoleListPage kind="machines" />
        ) : activeSurface === "messengers" ? (
          <ConsoleListPage kind="messengers" />
        ) : activeSurface === "integrations" ? (
          <ConsoleListPage kind="integrations" />
        ) : activeSurface === "applications" ? (
          <ConsoleListPage kind="applications" />
        ) : activeSurface === "library" ? (
          <ConsoleListPage kind="library" />
        ) : activeSurface === "files" ? (
          <FilesSurfaceSummary />
        ) : activeSurface === "terminal" ? (
          <TerminalSurfaceSummary />
        ) : (
          null
        )}
      </div>
    </section>
  );
}
