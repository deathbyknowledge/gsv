import type { ComponentChildren } from "preact";
import type { PendingAction, SocialRoute, SocialSection, SocialState } from "../../types";
import { GlobalNavigation } from "../navigation/GlobalNavigation";
import { IconButton } from "../ui/primitives";

const SECTION_LABELS: Record<SocialSection, string> = {
  inbox: "Inbox",
  channels: "Channels",
  contacts: "Contacts",
  directory: "Directory",
  advanced: "Advanced",
};

export function AppShell(props: {
  state: SocialState | null;
  route: SocialRoute;
  pendingAction: PendingAction | null;
  error: string | null;
  children: ComponentChildren;
  onBack: () => void;
  onClearError: () => void;
  onSelectSection: (section: SocialSection) => void;
}) {
  return (
    <div class="social-app">
      <MobileTopBar
        route={props.route}
        title={SECTION_LABELS[props.route.section]}
        onBack={props.onBack}
      />
      <GlobalNavigation
        state={props.state}
        route={props.route}
        pending={props.pendingAction === "load"}
        onSelectSection={props.onSelectSection}
      />
      <main class="social-main-frame">
        {props.error ? (
          <div class="social-error-banner" role="alert">
            <span>{props.error}</span>
            <IconButton label="Dismiss error" glyph="x" onClick={props.onClearError} />
          </div>
        ) : null}
        {props.children}
      </main>
    </div>
  );
}

function MobileTopBar(props: {
  route: SocialRoute;
  title: string;
  onBack: () => void;
}) {
  return (
    <header class="social-mobile-topbar">
      {props.route.detail ? (
        <IconButton label="Back" glyph="<" onClick={props.onBack} />
      ) : (
        <span class="social-mobile-spacer" />
      )}
      <strong>{props.title}</strong>
      <span class="social-mobile-spacer" />
    </header>
  );
}
