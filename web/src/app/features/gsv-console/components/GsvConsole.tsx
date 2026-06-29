import { useState } from "preact/hooks";
import { ConsoleHeader, type ConsoleCrumb } from "../../../components/ui/ConsoleHeader";
import { useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import { FilesPage } from "../../files/FilesPage";
import { RepositoriesPage } from "../../repositories/RepositoriesPage";
import { TerminalPage } from "../../terminal/TerminalPage";
import {
  shellSurfaceLabel,
  type ShellLibraryRoute,
  type ShellSettingsRoute,
  type ShellSurfaceId,
} from "../../gsv-shell/domain/shellModel";
import type { ConsoleListKind, ConsoleListSelection, PackageListKind } from "../domain/consoleListTypes";
import { IntegrationsPage } from "../integrations/IntegrationsPage";
import { LibraryPage } from "../library/LibraryPage";
import { MachinesPage } from "../machines/MachinesPage";
import { MessengersPage } from "../messengers/MessengersPage";
import { PackageListPage } from "../packages/PackageListPage";
import { ConsoleAgentPage } from "../pages/ConsoleAgentPage";
import { ConsoleConfigPage } from "../pages/ConsoleConfigPage";
import { ConsoleCrewPage } from "../pages/ConsoleCrewPage";
import { ConsoleOverviewPage, type ConsoleOverviewTarget } from "../pages/ConsoleOverviewPage";
import { RuntimePage } from "../runtime/RuntimePage";

type GsvConsoleProps = {
  activeSurface: Exclude<ShellSurfaceId, "desktop" | "app">;
  onBackToDesktop: () => void;
  onClose?: () => void;
  libraryRoute?: ShellLibraryRoute;
  onLibraryRouteChange?: (route: ShellLibraryRoute) => void;
  onOpenApp?: (appId: string, title?: string) => void;
  onOpenSurface?: (surface: Exclude<ShellSurfaceId, "desktop" | "app">) => void;
  onSettingsRouteChange?: (route: SettingsRoute) => void;
  settingsRoute?: SettingsRoute;
};

type SettingsRoute = ShellSettingsRoute;
type SettingsListSurface = "machines" | "messengers" | "integrations" | "applications" | "library" | "runtime";
export type SettingsRouteTarget = "overview" | "crew" | "tasks" | "models" | "overrides";

function isPackageSettingsKind(kind: ConsoleListKind): kind is PackageListKind {
  return kind === "applications";
}

function surfaceTail(surface: ShellSurfaceId): string {
  if (surface === "files") {
    return "GSV · STORAGE";
  }
  if (surface === "repositories") {
    return "GSV · REPOSITORIES";
  }
  if (surface === "library") {
    return "GSV · LIBRARY";
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

function isSettingsListSurface(surface: Exclude<ShellSurfaceId, "desktop" | "app">): surface is SettingsListSurface {
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
    return route.kind === "models" ? "MODELS" : "RUNTIME";
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
    if (route.kind === "library") return "NEW PAGE";
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
    return route.kind === "models" ? "GSV · MODELS" : "GSV · RUNTIME";
  }
  if (route.kind === "tasks") {
    return "GSV · RUNTIME";
  }
  return surfaceTail(route.kind);
}

export function GsvConsole({
  activeSurface,
  libraryRoute = { view: "index" },
  onBackToDesktop,
  onClose,
  onLibraryRouteChange,
  onOpenApp,
  onOpenSurface,
  onSettingsRouteChange,
  settingsRoute = { view: "overview" },
}: GsvConsoleProps) {
  const [selectedAgentUid, setSelectedAgentUid] = useState<number | null>(null);
  const navigateSettingsRoute = (route: SettingsRoute) => {
    onSettingsRouteChange?.(route);
  };
  // In-surface settings navigation (breadcrumbs, the console header back button)
  // changes the settings route without unmounting the whole surface, so the
  // shell-level guard never sees it. Route the user-initiated *leave* controls
  // through the guard so a dirty editor/field group prompts first. Programmatic
  // open* navigations stay raw — they fire from clean list/overview states and
  // from the create-success flow, which must not prompt.
  const requestLeave = useUnsavedGuardLeave();
  const guardedSettingsNavigate = (route: SettingsRoute) => requestLeave(() => navigateSettingsRoute(route));
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
    selection: ConsoleListSelection | null,
  ) => {
    navigateSettingsRoute(selection ? { view: "list", kind, ...selection } : { view: "list", kind });
  };
  const renderListPage = (
    kind: ConsoleListKind,
    options: {
      initialCreate?: boolean;
      initialDetailId?: string | null;
      initialDetailLabel?: string | null;
      onSelectionChange?: (selection: ConsoleListSelection | null) => void;
    } = {},
  ) => {
    if (kind === "tasks") {
      return <RuntimePage {...options} />;
    }
    if (kind === "machines") {
      return <MachinesPage {...options} />;
    }
    if (kind === "messengers") {
      return <MessengersPage {...options} />;
    }
    if (kind === "integrations") {
      return <IntegrationsPage {...options} />;
    }
    if (kind === "library") {
      return (
        <LibraryPage
          route={libraryRoute}
          onRouteChange={onLibraryRouteChange}
        />
      );
    }
    if (isPackageSettingsKind(kind)) {
      return <PackageListPage {...options} kind={kind} onOpenApp={onOpenApp} />;
    }
    return null;
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

  const inNestedSettings = activeSurface === "settings" && settingsRoute.view !== "overview";
  const inSettingsListDetail = activeSurface === "settings" && hasSettingsListDetail(settingsRoute);
  const crumbs: ConsoleCrumb[] = activeSurface === "settings"
    ? [
        { label: "GSV", onClick: onBackToDesktop, notLast: true },
        {
          label: "SETTINGS",
          onClick: inNestedSettings ? () => guardedSettingsNavigate({ view: "overview" }) : undefined,
          notLast: inNestedSettings,
        },
        ...(inSettingsListDetail ? [
          {
            label: settingsListRouteLabel(settingsRoute.kind),
            onClick: () => guardedSettingsNavigate({ view: "list", kind: settingsRoute.kind }),
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
          guardedSettingsNavigate({ view: "crew" });
          return;
        }
        if (inSettingsListDetail && settingsRoute.view === "list") {
          guardedSettingsNavigate({ view: "list", kind: settingsRoute.kind });
          return;
        }
        guardedSettingsNavigate({ view: "overview" });
      }
    : onBackToDesktop;
  const tail = activeSurface === "settings" ? settingsRouteTail(settingsRoute) : surfaceTail(activeSurface);

  return (
    <section class="gsv-console-frame" aria-label={`${shellSurfaceLabel(activeSurface)} surface`}>
      <span class="gsv-console-corner is-top-left" aria-hidden="true" />
      <span class="gsv-console-corner is-top-right" aria-hidden="true" />
      <span class="gsv-console-corner is-bottom-left" aria-hidden="true" />
      <span class="gsv-console-corner is-bottom-right" aria-hidden="true" />
      <ConsoleHeader
        crumbs={crumbs}
        tail={tail}
        onBack={headerBack}
        onClose={onClose}
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
            renderListPage(settingsRoute.kind, {
              initialCreate: settingsRoute.createNew === true,
              initialDetailId: settingsRoute.detailId,
              initialDetailLabel: settingsRoute.detailLabel,
              onSelectionChange: (selection) => handleSettingsListSelectionChange(settingsRoute.kind, selection),
            })
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
          <RuntimePage />
        ) : activeSurface === "crew" ? (
          <ConsoleCrewPage onManageAgent={openAgent} />
        ) : activeSurface === "agent" ? (
          <ConsoleAgentPage accountUid={selectedAgentUid} onBackToCrew={backToCrew} />
        ) : activeSurface === "machines" ? (
          <MachinesPage />
        ) : activeSurface === "messengers" ? (
          <MessengersPage />
        ) : activeSurface === "integrations" ? (
          <IntegrationsPage />
        ) : activeSurface === "applications" ? (
          <PackageListPage kind="applications" onOpenApp={onOpenApp} />
        ) : activeSurface === "library" ? (
          <LibraryPage
            route={libraryRoute}
            onRouteChange={onLibraryRouteChange}
          />
        ) : activeSurface === "files" ? (
          <FilesPage />
        ) : activeSurface === "repositories" ? (
          <RepositoriesPage />
        ) : activeSurface === "terminal" ? (
          <TerminalPage />
        ) : (
          null
        )}
      </div>
    </section>
  );
}
