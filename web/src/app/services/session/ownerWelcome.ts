import { z } from "zod";

export const ONBOARDING_KEY = "gsv.ui.installation-onboarding.v1";
export type WelcomeState = {
  origin: string;
  flow: "open" | "create";
  sessionSecret: string | null;
  challenge: { id: string; email: string; browserSecret: string } | null;
  inviteCode: string | null;
  inviteId: string | null;
  handle: string | null;
};
export type WelcomeSnapshot = { revision: string; value: WelcomeState | null };
export type WelcomeStorage = { save(revision: string, value: WelcomeState | null): Promise<WelcomeSnapshot> };
type OwnerFetch = (url: string, init: {
  method: "GET" | "POST"; headers: Record<string, string>; credentials: "omit"; cache: "no-store"; body?: string; signal: AbortSignal;
}) => Promise<Pick<Response, "ok" | "text">>;
type OwnerRequest = { challengeId: string; email: string; browserSecret: string; resend: boolean }
  | { challengeId: string; browserSecret: string; sessionSecret: string; code: string }
  | { code: string } | { handle: string } | Record<string, never>;
type OwnerHeaders = { "content-type": string; authorization?: string };
const deliverySchema = z.object({ deliveryStatus: z.enum(["sent", "sending", "failed"]) });
const verifiedSchema = z.object({ email: z.string(), expiresAt: z.number() });
const availableSchema = z.object({ available: z.boolean() });
const loggedOutSchema = z.object({ ok: z.literal(true) });
const invitationSchema = z.object({ id: z.string(), state: z.enum(["issued", "claimed", "provisioning", "active", "revoked", "expired"]),
  handle: z.string().nullable(), origin: z.string().nullable(), lastError: z.string().nullable() });
export type OwnedInvite = z.infer<typeof invitationSchema>;
const sessionSchema = z.object({ email: z.string(), expiresAt: z.number(), spaceDomain: z.string().min(1),
  spaces: z.array(z.object({ handle: z.string(), canonicalOrigin: z.string(), state: z.enum(["active", "restricted"]) })), invites: z.array(invitationSchema) });
export type OwnerSession = z.infer<typeof sessionSchema>;
const preparationSchema = z.object({ invite: invitationSchema, origin: z.string(), handle: z.string(),
  onboardingToken: z.string().regex(/^onboard_[A-Za-z0-9_-]{43}$/).nullable(), expiresAt: z.number().nullable() });
export type PreparedSpace = z.infer<typeof preparationSchema>;
const failureSchema = z.object({ error: z.string().optional(), code: z.string().optional(), deliveryStatus: z.string().optional() });
export class OwnerApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
const randomSecret = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Save request identities before transmission so a lost response can be resumed. */
export class OwnerWelcome {
  constructor(private snapshot: WelcomeSnapshot, private readonly storage: WelcomeStorage,
    private readonly accountsOrigin: string, private readonly fetcher: OwnerFetch = (input, init) => fetch(input, init)) {}

  get state(): WelcomeState {
    return this.snapshot.value ?? { origin: this.accountsOrigin, flow: "open", sessionSecret: null, challenge: null, inviteCode: null, inviteId: null, handle: null };
  }

  async save(change: Partial<WelcomeState>): Promise<void> {
    this.snapshot = await this.storage.save(this.snapshot.revision, { ...this.state, ...change });
  }

  async session(): Promise<OwnerSession | null> {
    if (!this.state.sessionSecret) return null;
    try { return await this.request("/session", sessionSchema); }
    catch (error) { if (error instanceof OwnerApiError && error.code === "signed_out") return null; throw error; }
  }

  async sendCode(email: string, resend = false): Promise<void> {
    const current = this.state.challenge;
    if (!current || current.email !== email) {
      await this.save({ challenge: { id: crypto.randomUUID(), email, browserSecret: randomSecret() }, sessionSecret: randomSecret() });
    }
    const pending = this.state.challenge!;
    const result = await this.request("/code", deliverySchema, {
      challengeId: pending.id, email: pending.email, browserSecret: pending.browserSecret, resend,
    }, false);
    if (result.deliveryStatus !== "sent") throw new OwnerApiError("Email is still sending. Try again shortly.");
  }

  async verify(code: string): Promise<void> {
    const pending = this.state.challenge;
    if (!pending || !this.state.sessionSecret) throw new Error("Request a code first.");
    await this.request("/verify", verifiedSchema, { challengeId: pending.id, browserSecret: pending.browserSecret, sessionSecret: this.state.sessionSecret, code }, false);
    await this.save({ challenge: null });
  }

  async claim(): Promise<OwnedInvite> {
    if (!this.state.inviteCode) throw new Error("Enter your invite code.");
    const invite = await this.request("/invites/claim", invitationSchema, { code: this.state.inviteCode });
    await this.save({ inviteCode: null, inviteId: invite.id, handle: invite.handle });
    return invite;
  }

  async available(handle: string): Promise<boolean> {
    return (await this.request(`/handle?value=${encodeURIComponent(handle)}`, availableSchema)).available;
  }

  async prepare(inviteId: string, handle: string): Promise<PreparedSpace> {
    await this.save({ inviteId, handle });
    const prepared = await this.request(`/invites/${encodeURIComponent(inviteId)}/space`, preparationSchema, { handle });
    if (!prepared.onboardingToken) await this.completeCreation();
    return prepared;
  }

  async completeCreation(): Promise<void> {
    if (this.state.flow !== "create") return;
    await this.save({ flow: "open", challenge: null, inviteCode: null, inviteId: null, handle: null });
  }

  async signOut(): Promise<void> {
    if (this.state.sessionSecret) {
      try { await this.request("/logout", loggedOutSchema, {}); }
      catch (error) { if (!(error instanceof OwnerApiError && error.code === "signed_out")) throw error; }
    }
    this.snapshot = await this.storage.save(this.snapshot.revision, null);
  }

  private async request<T>(path: string, schema: z.ZodType<T>, body?: OwnerRequest, authorize = true): Promise<T> {
    const headers: OwnerHeaders = { "content-type": "application/json" };
    if (authorize && this.state.sessionSecret) headers.authorization = `Bearer ${this.state.sessionSecret}`;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 20_000);
    try {
      const response = await this.fetcher(`${this.state.origin}/owner/api${path}`, {
        method: body === undefined ? "GET" : "POST", headers, credentials: "omit", cache: "no-store",
        body: body === undefined ? undefined : JSON.stringify(body), signal: timeout.signal,
      });
      const data: unknown = JSON.parse(await response.text());
      if (!response.ok) {
        const error = failureSchema.safeParse(data);
        throw new OwnerApiError(error.success ? error.data.error ?? (error.data.deliveryStatus === "failed" ? "Could not send the email. Try again shortly." : "Could not continue. Try again.") : "Could not continue. Try again.", error.success ? error.data.code : undefined);
      }
      return schema.parse(data);
    } catch (error) {
      if (error instanceof OwnerApiError) throw error;
      throw new OwnerApiError("Could not connect. Try again.");
    } finally { clearTimeout(timer); }
  }
}
