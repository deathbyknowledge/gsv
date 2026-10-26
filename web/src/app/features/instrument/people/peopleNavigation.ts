import { useRef } from "preact/hooks";
import { navigateApp, useAppLocation } from "../../../services/navigation/appNavigation";

export type PeopleRoute = {
  view: "inbox" | "requests" | "contacts" | "profile";
  contactId: string | null;
  requestId: string | null;
  direction: "incoming" | "outgoing";
  history: boolean;
  archived: boolean;
  /** The profile view opens as the public page; edit mode shows the form. */
  edit: boolean;
  /** Edit mode opened from "complete bio" starts in the bio field. */
  focusBio: boolean;
};

export function readPeopleRoute(search: string): PeopleRoute {
  const params = new URLSearchParams(search);
  const requested = params.get("view");
  const view = requested === "requests" || requested === "contacts" || requested === "profile" ? requested : "inbox";
  return {
    view,
    contactId: view === "inbox" ? params.get("contact") : null,
    requestId: view === "requests" ? params.get("request") : null,
    direction: params.get("direction") === "outgoing" ? "outgoing" : "incoming",
    history: params.get("history") === "1",
    archived: params.get("archived") === "1",
    edit: view === "profile" && params.get("edit") === "1",
    focusBio: view === "profile" && params.get("edit") === "1" && params.get("focus") === "bio",
  };
}

export function peoplePath(route: Partial<PeopleRoute>): string {
  const params = new URLSearchParams();
  const view = route.view ?? "inbox";
  if (view !== "inbox") params.set("view", view);
  if (view === "inbox") {
    if (route.contactId) params.set("contact", route.contactId);
    if (route.archived) params.set("archived", "1");
  }
  if (view === "requests") {
    if (route.requestId) params.set("request", route.requestId);
    if (route.direction === "outgoing") params.set("direction", "outgoing");
    if (route.history) params.set("history", "1");
  }
  if (view === "profile" && route.edit) {
    params.set("edit", "1");
    if (route.focusBio) params.set("focus", "bio");
  }
  return `/people${params.size ? `?${params}` : ""}`;
}

/** Retained People views keep their selection while another app view is active. */
export function usePeopleRoute() {
  const location = useAppLocation();
  const retained = useRef(readPeopleRoute(window.location.search));
  if (location.pathname === "/people") retained.current = readPeopleRoute(window.location.search);
  const open = (change: Partial<PeopleRoute>) => {
    // A completed background send must not pull the reader away from another view.
    if (window.location.pathname !== "/people") return;
    navigateApp(peoplePath({ ...retained.current, ...change }));
  };
  return [retained.current, open] as const;
}
