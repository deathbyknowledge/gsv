import { useCallback, useEffect, useState } from "preact/hooks";
import type { SocialMessageWorkflowItem, SocialRoute, SocialSection } from "../types";

export type SocialNavigation = {
  route: SocialRoute;
  selectSection: (section: SocialSection) => void;
  selectChannel: (channelId: string, section?: SocialSection) => void;
  selectWorkflow: (workflow: SocialMessageWorkflowItem) => void;
  selectContact: (handle: string, section?: SocialSection) => void;
  showList: () => void;
};

export function useSocialNavigation(): SocialNavigation {
  const [route, setRoute] = useState<SocialRoute>(() => readRouteFromLocation());

  const commitRoute = useCallback((nextRoute: SocialRoute) => {
    const url = new URL(window.location.href);
    url.searchParams.delete("view");
    url.searchParams.set("section", nextRoute.section);
    setOptionalParam(url, "channel", nextRoute.channelId);
    setOptionalParam(url, "contact", nextRoute.contactHandle);
    setOptionalParam(url, "workflow", nextRoute.workflowMessageId);
    url.searchParams.delete("thread");
    url.searchParams.delete("status");
    if (nextRoute.detail) {
      url.searchParams.set("detail", "1");
    } else {
      url.searchParams.delete("detail");
    }
    window.history.pushState({}, "", url);
    setRoute(nextRoute);
  }, []);

  useEffect(() => {
    const onPopState = () => setRoute(readRouteFromLocation());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectSection = useCallback((section: SocialSection) => {
    commitRoute({
      ...route,
      section,
      detail: false,
      workflowMessageId: null,
    });
  }, [commitRoute, route]);

  const selectChannel = useCallback((channelId: string, section: SocialSection = "channels") => {
    commitRoute({
      ...route,
      section,
      channelId,
      workflowMessageId: null,
      detail: true,
    });
  }, [commitRoute, route]);

  const selectWorkflow = useCallback((workflow: SocialMessageWorkflowItem) => {
    commitRoute({
      ...route,
      section: "inbox",
      channelId: workflow.channelId,
      workflowMessageId: workflow.messageId,
      detail: true,
    });
  }, [commitRoute, route]);

  const selectContact = useCallback((handle: string, section: SocialSection = "contacts") => {
    commitRoute({
      ...route,
      section,
      contactHandle: handle,
      workflowMessageId: null,
      detail: true,
    });
  }, [commitRoute, route]);

  const showList = useCallback(() => {
    commitRoute({
      ...route,
      detail: false,
      workflowMessageId: null,
    });
  }, [commitRoute, route]);

  return {
    route,
    selectSection,
    selectChannel,
    selectWorkflow,
    selectContact,
    showList,
  };
}

function readRouteFromLocation(): SocialRoute {
  const url = new URL(window.location.href);
  return {
    section: readSection(url),
    channelId: url.searchParams.get("channel")?.trim() || url.searchParams.get("thread")?.trim() || null,
    contactHandle: url.searchParams.get("contact")?.trim() || null,
    workflowMessageId: url.searchParams.get("workflow")?.trim() || url.searchParams.get("status")?.trim() || null,
    detail: url.searchParams.get("detail") === "1",
  };
}

function readSection(url: URL): SocialSection {
  const section = url.searchParams.get("section") ?? url.searchParams.get("view");
  if (
    section === "inbox" ||
    section === "channels" ||
    section === "contacts" ||
    section === "directory" ||
    section === "advanced"
  ) {
    return section;
  }
  if (section === "attention") {
    return "inbox";
  }
  if (section === "threads") {
    return "channels";
  }
  if (section === "conversations") {
    return "channels";
  }
  if (section === "people") {
    return "contacts";
  }
  if (section === "identity" || section === "published") {
    return "directory";
  }
  return "inbox";
}

function setOptionalParam(url: URL, name: string, value: string | null): void {
  if (value) {
    url.searchParams.set(name, value);
  } else {
    url.searchParams.delete(name);
  }
}
