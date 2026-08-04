import {
  LEGACY_STANDALONE_INSTALLATION_ID,
  parseInstallationId,
  type InstallationId,
} from "./identity";

export const RIPGIT_INSTALLATION_HEADER = "x-gsv-installation-id";

/**
 * Bind every ripgit request to one trusted installation. Standalone keeps the
 * historical header-free request path; managed callers cannot retain or
 * override another installation's routing header.
 */
export function createInstallationRipgit(
  binding: Fetcher,
  installationId: InstallationId | string,
): Fetcher {
  const parsed = parseInstallationId(installationId);
  if (parsed === LEGACY_STANDALONE_INSTALLATION_ID) {
    return binding;
  }

  return {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set(RIPGIT_INSTALLATION_HEADER, parsed);
      return binding.fetch(input, { ...init, headers });
    },
  } as Fetcher;
}

export function removeUntrustedRipgitInstallationHeader(headers: Headers): void {
  headers.delete(RIPGIT_INSTALLATION_HEADER);
}
