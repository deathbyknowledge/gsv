import { useLayoutEffect } from "preact/hooks";
import { APP_NAVIGATION, BEFORE_APP_NAVIGATION, appHistoryIndex } from "../../../services/navigation/appNavigation";
import { useT } from "../../../i18n/locale";

function isPreferences(url: URL): boolean {
  return url.pathname === "/chat/settings" && (!url.searchParams.has("section") || url.searchParams.get("section") === "preferences");
}

/** Retained drafts survive leaving; cancellation also restores the browser's history position. */
export function usePreferencesLeavePrompt(enabled: boolean) {
  const t = useT();
  useLayoutEffect(() => {
    if (!enabled) return;
    let index = appHistoryIndex();
    let restoring = false;
    const confirm = (url: URL) => isPreferences(url) || window.confirm(t("settings.preferences.leaveUnsaved"));
    const beforeNavigate = (event: Event) => {
      if (event instanceof CustomEvent && event.detail instanceof URL && !confirm(event.detail)) event.preventDefault();
    };
    const navigated = () => { index = appHistoryIndex(); };
    const popstate = (event: Event) => {
      if (restoring) { restoring = false; event.stopImmediatePropagation(); return; }
      if (confirm(new URL(window.location.href))) { navigated(); return; }
      const nextIndex = appHistoryIndex();
      event.stopImmediatePropagation();
      restoring = true;
      window.history.go(index !== null && nextIndex !== null ? index - nextIndex : 1);
    };
    window.addEventListener(BEFORE_APP_NAVIGATION, beforeNavigate);
    window.addEventListener(APP_NAVIGATION, navigated);
    window.addEventListener("popstate", popstate, true);
    return () => {
      window.removeEventListener(BEFORE_APP_NAVIGATION, beforeNavigate);
      window.removeEventListener(APP_NAVIGATION, navigated);
      window.removeEventListener("popstate", popstate, true);
    };
  }, [enabled, t]);
}
