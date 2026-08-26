import {
  SINGLETON_INSTALLATION_ID,
  parseInstallationId,
} from "./identity";
import type { Fetcher } from "@cloudflare/workers-types";

export const RIPGIT_INSTALLATION_HEADER = "x-gsv-installation-id";
export function createInstallationRipgit<T extends Fetcher>(
  binding: T,
  installationId: string,
): T {
  const parsed = parseInstallationId(installationId);
  if (parsed === SINGLETON_INSTALLATION_ID) {
    return binding;
  }

  const fetch: Fetcher["fetch"] = (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(RIPGIT_INSTALLATION_HEADER, parsed);
    return binding.fetch(input, { ...init, headers });
  };

  return new Proxy(binding, {
    get(target, property) {
      if (property === "fetch") return fetch;
      // SAFETY: Proxy property keys are keys of the wrapped Fetcher binding.
      const value = target[property as keyof T];
      return value instanceof Function ? value.bind(target) : value;
    },
  });
}

export function removeUntrustedRipgitInstallationHeader(headers: Headers): void {
  headers.delete(RIPGIT_INSTALLATION_HEADER);
}
