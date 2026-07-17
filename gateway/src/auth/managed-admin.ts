const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

type ManagedAdminEnv = Env & {
  // Managed deployments inject this secret. It intentionally remains absent
  // from the self-hosted Wrangler config and generated Env declaration.
  GSV_MANAGED_ADMIN_TOKEN_HASH?: unknown;
};

export type ManagedAdminAuthorization =
  | { configured: false }
  | { configured: true; authorized: boolean; configurationValid: boolean };

function decodeSha256Hex(value: string): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? "";
}

/**
 * Authenticate the private managed-runtime HTTP surface without disclosing
 * whether a supplied credential was missing, malformed, or simply wrong.
 */
export async function authorizeManagedAdmin(
  request: Request,
  env: Env,
): Promise<ManagedAdminAuthorization> {
  const configured = (env as ManagedAdminEnv).GSV_MANAGED_ADMIN_TOKEN_HASH;
  if (configured === undefined) {
    return { configured: false };
  }
  if (typeof configured !== "string" || !SHA256_HEX_RE.test(configured)) {
    return {
      configured: true,
      authorized: false,
      configurationValid: false,
    };
  }

  const candidate = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearerToken(request))),
  );
  return {
    configured: true,
    authorized: crypto.subtle.timingSafeEqual(candidate, decodeSha256Hex(configured)),
    configurationValid: true,
  };
}
