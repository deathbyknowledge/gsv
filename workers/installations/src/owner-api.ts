import { z } from "zod";
import { readJsonObject } from "./http";
import { InstallationOwnerAuthStore, OwnerAuthError, type OwnerAuthErrorCode } from "./owner-auth-store";
import { InstallationOwnerStore } from "./owner-store";
import { InstallationCreationInvites, type CreationInvite } from "./creation-invites";
import { sendOwnerVerification } from "./owner-verification";

const secret = z.string().regex(/^[a-f0-9]{64}$/);
const challenge = z.strictObject({ challengeId: z.string().uuid(), browserSecret: secret, email: z.string().max(254), resend: z.boolean().optional() });
const verification = z.strictObject({ challengeId: z.string().uuid(), browserSecret: secret, sessionSecret: secret, code: z.string().regex(/^\d{6}$/) });
const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type", "cache-control": "no-store" };
type OwnerApiReply = Awaited<ReturnType<typeof sendOwnerVerification>>
  | { email: string; expiresAt: number }
  | { email: string; expiresAt: number; spaces: Awaited<ReturnType<InstallationOwnerStore["spaces"]>>; invites: ReturnType<typeof ownedInvite>[] }
  | ReturnType<typeof ownedInvite>
  | { invite: ReturnType<typeof ownedInvite>; origin: string; handle: string; onboardingToken: string | null; expiresAt: number | null }
  | { ok: true } | { available: boolean }
  | { error: string; code?: OwnerAuthErrorCode | "signed_out"; retryAt?: number };

/** Explicit bearer authentication; browser cookies never authorize this native API. */
export class InstallationOwnerApi {
  constructor(private readonly auth: InstallationOwnerAuthStore, private readonly owners: InstallationOwnerStore,
    private readonly invites: InstallationCreationInvites, private readonly mail: SendEmail, private readonly from: string,
    private readonly origin: string) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/owner/api/")) return null;
    const json = (value: OwnerApiReply, status = 200) => Response.json(value, { status, headers: cors });
    if (url.origin !== this.origin) return json({ error: "Not found" }, 404);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method === "POST" && url.pathname === "/owner/api/code") {
        const input = challenge.parse(await readJsonObject(request));
        const result = await sendOwnerVerification(this.auth, this.mail, this.from, {
          ...input, purpose: "login", ip: request.headers.get("cf-connecting-ip") ?? "local",
        });
        return json(result, result.deliveryStatus === "sent" ? 200 : result.deliveryStatus === "sending" ? 202 : 503);
      }
      if (request.method === "POST" && url.pathname === "/owner/api/verify") {
        const input = verification.parse(await readJsonObject(request));
        const receipt = await this.auth.verify({ ...input, purpose: "login" });
        return json({ email: receipt.email, expiresAt: receipt.sessionExpiresAt });
      }
      const token = request.headers.get("authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const session = token ? await this.auth.session(token) : null;
      if (!session || !token) return json({ error: "Sign in to continue.", code: "signed_out" }, 401);
      if (request.method === "GET" && url.pathname === "/owner/api/session") {
        const [spaces, invites] = await Promise.all([this.owners.spaces(session.principalId), this.invites.owned(session.principalId)]);
        return json({ email: session.email, expiresAt: session.expiresAt, spaces, invites: invites.map(ownedInvite) });
      }
      if (request.method === "POST" && url.pathname === "/owner/api/logout") {
        await this.auth.logout(token);
        return json({ ok: true });
      }
      if (request.method === "POST" && url.pathname === "/owner/api/invites/claim") {
        const input = z.strictObject({ code: z.string().max(128) }).parse(await readJsonObject(request));
        return json(ownedInvite(await this.invites.claim(input.code, session.principalId)));
      }
      if (request.method === "GET" && url.pathname === "/owner/api/handle") {
        return json({ available: await this.invites.available(url.searchParams.get("value") ?? "") });
      }
      const prepare = /^\/owner\/api\/invites\/([A-Za-z0-9_-]{1,128})\/space$/.exec(url.pathname);
      if (request.method === "POST" && prepare) {
        const input = z.strictObject({ handle: z.string().max(63) }).parse(await readJsonObject(request));
        const result = await this.invites.prepare(prepare[1], session.principalId, input.handle);
        return json({ invite: ownedInvite(result.invite), origin: result.space.canonicalOrigin,
          handle: result.space.handle, onboardingToken: result.onboardingToken, expiresAt: result.expiresAt });
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof OwnerAuthError) {
        const message = error.code === "invalid" ? "Check the code and try again." : error.code === "expired" ? "This code has expired. Request a new one."
          : error.code === "rate_limited" ? "Wait before requesting another code." : error.code === "locked" ? "Too many attempts. Request a new code."
          : error.code === "credential_unavailable" ? "Use your existing sign-in method." : "Could not verify. Try again.";
        return json({ error: message, code: error.code, retryAt: error.retryAt }, error.code === "rate_limited" ? 429 : 400);
      }
      const message = error instanceof Error && /^(Invite is unavailable|handle is |Space setup is temporarily)/.test(error.message)
        ? error.message : error instanceof z.ZodError ? "Check the details and try again." : "Could not complete setup. Try again.";
      return json({ error: message }, 400);
    }
  }
}

function ownedInvite(invite: CreationInvite) {
  return { id: invite.id, state: invite.state, handle: invite.handle, origin: invite.canonicalOrigin, lastError: invite.lastError };
}
