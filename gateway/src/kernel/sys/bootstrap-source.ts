const ALLOWED_REMOTE_SCHEMES = new Set(["https:", "ssh:"]);

/**
 * Bootstrap remotes are persisted and may appear in operational history, so
 * credentials never travel in-band. Authentication must use a separate
 * secret-backed integration.
 */
export function assertSafeBootstrapSource(value: string): void {
  const source = value.trim();
  if (!source) return;

  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(source)) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new Error("Bootstrap repository URL is invalid");
    }
    if (!ALLOWED_REMOTE_SCHEMES.has(url.protocol)) {
      throw new Error("Bootstrap repository URL must use HTTPS or SSH");
    }
    if (url.username || url.password || url.search || url.hash) {
      throw credentialBearingBootstrapSourceError();
    }
    return;
  }

  const scp = source.match(/^([^@]+)@([^:]+):(.+)$/);
  if (scp) {
    if (
      scp[1] !== "git"
      || !/^[A-Za-z0-9.-]+$/.test(scp[2])
      || !scp[3]
      || /[?#]/.test(scp[3])
    ) {
      throw credentialBearingBootstrapSourceError();
    }
    return;
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source)) {
    return;
  }

  if (/[ @?#]/.test(source)) {
    throw credentialBearingBootstrapSourceError();
  }
  throw new Error("Bootstrap repository URL must use HTTPS or SSH");
}

export function assertSafeBootstrapArgs(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) return;
  const bootstrap = value as Record<string, unknown>;
  for (const field of ["remoteUrl", "repo"] as const) {
    if (typeof bootstrap[field] === "string") {
      assertSafeBootstrapSource(bootstrap[field]);
    }
  }
}

/** Reject credential-bearing repository URLs embedded in guided-setup text. */
export function assertSafeBootstrapText(value: string): void {
  const candidates = [
    ...value.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/g),
    ...value.matchAll(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s<>"'`]+/g),
    ...value.matchAll(/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+[?#][^\s<>"'`]+/g),
  ];
  for (const match of candidates) {
    assertSafeBootstrapSource(trimTrailingProsePunctuation(match[0]));
  }
}

function trimTrailingProsePunctuation(value: string): string {
  return value.replace(/[),.;\]}]+$/g, "");
}

function credentialBearingBootstrapSourceError(): Error {
  const error = new Error(
    "Bootstrap repository URLs must not include credentials, query parameters, or fragments",
  );
  error.name = "CredentialBearingBootstrapSourceError";
  return error;
}
