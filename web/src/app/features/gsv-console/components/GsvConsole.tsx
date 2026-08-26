import { useEffect, useState } from "preact/hooks";
import { ConsoleHeader, type ConsoleCrumb } from "../../../components/ui/ConsoleHeader";
import { useUnsavedGuardLeave } from "../../gsv-shell/unsaved/unsavedGuard";
import { FilesPage } from "../../files/FilesPage";
import { RepositoriesPage } from "../../repositories/RepositoriesPage";
import { TerminalPage } from "../../terminal/TerminalPage";
import {
  shellSurfaceLabel,
  type DesktopObjectId,
  type ShellFilesRoute,
  type ShellLibraryRoute,
  type ShellSettingsRoute,
  type ShellSurfaceId,
} from "../../gsv-shell/domain/shellModel";
import type { ConsoleListKind, ConsoleListSelection } from "../domain/consoleListTypes";
import { IntegrationsPage } from "../integrations/IntegrationsPage";
import { LibraryPage } from "../library/LibraryPage";
import { MachinesPage } from "../machines/MachinesPage";
import { MessengersPage } from "../messengers/MessengersPage";
import { ConsoleAgentPage } from "../pages/ConsoleAgentPage";
import { ConsoleConfigPage, type ConsoleConfigDetail } from "../pages/ConsoleConfigPage";
import { Dialog } from "../../../components/ui/Dialog";
import { ConsoleCrewPage } from "../pages/ConsoleCrewPage";
import { ConsoleOverviewPage, type ConsoleOverviewTarget } from "../pages/ConsoleOverviewPage";
import { RuntimePage } from "../runtime/RuntimePage";
import { ResponsibilitiesPage } from "../responsibilities/ResponsibilitiesPage";
import { ContactsPage } from "../contacts/ContactsPage";
import { ListTemplateMockPage } from "../list-template/ListTemplateMockPage";
import { CardListTemplateMockPage } from "../card-template/CardListTemplateMockPage";
import { ConnectFlowsMockPage } from "../connect-flows/ConnectFlowsMockPage";

type GsvConsoleProps = {
  activeSurface: Exclude<ShellSurfaceId, "desktop">;
  onBackToDesktop: () => void;
  onClose?: () => void;
  libraryRoute?: ShellLibraryRoute;
  onLibraryRouteChange?: (route: ShellLibraryRoute) => void;
  filesRoute?: ShellFilesRoute;
  onOpenSurface?: (surface: Exclude<ShellSurfaceId, "desktop">) => void;
  onOpenSectionCreate?: (kind: DesktopObjectId) => void;
  onOpenChat?: () => void;
  /** Start a fresh task (Tasks list NEW TASK) — opens the dock AND spawns a new
   *  process, unlike onOpenChat which only reveals the dock. */
  onNewTask?: () => void;
  onSettingsRouteChange?: (route: SettingsRoute) => void;
  settingsRoute?: SettingsRoute;
};

type SettingsRoute = ShellSettingsRoute;
type SettingsListSurface = "machines" | "messengers" | "integrations" | "library" | "runtime";
export type SettingsRouteTarget = "overview" | "crew" | "tasks" | "models" | "overrides";

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
    return "GSV · WORK";
  }
  if (surface === "responsibilities") {
    return "GSV · RESPONSIBILITIES";
  }
  if (surface === "contacts") {
    return "GSV · CONTACTS";
  }
  if (surface === "messengers") {
    return "GSV · MESSENGERS";
  }
  if (surface === "machines") {
    return "GSV · MACHINES";
  }
  if (surface === "integrations") {
    return "GSV · INTEGRATIONS";
  }
  if (surface === "crew" || surface === "agent") {
    return "GSV · CREW";
  }
  if (surface === "list-template" || surface === "card-template") {
    return "GSV · TEMPLATE";
  }
  if (surface === "connect-flows") {
    return "GSV · CONNECT";
  }
  return "GSV · CONTROL";
}

function isSettingsListSurface(surface: Exclude<ShellSurfaceId, "desktop">): surface is SettingsListSurface {
  return surface === "machines"
    || surface === "messengers"
    || surface === "integrations"
    || surface === "library"
    || surface === "runtime";
}

function listKindForSurface(surface: SettingsListSurface): ConsoleListKind {
  return surface === "runtime" ? "tasks" : surface;
}

function settingsRouteLabel(route: SettingsRoute): string {
  if (route.view === "overview") {
    return "OVERVIEW";
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
  }
  if (route.detailLabel) {
    return route.detailLabel;
  }
  return route.kind === "tasks" ? "WORK" : shellSurfaceLabel(route.kind);
}

function settingsListRouteLabel(kind: ConsoleListKind): string {
  return kind === "tasks" ? "WORK" : shellSurfaceLabel(kind);
}

function settingsListDetailLabel(route: Extract<SettingsRoute, { view: "list" }>): string {
  if (route.createNew) {
    if (route.kind === "machines") return "NEW MACHINE";
    if (route.kind === "integrations") return "NEW INTEGRATION";
    if (route.kind === "messengers") return "NEW MESSENGER";
    if (route.kind === "library") return "NEW PAGE";
    return "NEW WORK";
  }
  return route.detailLabel ?? route.detailId ?? settingsListRouteLabel(route.kind);
}

function hasSettingsListDetail(route: SettingsRoute): route is Extract<SettingsRoute, { view: "list" }> {
  return route.view === "list" && (Boolean(route.detailId) || route.createNew === true);
}

/** The breadcrumb label for a non-index library view, or null on the index.
 *  Library runs its own internal route, so the shell maps it to a detail crumb
 *  (GSV → LIBRARY → [page/view]) the same way other surfaces show their detail. */
function libraryDetailLabel(route: ShellLibraryRoute): string | null {
  if (route.view === "reader") return libraryPageName(route.path);
  if (route.view === "editor") return route.path ? libraryPageName(route.path) : "NEW PAGE";
  if (route.view === "capture") return "NEW PAGE";
  if (route.view === "build") return "BUILD";
  return null;
}

function libraryPageName(path: string): string {
  const base = path.split("/").pop() || path;
  return base.replace(/\.[^.]+$/, "").toUpperCase();
}

function settingsRouteTail(route: SettingsRoute): string {
  if (route.view === "overview") {
    return "";
  }
  if (route.view === "crew" || route.view === "agent") {
    return "GSV · CREW";
  }
  if (route.view === "config") {
    return route.kind === "models" ? "GSV · MODELS" : "GSV · RUNTIME";
  }
  if (route.kind === "tasks") {
    return "GSV · WORK";
  }
  return surfaceTail(route.kind);
}

export function GsvConsole({
  activeSurface,
  libraryRoute = { view: "index" },
  filesRoute,
  onBackToDesktop,
  onClose,
  onLibraryRouteChange,
  onOpenSurface,
  onOpenSectionCreate,
  onOpenChat,
  onNewTask,
  onSettingsRouteChange,
  settingsRoute = { view: "overview" },
}: GsvConsoleProps) {
  const [selectedAgentUid, setSelectedAgentUid] = useState<number | null>(null);
  const [agentCreateNew, setAgentCreateNew] = useState(false);
  // Track the open detail of the active top-level list surface (machines /
  // messengers / integrations / runtime). Settings surfaces drive
  // their own breadcrumb via the settings route; these don't, so without this a
  // detail opened from a top-level surface leaves no breadcrumb path back to the
  // list and the header back jumps all the way to the desktop.
  const [surfaceDetail, setSurfaceDetail] = useState<ConsoleListSelection | null>(null);
  const [surfaceDetailSeq, setSurfaceDetailSeq] = useState(0);
  // The open model/runtime config detail (reported by ConsoleConfigPage), so the
  // breadcrumb shows SETTINGS → MODELS → [detail] and the header back-arrow exits
  // the detail — replacing the in-page back button.
  const [settingsConfigDetail, setSettingsConfigDetail] = useState<ConsoleConfigDetail | null>(null);
  useEffect(() => {
    setSurfaceDetail(null);
  }, [activeSurface]);
  const clearSurfaceDetail = () => {
    // Route through the unsaved guard so a dirty create/detail flow (e.g.
    // CONNECT NEW MACHINE, messenger onboarding) prompts before its draft is
    // discarded — same as settings detail navigation.
    requestLeave(() => {
      setSurfaceDetail(null);
      // The surface owns its selection internally (uncontrolled), so remount it
      // via a key bump to drop back to the list.
      setSurfaceDetailSeq((seq) => seq + 1);
    });
  };
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
    setAgentCreateNew(false);
    onOpenSurface?.("agent");
  };
  const openNewAgent = () => {
    setSelectedAgentUid(null);
    setAgentCreateNew(true);
    onOpenSurface?.("agent");
  };
  const onTopLevelAgentCreated = (uid: number) => {
    setSelectedAgentUid(uid);
    setAgentCreateNew(false);
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
      return <RuntimePage {...options} onNewTask={onNewTask} />;
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
    return null;
  };
  const openSettingsSurface = (surface: ConsoleOverviewTarget) => {
    if (surface === "settings") {
      navigateSettingsRoute({ view: "overview" });
      return;
    }
    if (surface === "model-default") {
      navigateSettingsRoute({ view: "config", kind: "models", select: "default" });
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
    if (surface === "crew-instructions") {
      navigateSettingsRoute({ view: "crew", select: "context" });
      return;
    }
    if (surface === "crew-permissions") {
      navigateSettingsRoute({ view: "crew", select: "permissions" });
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

  // The config surface (models / overrides) renders as a Dialog floating over
  // the overview, so for the shell breadcrumb it is NOT a nested page — the
  // trail stays at GSV → OVERVIEW and the dialog supplies its own title/back.
  const inNestedSettings = activeSurface === "settings"
    && settingsRoute.view !== "overview"
    && settingsRoute.view !== "config";
  const inSettingsListDetail = activeSurface === "settings" && hasSettingsListDetail(settingsRoute);
  // Library drives its own internal route; surface its non-index views as a
  // detail crumb so the breadcrumb (and header back-arrow) own the path back to
  // the index, instead of leaving the trail stuck at LIBRARY.
  const libraryDetail = libraryDetailLabel(libraryRoute);
  const _inLibrary = activeSurface === "library"
    || (activeSurface === "settings" && settingsRoute.view === "list" && settingsRoute.kind === "library");
  // Route through the unsaved guard: leaving a dirty page editor / capture /
  // build form via the LIBRARY crumb or header back-arrow must prompt first,
  // the same as Library's own in-page BACK controls (which go through
  // useLibraryWorkspace's guarded navigate).
  const goLibraryIndex = () => requestLeave(() => onLibraryRouteChange?.(
    libraryRoute.db ? { view: "index", db: libraryRoute.db } : { view: "index" },
  ));
  const crumbs: ConsoleCrumb[] = activeSurface === "settings"
    ? [
        { label: "GSV", onClick: onBackToDesktop, notLast: true },
        {
          label: "OVERVIEW",
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
        ] : settingsRoute.view === "agent" ? [
          // The agent editor is reached via Crew; keep CREW in the trail now that
          // the editor no longer renders its own breadcrumb.
          { label: "CREW", onClick: () => guardedSettingsNavigate({ view: "crew" }), notLast: true },
          { label: settingsRouteLabel(settingsRoute) },
        ] : settingsRoute.view === "list" && settingsRoute.kind === "library" && libraryDetail ? [
          // Library sub-view inside settings: LIBRARY (→ index) → [page/view].
          { label: shellSurfaceLabel("library"), onClick: goLibraryIndex, notLast: true },
          { label: libraryDetail },
        ] : inNestedSettings ? [{ label: settingsRouteLabel(settingsRoute) }] : []),
      ]
    : activeSurface === "agent"
    ? [
        // The top-level agent editor is reached from Crew; keep CREW in the trail
        // as the way back (the editor no longer renders its own breadcrumb).
        { label: "GSV", onClick: onBackToDesktop, notLast: true },
        { label: "CREW", onClick: backToCrew, notLast: true },
        { label: shellSurfaceLabel(activeSurface) },
      ]
    : activeSurface === "library" && libraryDetail
    ? [
        // Top-level Library: GSV → LIBRARY (→ index) → [page/view].
        { label: "GSV", onClick: onBackToDesktop, notLast: true },
        { label: shellSurfaceLabel(activeSurface), onClick: goLibraryIndex, notLast: true },
        { label: libraryDetail },
      ]
    : surfaceDetail
    ? [
        { label: "GSV", onClick: onBackToDesktop, notLast: true },
        { label: shellSurfaceLabel(activeSurface), onClick: clearSurfaceDetail, notLast: true },
        { label: surfaceDetail.createNew ? "NEW" : surfaceDetail.detailLabel || "DETAIL" },
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
        if (settingsRoute.view === "config" && settingsConfigDetail) {
          settingsConfigDetail.onExit();
          return;
        }
        if (settingsRoute.view === "list" && settingsRoute.kind === "library" && libraryDetail) {
          goLibraryIndex();
          return;
        }
        guardedSettingsNavigate({ view: "overview" });
      }
    : activeSurface === "library" && libraryDetail
    ? goLibraryIndex
    : activeSurface === "agent"
    ? backToCrew
    : surfaceDetail
    ? clearSurfaceDetail
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
          // The config surface renders as a Dialog over the overview (below), so
          // the overview is the base for both views.
          settingsRoute.view === "overview" || settingsRoute.view === "config" ? (
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
          ) : settingsRoute.view === "crew" ? (
            <ConsoleCrewPage
              select={settingsRoute.select}
              onExitSection={settingsRoute.select ? backToSettingsCrew : undefined}
              onManageAgent={openSettingsAgent}
              // Route through the unsaved guard: NEW AGENT unmounts the in-body
              // defaults editor, so a dirty draft must prompt before it's dropped.
              onCreateAgent={() => guardedSettingsNavigate({ view: "agent", accountUid: null, createNew: true })}
            />
          ) : (
            <ConsoleAgentPage
              accountUid={settingsRoute.accountUid}
              createNew={settingsRoute.createNew === true}
              onAgentCreated={openCreatedSettingsAgent}
              onBackToCrew={backToSettingsCrew}
            />
          )
        ) : activeSurface === "runtime" ? (
          <RuntimePage key={surfaceDetailSeq} onNewTask={onNewTask} onSelectionChange={setSurfaceDetail} />
        ) : activeSurface === "responsibilities" ? (
          <ResponsibilitiesPage />
        ) : activeSurface === "contacts" ? (
          <ContactsPage />
        ) : activeSurface === "crew" ? (
          <ConsoleCrewPage onManageAgent={openAgent} onCreateAgent={openNewAgent} />
        ) : activeSurface === "agent" ? (
          <ConsoleAgentPage
            accountUid={selectedAgentUid}
            createNew={agentCreateNew}
            onAgentCreated={onTopLevelAgentCreated}
            onBackToCrew={backToCrew}
          />
        ) : activeSurface === "machines" ? (
          <MachinesPage key={surfaceDetailSeq} onSelectionChange={setSurfaceDetail} />
        ) : activeSurface === "messengers" ? (
          <MessengersPage key={surfaceDetailSeq} onSelectionChange={setSurfaceDetail} />
        ) : activeSurface === "integrations" ? (
          <IntegrationsPage key={surfaceDetailSeq} onSelectionChange={setSurfaceDetail} />
        ) : activeSurface === "library" ? (
          <LibraryPage
            route={libraryRoute}
            onRouteChange={onLibraryRouteChange}
          />
        ) : activeSurface === "files" ? (
          <FilesPage filesRoute={filesRoute} />
        ) : activeSurface === "repositories" ? (
          <RepositoriesPage />
        ) : activeSurface === "terminal" ? (
          <TerminalPage />
        ) : activeSurface === "list-template" ? (
          <ListTemplateMockPage
            onOpenSectionCreate={onOpenSectionCreate}
            onOpenChat={onOpenChat}
          />
        ) : activeSurface === "card-template" ? (
          <CardListTemplateMockPage onOpenChat={onOpenChat} />
        ) : activeSurface === "connect-flows" ? (
          <ConnectFlowsMockPage onOpenChat={onOpenChat} />
        ) : (
          null
        )}
        {activeSurface === "settings" && settingsRoute.view === "config" ? (
          // Models / overrides host the full config flow (list + create/edit
          // details) inside one Dialog, floating over the overview. Every entry
          // point routes here (view: "config"), so they all open this dialog.
          // The dialog title/back derive from the config page's reported detail:
          // no detail → the list (close only); a detail → its label + a back to
          // the list. Backdrop click / ✕ / Escape all return to the overview.
          <div
            class="gsv-dialog-scrim"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                guardedSettingsNavigate({ view: "overview" });
              }
            }}
          >
            <Dialog
              title={settingsConfigDetail
                ? settingsConfigDetail.label
                : settingsRoute.kind === "models" ? "MODELS" : "RUNTIME"}
              width={880}
              fill
              flushBody
              onBack={settingsConfigDetail ? settingsConfigDetail.onExit : undefined}
              onClose={() => guardedSettingsNavigate({ view: "overview" })}
            >
              <ConsoleConfigPage
                kind={settingsRoute.kind}
                select={settingsRoute.select}
                embedded
                onClearSelect={() => navigateSettingsRoute({ view: "config", kind: settingsRoute.kind })}
                onDetailChange={setSettingsConfigDetail}
              />
            </Dialog>
          </div>
        ) : null}
      </div>
    </section>
  );
}
