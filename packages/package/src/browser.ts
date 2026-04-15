export type PackageAppBoot = {
  packageId: string;
  packageName: string;
  routeBase: string;
  rpcBase: string;
  sessionId: string;
  sessionSecret: string;
  clientId: string;
  expiresAt: number;
  hasBackend: boolean;
};

type CapnwebGlobal = {
  newWebSocketRpcSession<T = unknown>(url: string, localMain?: unknown): T;
  RpcTarget?: new (...args: unknown[]) => unknown;
};

declare global {
  interface Window {
    __GSV_APP_BOOT__?: PackageAppBoot;
    __GSV_BACKEND_READY__?: Promise<unknown>;
    backend?: unknown;
    capnweb?: CapnwebGlobal;
  }
}

export function getAppBoot(): PackageAppBoot {
  const boot = globalThis.window?.__GSV_APP_BOOT__;
  if (!boot) {
    throw new Error("GSV app bootstrap is unavailable");
  }
  return boot;
}

export function hasAppBoot(): boolean {
  return Boolean(globalThis.window?.__GSV_APP_BOOT__);
}

function getCapnweb(): CapnwebGlobal {
  const capnweb = globalThis.window?.capnweb;
  if (!capnweb || typeof capnweb.newWebSocketRpcSession !== "function") {
    throw new Error("capnweb runtime is unavailable");
  }
  return capnweb;
}

function buildRpcWebSocketUrl(rpcBase: string): string {
  const url = new URL(rpcBase, globalThis.window?.location?.href ?? "http://localhost");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function connectAppBackend<T = unknown>(): Promise<T> {
  const existing = globalThis.window?.__GSV_BACKEND_READY__;
  if (existing) {
    return existing as Promise<T>;
  }
  const boot = getAppBoot();
  if (!boot.hasBackend) {
    throw new Error("package app has no backend rpc");
  }
  const capnweb = getCapnweb();
  const ready = (async () => {
    const session = capnweb.newWebSocketRpcSession<{
      authenticate(secret: string): T;
    }>(buildRpcWebSocketUrl(boot.rpcBase));
    const backend = await session.authenticate(boot.sessionSecret);
    if (globalThis.window) {
      globalThis.window.backend = backend;
    }
    return backend;
  })();
  if (globalThis.window) {
    globalThis.window.__GSV_BACKEND_READY__ = ready;
  }
  return ready;
}

export async function getBackend<T = unknown>(): Promise<T> {
  return connectAppBackend<T>();
}
