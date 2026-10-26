import { z } from "zod";
import { t } from "../../i18n/locale";

export const ONBOARDING_KEY = "gsv.ui.installation-onboarding.v1";
export type WelcomeState = {
  origin: string;
  flow: "open" | "create";
  sessionSecret: string | null;
  challenge: { id: string; email: string; browserSecret: string } | null;
  operationId: string | null;
  handle: string | null;
  contactInvite?: string | null;
};
export type WelcomeSnapshot = { revision: string; value: WelcomeState | null };
export type WelcomeStorage = { save(revision: string, value: WelcomeState | null): Promise<WelcomeSnapshot> };
type OwnerFetch = (url: string, init: {
  method: "GET" | "POST"; headers: Record<string, string>; credentials: "omit"; cache: "no-store"; body?: string; signal: AbortSignal;
}) => Promise<Pick<Response, "ok" | "status" | "text">>;
export type ProductEmailChoice = { wordingVersion: "ship-product-updates-2026-10-26"; locale: "en" | "es" | "pt-BR" };
type OwnerRequest = { challengeId: string; email: string; browserSecret: string; resend: boolean }
  | { challengeId: string; browserSecret: string; sessionSecret: string; code: string }
  | { operationId: string; handle: string; productEmails?: ProductEmailChoice } | Record<string, never>;
type OwnerHeaders = { "content-type": string; authorization?: string };
const deliverySchema = z.object({ deliveryStatus: z.enum(["sent", "sending", "failed"]) });
const verifiedSchema = z.object({ email: z.string(), expiresAt: z.number() });
const availableSchema = z.object({ available: z.boolean() });
const loggedOutSchema = z.object({ ok: z.literal(true) });
export const pendingSetupSchema = z.object({ operationId: z.string(), handle: z.string(), origin: z.string() });
export type PendingSetup = z.infer<typeof pendingSetupSchema>;
const sessionSchema = z.object({ email: z.string(), expiresAt: z.number(), spaceDomain: z.string().min(1), signupEnabled: z.boolean(),
  spaces: z.array(z.object({ handle: z.string(), canonicalOrigin: z.string(), state: z.enum(["active", "restricted"]) })), setups: z.array(pendingSetupSchema) });
export type OwnerSession = z.infer<typeof sessionSchema>;
const preparationSchema = z.object({ origin: z.string(), handle: z.string(),
  onboardingToken: z.string().regex(/^onboard_[A-Za-z0-9_-]{43}$/).nullable(), expiresAt: z.number().nullable() });
export type PreparedSpace = z.infer<typeof preparationSchema>;
const failureSchema = z.object({ error: z.string().optional(), code: z.string().optional(), deliveryStatus: z.string().optional() });
export class OwnerApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) { super(message); }
}
const randomSecret = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Save request identities before transmission so a lost response can be resumed. */
export class OwnerWelcome {
  constructor(private snapshot: WelcomeSnapshot, private readonly storage: WelcomeStorage,
    private readonly accountsOrigin: string, private readonly fetcher: OwnerFetch = (input, init) => fetch(input, init)) {}

  get state(): WelcomeState {
    return this.snapshot.value ?? { origin: this.accountsOrigin, flow: "open", sessionSecret: null, challenge: null, operationId: null, handle: null };
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
    if (result.deliveryStatus !== "sent") throw new OwnerApiError(t("session.owner.emailSending"));
  }

  async verify(code: string): Promise<void> {
    const pending = this.state.challenge;
    if (!pending || !this.state.sessionSecret) throw new Error(t("session.owner.requestCode"));
    await this.request("/verify", verifiedSchema, { challengeId: pending.id, browserSecret: pending.browserSecret, sessionSecret: this.state.sessionSecret, code }, false);
    await this.save({ challenge: null });
  }

  /** Null means Accounts would not say yet: the handle is checked again when the space is created. */
  async available(handle: string): Promise<boolean | null> {
    try { return (await this.request(`/handle?value=${encodeURIComponent(handle)}`, availableSchema)).available; }
    catch (error) {
      if (error instanceof OwnerApiError && (error.code === "signed_out" || error.status === undefined || error.status === 429 || error.status >= 500)) return null;
      throw error;
    }
  }

  /** Records the chosen handle under one operation id before the email step so an interrupted signup resumes it. */
  async chooseHandle(handle: string): Promise<void> {
    const operationId = this.state.handle === handle && this.state.operationId ? this.state.operationId : crypto.randomUUID();
    await this.save({ flow: "create", handle, operationId });
  }

  async prepare(handle: string, operationId = this.state.operationId ?? crypto.randomUUID(), productEmails?: ProductEmailChoice): Promise<PreparedSpace> {
    await this.save({ flow: "create", operationId, handle });
    const prepared = await this.request("/spaces", preparationSchema, { operationId, handle, productEmails });
    if (!prepared.onboardingToken) await this.completeCreation();
    return prepared;
  }

  async completeCreation(): Promise<void> {
    if (this.state.flow !== "create") return;
    const change: Partial<WelcomeState> = { flow: "open", challenge: null, operationId: null, handle: null };
    if (this.state.contactInvite !== undefined) change.contactInvite = null;
    await this.save(change);
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
        throw new OwnerApiError(error.success ? error.data.error ?? t(error.data.deliveryStatus === "failed" ? "session.owner.emailFailed" : "session.owner.failed") : t("session.owner.failed"), error.success ? error.data.code : undefined, response.status);
      }
      return schema.parse(data);
    } catch (error) {
      if (error instanceof OwnerApiError) throw error;
      throw new OwnerApiError(t("session.owner.connectFailed"));
    } finally { clearTimeout(timer); }
  }
}
