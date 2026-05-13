type DevEnv = {
  GSV_DEV?: string;
  GSV_DEV_SOCIAL_ORIGINS?: string;
};

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const LOCAL_DEV_HANDLE_PATTERN = /^gsv-(\d{1,5})\.gsv\.local$/;

export type RuntimeConfig = {
  dev: boolean;
};

export function runtimeConfig(env: Env): RuntimeConfig {
  return {
    dev: isGsvDevMode(env),
  };
}

export function isGsvDevMode(env: Env): boolean {
  const value = (env as unknown as DevEnv).GSV_DEV?.trim().toLowerCase();
  return value !== undefined && TRUE_VALUES.has(value);
}

export function socialOriginForHandle(env: Env, handle: string): string {
  return devSocialOriginForHandle(env, handle) ?? `https://${handle}`;
}

export function devSocialOriginForHandle(env: Env, handle: string): string | null {
  if (!isGsvDevMode(env)) {
    return null;
  }
  const normalizedHandle = handle.trim().toLowerCase();
  for (const entry of configuredSocialOriginEntries(env)) {
    if (entry.handle === normalizedHandle) {
      return entry.origin;
    }
  }
  const match = LOCAL_DEV_HANDLE_PATTERN.exec(normalizedHandle);
  if (!match) {
    return null;
  }
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return `http://localhost:${port}`;
}

export function devHandleForOrigin(env: Env, origin: string): string | null {
  if (!isGsvDevMode(env)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const normalizedOrigin = url.origin;
  for (const entry of configuredSocialOriginEntries(env)) {
    if (entry.origin === normalizedOrigin) {
      return entry.handle;
    }
  }
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    /^\d+$/.test(url.port)
  ) {
    return `gsv-${url.port}.gsv.local`;
  }
  return null;
}

function configuredSocialOriginEntries(env: Env): Array<{ handle: string; origin: string }> {
  const value = (env as unknown as DevEnv).GSV_DEV_SOCIAL_ORIGINS;
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => {
      const [rawHandle, rawOrigin] = entry.split("=", 2);
      const handle = rawHandle?.trim().toLowerCase();
      const origin = normalizeOrigin(rawOrigin);
      return handle && origin ? { handle, origin } : null;
    })
    .filter((entry): entry is { handle: string; origin: string } => entry !== null);
}

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}
