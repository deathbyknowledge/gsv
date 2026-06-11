import type { FilesRoute } from "../types";

export function routeKey(route: FilesRoute) {
  return JSON.stringify(route);
}

export function sameRoute(left: FilesRoute, right: FilesRoute) {
  return left.target === right.target && left.path === right.path && left.q === right.q && left.open === right.open;
}
