import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

export type InstallationAdminAccessConfiguration = {
  environment: string;
  origin: string;
  teamDomain?: string;
  audience?: string;
};

/** The verified token claims the operator pages use. */
export type AccessClaims = { email?: string };

/** Resolves to the verified token's claims; rejects when the token is invalid. */
export type VerifyAccessToken = (
  token: string,
  teamDomain: string,
  audience: string,
) => Promise<AccessClaims>;

const accessClaimsSchema = z.object({ email: z.string().min(1).max(256).optional().catch(undefined) });

export interface InstallationAdminAccess {
  allows(request: Request): Promise<boolean>;
  /** Names the operator for the audit log, or null when the request is not allowed. */
  operatorIdentity?(request: Request): Promise<string | null>;
}

/** An admitted request whose operator cannot be confirmed for the action it asks for. */
export class AdminForbiddenError extends Error {}

export class CloudflareInstallationAdminAccess implements InstallationAdminAccess {
  constructor(
    private readonly config: InstallationAdminAccessConfiguration,
    private readonly verifyAccessToken: VerifyAccessToken = verifyCloudflareAccessToken,
  ) {}

  async allows(request: Request): Promise<boolean> {
    return await this.operatorIdentity(request) !== null;
  }

  async operatorIdentity(request: Request): Promise<string | null> {
    if (this.config.environment === "development") {
      return isLocalDevelopmentRequest(request, this.config.origin) ? "development" : null;
    }
    if (this.config.environment !== "production") return null;

    const teamDomain = accessTeamDomain(this.config.teamDomain);
    const audience = this.config.audience?.trim();
    const token = request.headers.get("cf-access-jwt-assertion")?.trim();
    if (!teamDomain || !audience || !token) return null;

    let claims: AccessClaims;
    try {
      claims = await this.verifyAccessToken(token, teamDomain, audience);
    } catch {
      return null;
    }
    return claims.email || "access";
  }
}

async function verifyCloudflareAccessToken(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<AccessClaims> {
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${teamDomain}/`));
  return accessClaimsSchema.parse((await jwtVerify(token, keys, {
    algorithms: ["RS256"],
    issuer: teamDomain,
    audience,
  })).payload);
}

function isLocalDevelopmentRequest(
  request: Request,
  accountOriginValue: string,
): boolean {
  let accountOrigin: URL;
  try {
    accountOrigin = new URL(accountOriginValue);
  } catch {
    return false;
  }
  if (
    accountOrigin.origin !== accountOriginValue
    || accountOrigin.protocol !== "http:"
    || accountOrigin.hostname !== "localhost"
  ) {
    return false;
  }
  return new URL(request.url).origin === accountOrigin.origin;
}

function accessTeamDomain(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== value
      || url.protocol !== "https:"
      || !url.hostname.endsWith(".cloudflareaccess.com")
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
