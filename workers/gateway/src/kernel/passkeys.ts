import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { AccountPasskey, ArgsOf, ResultOf } from "@humansandmachines/gsv/protocol";
import { z } from "zod";
import { hashToken, isLocked } from "../auth/shadow";
import { principalOf, type KernelContext } from "./context";
import type { AuthStore } from "./auth-store";

const encoded = z.string().min(1).max(64 * 1024).regex(/^[A-Za-z0-9_-]+$/);
const responseFields = { id: encoded, rawId: encoded, type: z.literal("public-key"), authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(), clientExtensionResults: z.object({ credProps: z.object({ rk: z.boolean().optional() }).optional() }) };
const registrationSchema = z.strictObject({ id: z.uuid(), response: z.strictObject({ ...responseFields, response: z.strictObject({ clientDataJSON: encoded, attestationObject: encoded, transports: z.array(z.string().max(32)).max(10).optional(), authenticatorData: encoded.optional(), publicKeyAlgorithm: z.number().int().optional(), publicKey: encoded.optional() }) }) });
const authenticationSchema = z.strictObject({ id: z.uuid(), response: z.strictObject({ ...responseFields, response: z.strictObject({ clientDataJSON: encoded, authenticatorData: encoded, signature: encoded, userHandle: encoded.optional() }) }) });
const challengeLifetime = 5 * 60 * 1000;
type PasskeyRow = { id: string; uid: number; public_key: ArrayBuffer; counter: number; transports_json: string; label: string; created_at: number; last_used_at: number | null };
type Challenge = { id: string; uid: number; purpose: "register" | "authenticate"; challenge: string; origin: string; rp_id: string; credential_epoch: number; label: string; expires_at: number; consumed_at: number | null; response_hash: string | null; credential_id: string | null };

/** WebAuthn proves an existing local human. The Kernel remains the credential issuer. */
export class PasskeyStore {
  constructor(private readonly storage: DurableObjectStorage, private readonly auth: AuthStore) {}

  async beginRegistration(input: ArgsOf<"account.passkey.register.begin">, ctx: KernelContext): Promise<ResultOf<"account.passkey.register.begin">> {
    const uid = this.signedInHuman(ctx);
    const label = z.string().trim().min(1).max(80).parse(input.label);
    const epoch = this.auth.credentialEpoch(uid);
    const user = this.human(uid);
    const { origin, rpId } = this.relyingParty(ctx);
    this.storage.sql.exec("INSERT INTO account_passkey_users (uid, user_handle) VALUES (?, ?) ON CONFLICT(uid) DO NOTHING", uid, crypto.randomUUID());
    const userHandle = this.storage.sql.exec<{ user_handle: string }>("SELECT user_handle FROM account_passkey_users WHERE uid = ?", uid).one().user_handle;
    const options = await generateRegistrationOptions({ rpName: "your GSV", rpID: rpId, userName: user.username, userDisplayName: user.gecos || user.username,
      userID: new Uint8Array(new TextEncoder().encode(userHandle)), attestationType: "none", supportedAlgorithmIDs: [-7, -257],
      excludeCredentials: this.keys(uid).map((key) => ({ id: key.id, transports: this.transports(key) })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, timeout: challengeLifetime,
    });
    this.assertEpoch(uid, epoch);
    const id = this.createChallenge(uid, "register", options.challenge, origin, rpId, epoch, label);
    return { id, options: { rp: options.rp, user: options.user, challenge: options.challenge, pubKeyCredParams: options.pubKeyCredParams,
      timeout: options.timeout, excludeCredentials: options.excludeCredentials?.map((key) => ({ id: key.id, type: "public-key", transports: key.transports })), authenticatorSelection: options.authenticatorSelection, attestation: "none" } };
  }

  async finishRegistration(input: ArgsOf<"account.passkey.register.finish">, ctx: KernelContext): Promise<AccountPasskey> {
    const uid = this.signedInHuman(ctx);
    const args = registrationSchema.parse(input);
    const challenge = this.readChallenge(args.id, "register", ctx);
    if (challenge.uid !== uid) throw new Error("Passkey registration belongs to another account");
    const responseHash = await hashToken(JSON.stringify(args.response));
    if (challenge.consumed_at !== null) {
      this.assertEpoch(uid, challenge.credential_epoch);
      const key = challenge.credential_id && this.key(challenge.credential_id);
      if (!key || key.uid !== uid || challenge.response_hash !== responseHash) throw new Error("Passkey registration was already used");
      return this.describe(key);
    }
    const verification = await verifyRegistrationResponse({ response: args.response, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: challenge.rp_id,
      requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
    if (!verification.verified) throw new Error("Passkey registration could not be verified");
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    if (credential.id !== args.response.id) throw new Error("Passkey credential identity does not match its attestation");
    return this.storage.transactionSync(() => {
      const current = this.readChallenge(args.id, "register", ctx);
      this.assertEpoch(uid, current.credential_epoch);
      if (current.consumed_at !== null) {
        const key = current.credential_id && this.key(current.credential_id);
        if (!key || current.response_hash !== responseHash) throw new Error("Passkey registration was already used");
        return this.describe(key);
      }
      this.storage.sql.exec(`INSERT INTO account_passkeys (id, uid, public_key, counter, transports_json, device_type, backed_up, label, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, credential.id, uid, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), credentialDeviceType, credentialBackedUp ? 1 : 0, current.label, Date.now());
      this.storage.sql.exec("UPDATE account_passkey_challenges SET consumed_at = ?, response_hash = ?, credential_id = ? WHERE id = ?", Date.now(), responseHash, credential.id, args.id);
      return this.describe(this.key(credential.id)!);
    });
  }

  async beginAuthentication(input: ArgsOf<"account.passkey.authenticate.begin">, ctx: KernelContext): Promise<ResultOf<"account.passkey.authenticate.begin">> {
    const username = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).parse(input.username);
    const user = this.auth.getPasswdByUsername(username);
    if (!user) throw new Error("Passkey sign-in is unavailable");
    this.human(user.uid);
    const epoch = this.auth.credentialEpoch(user.uid);
    const keys = this.keys(user.uid);
    if (keys.length === 0) throw new Error("Passkey sign-in is unavailable; use your password");
    const { origin, rpId } = this.relyingParty(ctx);
    const options = await generateAuthenticationOptions({ rpID: rpId, allowCredentials: keys.map((key) => ({ id: key.id, transports: this.transports(key) })), userVerification: "required", timeout: challengeLifetime });
    this.assertEpoch(user.uid, epoch);
    const id = this.createChallenge(user.uid, "authenticate", options.challenge, origin, rpId, epoch, "");
    return { id, options: { challenge: options.challenge, rpId: options.rpId, timeout: options.timeout, allowCredentials: options.allowCredentials?.map((key) => ({ id: key.id, type: "public-key", transports: key.transports })), userVerification: "required" } };
  }

  async finishAuthentication(input: ArgsOf<"account.passkey.authenticate.finish">, ctx: KernelContext): Promise<ResultOf<"account.passkey.authenticate.finish">> {
    const args = authenticationSchema.parse(input);
    const challenge = this.readChallenge(args.id, "authenticate", ctx);
    if (challenge.consumed_at !== null) throw new Error("Passkey challenge was already used");
    this.assertEpoch(challenge.uid, challenge.credential_epoch);
    const key = this.key(args.response.id);
    if (!key || key.uid !== challenge.uid) throw new Error("Passkey sign-in is unavailable");
    if (args.response.response.userHandle) {
      const user = this.storage.sql.exec<{ user_handle: string }>("SELECT user_handle FROM account_passkey_users WHERE uid = ?", key.uid).one();
      if (args.response.response.userHandle !== isoBase64URL.fromUTF8String(user.user_handle)) throw new Error("Passkey belongs to another user");
    }
    const verification = await verifyAuthenticationResponse({ response: args.response, expectedChallenge: challenge.challenge, expectedOrigin: challenge.origin, expectedRPID: challenge.rp_id,
      credential: { id: key.id, publicKey: new Uint8Array(key.public_key), counter: key.counter, transports: this.transports(key) }, requireUserVerification: true });
    if (!verification.verified) throw new Error("Passkey sign-in could not be verified");
    const token = await this.auth.prepareToken({ uid: key.uid, kind: "human", label: "passkey sign-in", expiresAt: Date.now() + challengeLifetime });
    return this.storage.transactionSync(() => {
      const current = this.readChallenge(args.id, "authenticate", ctx);
      this.assertEpoch(key.uid, current.credential_epoch);
      const currentKey = this.key(key.id);
      if (current.consumed_at !== null || !currentKey || currentKey.uid !== key.uid || currentKey.counter !== key.counter) throw new Error("Passkey challenge was used or the credential changed");
      this.storage.sql.exec("UPDATE account_passkeys SET counter = ?, backed_up = ?, last_used_at = ? WHERE id = ?", verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp ? 1 : 0, Date.now(), key.id);
      this.storage.sql.exec("UPDATE account_passkey_challenges SET consumed_at = ? WHERE id = ?", Date.now(), args.id);
      this.auth.storePreparedToken(token);
      return { username: this.human(key.uid).username, token: token.issued.token };
    });
  }

  list(ctx: KernelContext): ResultOf<"account.passkey.list"> {
    return { passkeys: this.keys(this.signedInHuman(ctx)).map((key) => this.describe(key)) };
  }

  revoke(input: ArgsOf<"account.passkey.revoke">, ctx: KernelContext): ResultOf<"account.passkey.revoke"> {
    const uid = this.signedInHuman(ctx);
    const id = encoded.parse(input.id);
    const key = this.key(id);
    if (!key || key.uid !== uid) return { revoked: false };
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM account_passkeys WHERE id = ? AND uid = ?", id, uid);
      this.storage.sql.exec("DELETE FROM account_passkey_challenges WHERE uid = ? AND purpose = 'authenticate'", uid);
    });
    return { revoked: true };
  }

  private signedInHuman(ctx: KernelContext): number {
    const principal = principalOf(ctx);
    if (principal?.kind !== "human" || ctx.peer?.provenance.kind !== "credential") throw new Error("Passkey administration requires a signed-in human");
    const uid = principal.account.uid;
    this.human(uid);
    if (ctx.connection && (ctx.connection.state.step !== "connected" || (ctx.connection.state.credentialEpoch ?? 0) !== this.auth.credentialEpoch(uid))) throw new Error("Credentials changed; sign in again");
    return uid;
  }

  private human(uid: number) {
    const user = this.auth.getPasswdByUid(uid);
    const shadow = user && this.auth.getShadowByUsername(user.username);
    if (!user || !shadow || (uid !== 0 && uid < 1000) || isLocked(shadow) || this.auth.isAccountDisabled(uid)) throw new Error("Local human account is unavailable");
    return user;
  }

  private assertEpoch(uid: number, epoch: number): void {
    this.human(uid);
    if (this.auth.credentialEpoch(uid) !== epoch) throw new Error("Passkey authorization was revoked");
  }

  private relyingParty(ctx: KernelContext) {
    const address = ctx.installationIdentity?.canonicalOrigin ?? ctx.connection?.uri;
    if (!address) throw new Error("Passkeys require the space's trusted origin");
    const url = new URL(address);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) throw new Error("Passkeys require HTTPS or localhost");
    return { origin: url.origin, rpId: url.hostname };
  }

  private createChallenge(uid: number, purpose: Challenge["purpose"], challenge: string, origin: string, rpId: string, epoch: number, label: string): string {
    this.storage.sql.exec("DELETE FROM account_passkey_challenges WHERE expires_at <= ?", Date.now());
    const pending = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM account_passkey_challenges WHERE uid = ? AND consumed_at IS NULL", uid).one().count;
    if (pending >= 16) throw new Error("Too many pending passkey attempts; wait a few minutes");
    const id = crypto.randomUUID();
    this.storage.sql.exec(`INSERT INTO account_passkey_challenges (id, uid, purpose, challenge, origin, rp_id, credential_epoch, label, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, uid, purpose, challenge, origin, rpId, epoch, label, Date.now() + challengeLifetime);
    return id;
  }

  private readChallenge(id: string, purpose: Challenge["purpose"], ctx: KernelContext): Challenge {
    const row = this.storage.sql.exec<Challenge>("SELECT * FROM account_passkey_challenges WHERE id = ?", id).toArray()[0];
    const rp = this.relyingParty(ctx);
    if (!row || row.purpose !== purpose || row.origin !== rp.origin || row.rp_id !== rp.rpId || row.expires_at <= Date.now()) throw new Error("Passkey challenge is unavailable or expired");
    return row;
  }

  private keys(uid: number): PasskeyRow[] { return this.storage.sql.exec<PasskeyRow>("SELECT * FROM account_passkeys WHERE uid = ? ORDER BY created_at", uid).toArray(); }
  private key(id: string): PasskeyRow | undefined { return this.storage.sql.exec<PasskeyRow>("SELECT * FROM account_passkeys WHERE id = ?", id).toArray()[0]; }
  private transports(key: PasskeyRow): string[] { return z.array(z.string()).parse(JSON.parse(key.transports_json)); }
  private describe(key: PasskeyRow): AccountPasskey { return { id: key.id, label: key.label, createdAt: key.created_at, lastUsedAt: key.last_used_at }; }
}
