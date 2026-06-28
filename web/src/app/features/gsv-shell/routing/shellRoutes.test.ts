import { describe, expect, it } from "vitest";
import type { ShellRoute } from "../domain/shellModel";
import {
  shellRouteFromLocation,
  shellRouteToPath,
} from "./shellRoutes";

function location(pathname: string, search = "", hash = ""): Pick<Location, "hash" | "pathname" | "search"> {
  return { pathname, search, hash };
}

describe("shellRoutes", () => {
  it("leaves worker-owned paths to the worker", () => {
    expect(shellRouteFromLocation(location("/runtime/processes"))).toEqual({ surface: "desktop" });
    expect(shellRouteFromLocation(location("/apps/chat"))).toEqual({ surface: "desktop" });
    expect(shellRouteFromLocation(location("/git/root/gsv"))).toEqual({ surface: "desktop" });
  });

  it("uses /tasks for the native runtime page", () => {
    const route: ShellRoute = { surface: "runtime" };

    expect(shellRouteToPath(route)).toBe("/tasks");
    expect(shellRouteFromLocation(location("/tasks"))).toEqual(route);
  });

  it("uses /repositories for the native repository page", () => {
    const route: ShellRoute = { surface: "repositories" };

    expect(shellRouteToPath(route)).toBe("/repositories");
    expect(shellRouteFromLocation(location("/repositories"))).toEqual(route);
    expect(shellRouteFromLocation(location("/repos"))).toEqual(route);
  });

  it("round-trips settings list detail routes", () => {
    const route: ShellRoute = {
      surface: "settings",
      settingsRoute: {
        view: "list",
        kind: "machines",
        detailId: "hank-linux",
      },
    };

    expect(shellRouteToPath(route)).toBe("/settings/machines/hank-linux");
    expect(shellRouteFromLocation(location("/settings/machines/hank-linux"))).toEqual(route);
  });

  it("round-trips native app routes under /open", () => {
    const route: ShellRoute = {
      surface: "app",
      appRoute: {
        appId: "Space Simulation",
        suffix: "/planets/mars",
        search: "?mode=edit",
        hash: "#orbit",
      },
    };

    expect(shellRouteToPath(route)).toBe("/open/Space%20Simulation/planets/mars?mode=edit#orbit");
    expect(shellRouteFromLocation(location("/open/Space%20Simulation/planets/mars", "?mode=edit", "#orbit"))).toEqual(route);
  });

  it("round-trips library collection and page routes", () => {
    expect(shellRouteFromLocation(location("/library"))).toEqual({
      surface: "library",
      libraryRoute: { view: "index" },
    });
    expect(shellRouteFromLocation(location("/library/memory"))).toEqual({
      surface: "library",
      libraryRoute: { view: "index", db: "memory" },
    });

    const route: ShellRoute = {
      surface: "library",
      libraryRoute: {
        view: "reader",
        db: "memory",
        path: "pages/auth-notes.md",
      },
    };

    expect(shellRouteToPath(route)).toBe("/library/memory/pages/auth-notes.md");
    expect(shellRouteFromLocation(location("/library/memory/pages/auth-notes.md"))).toEqual(route);
  });

  it("round-trips library authoring routes", () => {
    expect(shellRouteFromLocation(location("/library/memory/new"))).toEqual({
      surface: "library",
      libraryRoute: { view: "editor", db: "memory" },
    });
    expect(shellRouteToPath({
      surface: "library",
      libraryRoute: { view: "editor", db: "memory", path: "pages/auth-notes.md" },
    })).toBe("/library/memory/edit/pages/auth-notes.md");
    expect(shellRouteFromLocation(location("/library/memory/capture"))).toEqual({
      surface: "library",
      libraryRoute: { view: "capture", db: "memory" },
    });
    expect(shellRouteFromLocation(location("/library/build"))).toEqual({
      surface: "library",
      libraryRoute: { view: "build" },
    });
  });
});
