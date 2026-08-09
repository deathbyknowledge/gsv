import { createRemoteJWKSet, jwtVerify } from "jose";

export type AccountsAdminAccessEnvironment = {
  ENVIRONMENT: string;
  GSV_ACCOUNT_ORIGIN: string;
  GSV_ADMIN_ACCESS_TEAM_DOMAIN?: string;
  GSV_ADMIN_ACCESS_AUD?: string;
};

type VerifyAccessToken = (
  token: string,
  teamDomain: string,
  audience: string,
) => Promise<void>;

export interface AccountsAdminAccess {
  allows(request: Request): Promise<boolean>;
}

export class EnvironmentAccountsAdminAccess implements AccountsAdminAccess {
  constructor(
    private readonly env: AccountsAdminAccessEnvironment,
    private readonly verifyAccessToken: VerifyAccessToken = verifyCloudflareAccessToken,
  ) {}

  async allows(request: Request): Promise<boolean> {
    if (this.env.ENVIRONMENT === "development") {
      return isLocalDevelopmentRequest(request, this.env.GSV_ACCOUNT_ORIGIN);
    }
    if (this.env.ENVIRONMENT !== "production") return false;

    const teamDomain = accessTeamDomain(this.env.GSV_ADMIN_ACCESS_TEAM_DOMAIN);
    const audience = this.env.GSV_ADMIN_ACCESS_AUD?.trim();
    const token = request.headers.get("cf-access-jwt-assertion")?.trim();
    if (!teamDomain || !audience || !token) return false;

    try {
      await this.verifyAccessToken(token, teamDomain, audience);
      return true;
    } catch {
      return false;
    }
  }
}

async function verifyCloudflareAccessToken(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<void> {
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${teamDomain}/`));
  await jwtVerify(token, keys, {
    algorithms: ["RS256"],
    issuer: teamDomain,
    audience,
  });
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
