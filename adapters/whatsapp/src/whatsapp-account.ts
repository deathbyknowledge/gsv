/**
 * WhatsApp Account Durable Object
 * 
 * Manages a single WhatsApp account connection:
 * - Stores auth credentials in DO storage
 * - Maintains WebSocket connection to WhatsApp via Baileys
 * - Sends messages to Gateway via Service Binding RPC
 * - Receives outbound messages via HTTP endpoint
 */

import { DurableObject } from "cloudflare:workers";
import {
  makeWASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  extractMessageContent,
  getContentType,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
  type AnyMessageContent,
  type LIDMapping,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import {
  getMediaKeys,
  getUrlFromDirectPath,
} from "@whiskeysockets/baileys/lib/Utils/messages-media";
import { useDOAuthState, clearAuthState, hasAuthState } from "./auth-store";
import type {
  WhatsAppAccountState,
  MediaAttachment,
} from "./types";
import type {
  ChannelOutboundMessage,
  ChannelPeer,
  ChannelAccountStatus,
  ChannelMedia,
} from "./channel-types";
import type {
  AdapterInboundMessage,
  AdapterInboundResult,
  GatewayFrame,
  GatewayRequestFrame,
} from "../../shared/src/types";
import {
  ManagedLifecycleFence,
  ManagedLifecycleUnavailableError,
  type ManagedLifecycleInventory,
} from "../../shared/src/managed-lifecycle";
import {
  MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
  type ManagedObjectDescriptor,
} from "@humansandmachines/gsv/protocol/managed-objects";
import {
  validateManagedRestoreControl,
  validateManagedSnapshotRequest,
  type ManagedObjectRestoreControl,
  type ManagedObjectSnapshotRequest,
} from "@humansandmachines/gsv/protocol/data-frame-stream";
import {
  prepareManagedAdapterRestoreTarget,
  readAdapterRestoreTarget,
  restoreManagedAdapterStorage,
  snapshotManagedAdapterStorage,
} from "../../shared/src/managed-portability";

type GatewayChannelBinding = Fetcher & {
  serviceFrame: (frame: GatewayFrame) => Promise<GatewayFrame | null>;
};

interface Env {
  // Direct service binding to Gateway entrypoint.
  GATEWAY: GatewayChannelBinding;
  WHATSAPP_ACCOUNT: DurableObjectNamespace<WhatsAppAccount>;
}

// Quiet logger for Baileys - suppresses verbose output
const noopLogger = {
  level: "silent",
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
} as any;

const MEDIA_CONTENT_TYPES = new Set([
  "imageMessage",
  "videoMessage",
  "audioMessage",
  "documentMessage",
]);

const BYTE_TO_BASE64_CHUNK_SIZE = 0x1000; // 4KB (avoids argument-list stack overflows)

function uint8ArrayToBase64(data: Uint8Array): string {
  if (data.length === 0) return "";

  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += BYTE_TO_BASE64_CHUNK_SIZE) {
    const chunk = data.subarray(i, i + BYTE_TO_BASE64_CHUNK_SIZE);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

function normalizeWhatsAppJid(jid: string | null | undefined): string | null {
  let normalized = (jid ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("wa:jid:")) {
    normalized = normalized.slice("wa:jid:".length);
  }
  return jidNormalizedUser(normalized) || normalized;
}

function isPnWhatsAppJid(jid: string | null | undefined): jid is string {
  return typeof jid === "string" && isPnUser(jid) === true;
}

function isLidWhatsAppJid(jid: string | null | undefined): jid is string {
  return typeof jid === "string" && isLidUser(jid) === true;
}

function preferredLidJid(
  primary: string | null | undefined,
  alternate: string | null | undefined,
): string | null {
  const normalizedPrimary = normalizeWhatsAppJid(primary);
  const normalizedAlternate = normalizeWhatsAppJid(alternate);
  if (isLidWhatsAppJid(normalizedPrimary)) return normalizedPrimary;
  if (isLidWhatsAppJid(normalizedAlternate)) return normalizedAlternate;
  return normalizedPrimary ?? normalizedAlternate;
}

function preferredPnJid(
  primary: string | null | undefined,
  alternate: string | null | undefined,
): string | undefined {
  const normalizedPrimary = normalizeWhatsAppJid(primary);
  const normalizedAlternate = normalizeWhatsAppJid(alternate);
  if (isPnWhatsAppJid(normalizedPrimary)) return normalizedPrimary;
  if (isPnWhatsAppJid(normalizedAlternate)) return normalizedAlternate;
  return undefined;
}

function normalizeOutboundWhatsAppJid(jid: string | null | undefined): string {
  let normalized = (jid ?? "").trim();
  if (!normalized) {
    throw new Error("WhatsApp JID is required");
  }
  if (normalized.startsWith("wa:jid:")) {
    normalized = normalized.slice("wa:jid:".length);
  }
  if (normalized.startsWith("+") && !normalized.includes("@")) {
    const digits = normalized.slice(1).replace(/\D/g, "");
    if (digits) return `${digits}@s.whatsapp.net`;
  }
  if (/^\d+$/.test(normalized)) {
    return `${normalized}@s.whatsapp.net`;
  }
  return normalizeWhatsAppJid(normalized) ?? normalized.toLowerCase();
}

function base64Payload(data: string): string {
  const dataUrl = /^data:[^;,]+;base64,(.*)$/is.exec(data.trim());
  return dataUrl ? dataUrl[1] : data;
}

function phoneDigitsFromJid(jid: string | null | undefined): string | null {
  const normalized = normalizeWhatsAppJid(jid);
  const match = normalized?.match(/^(\d+)@s\.whatsapp\.net$/);
  return match?.[1] ?? null;
}

function phoneActorId(phoneDigits: string): string {
  return `wa:jid:${phoneDigits}@s.whatsapp.net`;
}

function jidActorId(jid: string): string {
  return `wa:jid:${jid}`;
}

export class WhatsAppAccount extends DurableObject<Env> {
  private readonly lifecycle: ManagedLifecycleFence;
  private sock: WASocket | null = null;
  private state: WhatsAppAccountState = {
    accountId: "",
    connected: false,
  };
  private qrCode: string | null = null;
  private waitResolvers: Array<(result: { connected?: boolean; qr?: string }) => void> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle = new ManagedLifecycleFence(this.ctx.storage);
    this.ctx.blockConcurrencyWhile(async () => {
      await this.lifecycle.load();
      this.state.accountId =
        (await this.ctx.storage.get<string>("accountId")) || "";
      if (!this.lifecycle.isActive()) {
        this.state.connected = false;
      }
    });
  }

  async managedPause(accountId: string): Promise<ManagedLifecycleInventory> {
    return this.lifecycle.runExclusive(async () => {
      await this.bindAccountId(accountId);
      await this.lifecycle.pause();
      this.closeSocket("Managed account paused");
      this.state.connected = false;
      this.state.lastDisconnectedAt = Date.now();
      this.qrCode = null;
      this.resolveWaiters({});
      await Promise.all([
        this.ctx.storage.delete("login_pending"),
        this.ctx.storage.deleteAlarm(),
      ]);
      return this.lifecycle.snapshot(this.state.accountId);
    });
  }

  async managedResume(accountId: string): Promise<ManagedLifecycleInventory> {
    return this.lifecycle.runExclusive(async () => {
      await this.bindAccountId(accountId);
      await this.lifecycle.resume();
      const epoch = this.lifecycle.activeEpoch();
      if (await hasAuthState(this.ctx.storage)) {
        this.lifecycle.assertActive(epoch);
        if (!this.sock) {
          await this.startSocket(epoch);
        }
        if (this.lifecycle.isActive(epoch)) {
          await this.scheduleKeepAlive(epoch);
        }
      }
      return this.lifecycle.snapshot(this.state.accountId);
    });
  }

  async managedErase(accountId: string): Promise<ManagedLifecycleInventory> {
    return this.lifecycle.runExclusive(async () => {
      await this.bindAccountId(accountId);
      await this.lifecycle.erase();
      this.closeSocket("Managed account erased");
      this.resolveWaiters({});
      await this.ctx.storage.deleteAlarm();
      await this.lifecycle.eraseStorage({ accountId: this.state.accountId });
      this.state = {
        accountId: this.state.accountId,
        connected: false,
      };
      this.qrCode = null;
      return this.lifecycle.snapshot(this.state.accountId);
    });
  }

  async managedDescriptor(): Promise<ManagedObjectDescriptor> {
    const lifecycle = this.lifecycle.snapshot(this.state.accountId);
    if (!this.state.accountId) {
      return {
        schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
        kind: "adapter_account",
        providerId: this.ctx.id.toString(),
        logicalName: null,
        classification: "uninitialized",
        lifecycle: { status: "uninitialized", epoch: lifecycle.epoch },
      };
    }
    return {
      schemaVersion: MANAGED_OBJECT_DESCRIPTOR_SCHEMA_VERSION,
      kind: "adapter_account",
      providerId: this.ctx.id.toString(),
      logicalName: this.state.accountId,
      classification: lifecycle.status === "erased" ? "erased" : "initialized",
      lifecycle: { status: lifecycle.status, epoch: lifecycle.epoch },
    };
  }

  async managedSnapshot(input: ManagedObjectSnapshotRequest): Promise<ReadableStream<Uint8Array>> {
    const request = validateManagedSnapshotRequest(input);
    this.assertManagedPortableIdentity(
      request.component,
      request.kind,
      request.logicalName,
      request.providerId,
      request.fenceEpoch,
    );
    const descriptor = await this.managedDescriptor();
    if (
      descriptor.classification !== "initialized"
      || descriptor.logicalName !== request.logicalName
      || descriptor.lifecycle.status !== "paused"
    ) {
      throw new Error("WhatsApp account is not a paused initialized snapshot source");
    }
    return snapshotManagedAdapterStorage(
      this.ctx.storage,
      request.objectId,
      () => this.lifecycle.assertPaused(request.fenceEpoch),
    );
  }

  async managedRestore(
    input: ManagedObjectRestoreControl,
    stream: ReadableStream<Uint8Array>,
  ) {
    return this.lifecycle.runExclusive(async () => {
      try {
        const control = validateManagedRestoreControl(input);
        this.assertManagedTargetIdentity(control);
        if (!readAdapterRestoreTarget(this.ctx.storage)) {
          if (this.state.accountId !== "") {
            throw new Error("WhatsApp restore target is not fresh");
          }
          await this.lifecycle.prepareRestore(control.fenceEpoch);
          this.closeSocket("Managed account is being restored");
          this.resolveWaiters({});
          await this.ctx.storage.deleteAlarm();
        }
        this.lifecycle.assertPaused(control.fenceEpoch);
        await prepareManagedAdapterRestoreTarget(this.ctx.storage, control);
        const result = await restoreManagedAdapterStorage(
          this.ctx.storage,
          stream,
          control,
          () => this.lifecycle.assertPaused(control.fenceEpoch),
        );
        this.state = {
          accountId: (await this.ctx.storage.get<string>("accountId")) ?? "",
          connected: false,
        };
        this.qrCode = null;
        const descriptor = await this.managedDescriptor();
        if (
          descriptor.classification !== "initialized"
          || descriptor.logicalName !== control.logicalName
          || descriptor.providerId !== this.ctx.id.toString()
        ) {
          throw new Error("Restored WhatsApp identity does not match its target");
        }
        return { ...result, providerId: descriptor.providerId };
      } catch (error) {
        if (!stream.locked) await stream.cancel(error).catch(() => {});
        throw error;
      }
    });
  }

  private assertManagedTargetIdentity(control: ManagedObjectRestoreControl): void {
    if (
      control.component !== "whatsapp"
      || control.kind !== "adapter_account"
      || this.env.WHATSAPP_ACCOUNT.idFromName(control.logicalName).toString()
        !== this.ctx.id.toString()
    ) {
      throw new Error("WhatsApp managed restore identity is invalid");
    }
  }

  private assertManagedPortableIdentity(
    component: string,
    kind: string,
    logicalName: string,
    providerId: string,
    fenceEpoch: number,
  ): void {
    if (
      component !== "whatsapp"
      || kind !== "adapter_account"
      || providerId !== this.ctx.id.toString()
      || this.env.WHATSAPP_ACCOUNT.idFromName(logicalName).toString() !== providerId
    ) {
      throw new Error("WhatsApp managed portable identity is invalid");
    }
    this.lifecycle.assertPaused(fenceEpoch);
  }

  /**
   * HTTP fetch handler - internal API for WhatsAppChannel entrypoint
   */
  async fetch(request: Request): Promise<Response> {
    // Ensure accountId is set from header (required on all requests)
    const headerAccountId = request.headers.get("X-Account-Id");
    const traceId = request.headers.get("X-Trace-Id")?.trim() || "no-trace";
    if (headerAccountId && !this.state.accountId) {
      await this.bindAccountId(headerAccountId);
      console.log(`[WA] Set accountId from header: ${headerAccountId}`);
    }
    
    if (!this.state.accountId) {
      return Response.json({ error: "Missing X-Account-Id header" }, { status: 400 });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    console.log(
      `[whatsapp.do:${traceId}] fetch accountId=${this.state.accountId} method=${request.method} path=${path}${url.search}`,
    );

    try {
      if (path !== "/status") {
        this.lifecycle.activeEpoch();
      }
      switch (path) {
        case "/status":
          return this.handleStatus();
        case "/login":
          return await this.handleLogin(url, request.method === "POST", traceId);
        case "/logout":
          return await this.handleLogout();
        case "/stop":
          return await this.handleStop();
        case "/wake":
          return await this.handleWake();
        case "/send":
          return await this.handleSend(request);
        case "/react":
          return await this.handleReact(request);
        case "/typing":
          return await this.handleTyping(request);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      if (e instanceof ManagedLifecycleUnavailableError) {
        return Response.json(
          { error: e.message },
          { status: e.status === "erased" ? 410 : 503 },
        );
      }
      console.error(`[WhatsAppAccount] Error handling ${path}:`, e);
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  private handleStatus(): Response {
    return Response.json({
      accountId: this.state.accountId,
      connected: this.state.connected,
      selfJid: this.state.selfJid,
      selfE164: this.state.selfE164,
      lastConnectedAt: this.state.lastConnectedAt,
      lastMessageAt: this.state.lastMessageAt,
      hasSocket: this.sock !== null,
      managedLifecycle: this.lifecycle.snapshot(this.state.accountId),
    });
  }

  private async bindAccountId(accountId: string): Promise<void> {
    const normalized = accountId.trim();
    if (!normalized) {
      throw new Error("WhatsApp account ID is required");
    }
    if (this.state.accountId && this.state.accountId !== normalized) {
      throw new Error("WhatsApp account ID does not match durable account");
    }
    if (!this.state.accountId) {
      await this.ctx.storage.put("accountId", normalized);
      this.state.accountId = normalized;
    }
  }

  private closeSocket(reason: string): void {
    const socket = this.sock;
    this.sock = null;
    if (socket) {
      socket.end(new Error(reason));
    }
  }

  private async handleLogin(url: URL, isPost: boolean, traceId: string): Promise<Response> {
    const epoch = this.lifecycle.activeEpoch();
    const force = url.searchParams.get("force") === "true";
    console.log(
      `[whatsapp.do:${traceId}] handleLogin accountId=${this.state.accountId} force=${force ? "true" : "false"} isPost=${isPost ? "true" : "false"} connected=${this.state.connected ? "true" : "false"} hasSocket=${this.sock ? "true" : "false"}`,
    );
    
    // If already connected, return success
    if (this.state.connected && this.sock) {
      console.log(`[whatsapp.do:${traceId}] handleLogin already connected`);
      return Response.json({ connected: true, message: "Already connected" });
    }

    // Only clear auth if explicitly requested with force=true
    // This prevents rate-limiting issues from repeated new device pairing attempts
    const hasAuth = await hasAuthState(this.ctx.storage);
    this.lifecycle.assertActive(epoch);
    console.log(`[whatsapp.do:${traceId}] handleLogin hasAuth=${hasAuth ? "true" : "false"}`);
    if (force && hasAuth) {
      console.log(`[WA] Force login: clearing existing auth state`);
      await clearAuthState(this.ctx.storage);
      this.lifecycle.assertActive(epoch);
    }

    // Mark login as pending BEFORE starting socket
    // This prevents alarm from interfering with the login flow
    await this.ctx.storage.put("login_pending", Date.now());
    this.lifecycle.assertActive(epoch);
    
    // Start the socket
    if (!this.sock) {
      console.log(`[whatsapp.do:${traceId}] handleLogin starting socket`);
      await this.startSocket(epoch);
    }

    // Wait for QR code to be generated (60s to allow time for scanning)
    const result = await this.waitForQrOrConnection(60000);
    this.lifecycle.assertActive(epoch);
    console.log(
      `[whatsapp.do:${traceId}] handleLogin wait result connected=${result.connected ? "true" : "false"} qr=${result.qr ? "true" : "false"}`,
    );
    
    if (result.connected) {
      // Login succeeded - clear pending flag and schedule keep-alive
      await this.ctx.storage.delete("login_pending");
      await this.scheduleKeepAlive(epoch);
      return Response.json({ connected: true, message: "Connected" });
    }
    
    if (result.qr) {
      // Schedule alarm to keep DO alive during QR scan window
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      
      return Response.json({ 
        connected: false, 
        qr: result.qr,
        message: "Scan QR code with WhatsApp" 
      });
    }

    // Login failed - clear pending flag
    await this.ctx.storage.delete("login_pending");
    return Response.json({ 
      connected: false, 
      message: "Failed to get QR code" 
    }, { status: 500 });
  }

  private async handleLogout(): Promise<Response> {
    const epoch = this.lifecycle.activeEpoch();
    console.log(`[WA] Logout requested`);
    
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    await clearAuthState(this.ctx.storage);
    this.lifecycle.assertActive(epoch);
    await this.ctx.storage.delete("login_pending");
    
    this.state = {
      accountId: this.state.accountId,
      connected: false,
    };

    console.log(`[WA] Logged out successfully`);
    return Response.json({ success: true, message: "Logged out" });
  }

  private async handleStop(): Promise<Response> {
    const epoch = this.lifecycle.activeEpoch();
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    this.state.connected = false;
    this.state.lastDisconnectedAt = Date.now();

    // Notify Gateway of status change
    await this.notifyGatewayStatus(epoch);

    return Response.json({ success: true, message: "Stopped" });
  }

  private async handleWake(): Promise<Response> {
    const epoch = this.lifecycle.activeEpoch();
    const actions: string[] = [];
    
    const hasAuth = await hasAuthState(this.ctx.storage);
    this.lifecycle.assertActive(epoch);
    if (!hasAuth) {
      return Response.json({ 
        success: false, 
        message: "No auth credentials. Call /login first.",
        actions,
      }, { status: 400 });
    }

    // Check WhatsApp connection
    if (!this.sock || !this.state.connected) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Wake: Reconnecting...`);
      actions.push("reconnecting_whatsapp");
      await this.startSocket(epoch);
      await new Promise(resolve => setTimeout(resolve, 3000));
      this.lifecycle.assertActive(epoch);
    } else {
      actions.push("whatsapp_already_connected");
    }

    return Response.json({
      success: true,
      message: "Wake complete",
      actions,
      status: {
        whatsappConnected: this.state.connected,
        selfJid: this.state.selfJid,
      },
    });
  }

  /**
   * Handle outbound message from Gateway (via WorkerEntrypoint)
   */
  private async handleSend(request: Request): Promise<Response> {
    const epoch = this.lifecycle.activeEpoch();
    if (!this.sock || !this.state.connected) {
      return Response.json({ error: "Not connected" }, { status: 503 });
    }

    const message = await request.json() as ChannelOutboundMessage;
    const jid = await this.resolveOutboundWhatsAppJid(message.peer.id, epoch);
    this.lifecycle.assertActive(epoch);

    try {
      const content = this.buildOutboundContent(message);
      const sent = await this.sock.sendMessage(jid, content);
      this.lifecycle.assertActive(epoch);
      console.log(`[WA] Sent to ${jid}: "${message.text.substring(0, 50)}..."`);
      return Response.json({ success: true, messageId: sent?.key?.id });
    } catch (e) {
      console.error(`[WA] Send failed:`, e);
      return Response.json({ success: false, error: String(e) }, { status: 500 });
    }
  }

  /**
   * Handle explicit reaction from adapter shell.
   */
  private async handleReact(request: Request): Promise<Response> {
    const epoch = this.lifecycle.activeEpoch();
    if (!this.sock || !this.state.connected) {
      return Response.json({ error: "Not connected" }, { status: 503 });
    }

    const body = await request.json() as {
      peer: ChannelPeer;
      messageId: string;
      emoji: string;
      participant?: string;
    };

    if (!body.peer?.id || !body.messageId || typeof body.emoji !== "string") {
      return Response.json(
        { success: false, error: "peer.id, messageId, and emoji are required" },
        { status: 400 },
      );
    }

    const remote = await this.resolveOutboundMessageKeyJid(body.peer.id, epoch);
    this.lifecycle.assertActive(epoch);
    const jid = remote.jid;
    const key: WAMessageKey = {
      remoteJid: jid,
      id: body.messageId,
      fromMe: false,
    };
    if (remote.alt) {
      key.remoteJidAlt = remote.alt;
    }
    if (body.participant) {
      const participant = await this.resolveOutboundMessageKeyJid(body.participant, epoch);
      key.participant = participant.jid;
      if (participant.alt) {
        key.participantAlt = participant.alt;
      }
    }

    try {
      await this.sock.sendMessage(jid, {
        react: {
          text: body.emoji,
          key,
        },
      });
      this.lifecycle.assertActive(epoch);
      return Response.json({ success: true });
    } catch (e) {
      console.error(`[WA] React failed:`, e);
      return Response.json({ success: false, error: String(e) }, { status: 500 });
    }
  }

  /**
   * Handle typing indicator from Gateway
   */
  private async handleTyping(request: Request): Promise<Response> {
    const epoch = this.lifecycle.activeEpoch();
    if (!this.sock || !this.state.connected) {
      return Response.json({ error: "Not connected" }, { status: 503 });
    }

    const { peer, typing } = await request.json() as { peer: ChannelPeer; typing: boolean };
    const jid = await this.resolveOutboundWhatsAppJid(peer.id, epoch);
    this.lifecycle.assertActive(epoch);

    try {
      const presence = typing ? "composing" : "paused";
      await this.sock.sendPresenceUpdate(presence, jid);
      this.lifecycle.assertActive(epoch);
      return Response.json({ ok: true });
    } catch (e) {
      // Typing is best-effort
      return Response.json({ ok: true });
    }
  }

  private buildOutboundContent(message: ChannelOutboundMessage): AnyMessageContent {
    const media = message.media?.[0];
    if (media) {
      return this.buildMediaContent(media, message.text);
    }

    const text = message.text.trim();
    if (!text) {
      throw new Error("WhatsApp messages require text or media");
    }
    return { text };
  }

  private buildMediaContent(media: ChannelMedia, captionText: string): AnyMessageContent {
    const upload = this.buildMediaUpload(media);
    const caption = captionText.trim() || undefined;

    switch (media.type) {
      case "image":
        return {
          image: upload,
          mimetype: media.mimeType,
          ...(caption ? { caption } : {}),
        };
      case "video":
        return {
          video: upload,
          mimetype: media.mimeType,
          ...(caption ? { caption } : {}),
        };
      case "audio":
        return {
          audio: upload,
          mimetype: media.mimeType,
        };
      case "document":
      default:
        return {
          document: upload,
          mimetype: media.mimeType || "application/octet-stream",
          fileName: media.filename || "attachment",
          ...(caption ? { caption } : {}),
        };
    }
  }

  private buildMediaUpload(media: ChannelMedia): Buffer | { url: string } {
    if (media.url) {
      return { url: media.url };
    }
    if (media.data) {
      return Buffer.from(base64Payload(media.data), "base64");
    }
    throw new Error("Media attachment must include base64 data or url");
  }

  private async resolveOutboundWhatsAppJid(
    jidOrPhone: string,
    epoch: number,
  ): Promise<string> {
    const jid = normalizeOutboundWhatsAppJid(jidOrPhone);
    if (!isPnWhatsAppJid(jid)) {
      return jid;
    }

    const lid = await this.lookupLidForPN(jid, epoch);
    return lid ?? jid;
  }

  private async resolveOutboundMessageKeyJid(
    jidOrPhone: string,
    epoch: number,
  ): Promise<{ jid: string; alt?: string }> {
    const jid = normalizeOutboundWhatsAppJid(jidOrPhone);
    if (!isPnWhatsAppJid(jid)) {
      return { jid };
    }

    const lid = await this.lookupLidForPN(jid, epoch);
    return lid ? { jid: lid, alt: jid } : { jid };
  }

  private async startSocket(epoch: number): Promise<void> {
    this.lifecycle.assertActive(epoch);
    const { state: authState, saveCreds } = await useDOAuthState(
      this.ctx.storage,
      () => this.lifecycle.isActive(epoch),
    );
    this.lifecycle.assertActive(epoch);
    const { version } = await fetchLatestBaileysVersion();
    this.lifecycle.assertActive(epoch);

    const socket = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, noopLogger),
      },
      version,
      logger: noopLogger,
      printQRInTerminal: false,
      browser: ["GSV Channel", "Desktop", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    if (!this.lifecycle.isActive(epoch)) {
      socket.end(new Error("Managed lifecycle changed while opening socket"));
      this.lifecycle.assertActive(epoch);
    }
    this.sock = socket;

    socket.ev.on("creds.update", () => {
      if (!this.isCurrentSocket(epoch, socket)) return;
      saveCreds().catch((e) => {
        console.error(`[WA:${this.state.accountId}] Credential update failed:`, e);
      });
    });
    socket.ev.on("connection.update", (update) => {
      this.handleConnectionUpdate(update, epoch, socket).catch((e) => {
        console.error(`[WA:${this.state.accountId}] Connection update failed:`, e);
      });
    });
    socket.ev.on("lid-mapping.update", (mapping) => {
      if (!this.isCurrentSocket(epoch, socket)) return;
      this.rememberLidPnMapping(mapping, epoch).catch((e) => {
        console.error(`[WA:${this.state.accountId}] LID mapping update failed:`, e);
      });
    });
    socket.ev.on("messaging-history.set", ({ lidPnMappings }) => {
      if (!this.isCurrentSocket(epoch, socket)) return;
      this.rememberLidPnMappings(lidPnMappings, epoch).catch((e) => {
        console.error(`[WA:${this.state.accountId}] History LID mappings update failed:`, e);
      });
    });
    socket.ev.on("messages.upsert", (m) => {
      if (!this.isCurrentSocket(epoch, socket)) return;
      this.handleMessagesUpsert(m, epoch, socket).catch((e) => {
        console.error(`[WA:${this.state.accountId}] Message handling error:`, e);
      });
    });
  }

  private isCurrentSocket(epoch: number, socket: WASocket): boolean {
    return this.lifecycle.isActive(epoch) && this.sock === socket;
  }

  private async handleConnectionUpdate(
    update: Partial<BaileysEventMap["connection.update"]>,
    epoch: number,
    socket: WASocket,
  ): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;
    const { connection, lastDisconnect, qr } = update;
    const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
    console.log(
      `[WA:${this.state.accountId}] connection.update connection=${connection ?? "none"} qr=${qr ? "true" : "false"} statusCode=${statusCode ?? "none"}`,
    );

    if (qr) {
      this.qrCode = qr;
      console.log(`[WA:${this.state.accountId}] QR received`);
      this.resolveWaiters({ qr });
    }

    if (connection === "open") {
      if (!this.isCurrentSocket(epoch, socket)) return;
      this.state.connected = true;
      this.state.lastConnectedAt = Date.now();
      this.state.selfJid = this.sock?.user?.id;
      
      if (this.state.selfJid) {
        const match = this.state.selfJid.match(/^(\d+)(?::\d+)?@/);
        if (match) {
          this.state.selfE164 = `+${match[1]}`;
        }
      }
      
      await this.ctx.storage.delete("login_pending");
      if (!this.isCurrentSocket(epoch, socket)) return;
      console.log(`[WA:${this.state.accountId}] Connected as ${this.state.selfE164 || this.state.selfJid}`);
      this.resolveWaiters({ connected: true });
      
      await this.notifyGatewayStatus(epoch);
      if (this.isCurrentSocket(epoch, socket)) {
        await this.scheduleKeepAlive(epoch);
      }
    }

    if (connection === "close") {
      if (!this.isCurrentSocket(epoch, socket)) return;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isConnectionReplaced = statusCode === 515;
      
      this.state.connected = false;
      this.state.lastDisconnectedAt = Date.now();
      this.sock = null;
      this.resolveWaiters({});

      if (isLoggedOut) {
        this.state.selfJid = undefined;
        this.state.selfE164 = undefined;
        await clearAuthState(this.ctx.storage);
        if (!this.lifecycle.isActive(epoch)) return;
        await this.ctx.storage.delete("login_pending");
      } else if (isConnectionReplaced) {
        await this.ctx.storage.delete("login_pending");
      } else {
        await this.ctx.storage.setAlarm(Date.now() + 5000);
      }

      if (this.lifecycle.isActive(epoch)) {
        await this.notifyGatewayStatus(epoch);
      }
    }
  }

  private async handleMessagesUpsert(
    m: BaileysEventMap["messages.upsert"],
    epoch: number,
    socket: WASocket,
  ): Promise<void> {
    if (!this.isCurrentSocket(epoch, socket)) return;
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (!this.isCurrentSocket(epoch, socket)) return;
      if (msg.key.fromMe) continue;

      const extracted = extractMessageContent(msg.message);
      const contentType = extracted ? getContentType(extracted) : undefined;
      const hasMedia = !!contentType && MEDIA_CONTENT_TYPES.has(contentType);

      const extractedMedia = (hasMedia && extracted && contentType)
        ? (extracted as Record<string, unknown>)[contentType] as
            | { caption?: string; text?: string }
            | undefined
        : undefined;

      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text ||
                   extractedMedia?.caption ||
                   extractedMedia?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption ||
                   (hasMedia ? "" : undefined);
      
      if (text === undefined) continue;

      const remoteJid = normalizeWhatsAppJid(msg.key.remoteJid);
      if (!remoteJid) continue;
      const remoteJidAlt = normalizeWhatsAppJid(msg.key.remoteJidAlt);
      const isGroup = remoteJid.endsWith("@g.us");
      const dmPn = preferredPnJid(remoteJid, remoteJidAlt);
      const deliveryJid = isGroup ? remoteJid : preferredLidJid(remoteJid, remoteJidAlt) ?? remoteJid;
      const surfaceJid = isGroup ? remoteJid : dmPn ?? remoteJid;
      const participantJid = preferredLidJid(msg.key.participant, msg.key.participantAlt);
      const participantPn = preferredPnJid(msg.key.participant, msg.key.participantAlt);
      const actorId = isGroup
          ? await this.resolveStableWhatsAppActorId(
            participantJid,
            participantPn,
            epoch,
          )
        : await this.resolveStableWhatsAppActorId(
            deliveryJid,
            dmPn,
            epoch,
          );
      if (!this.isCurrentSocket(epoch, socket)) return;
      if (!actorId) continue;

      // Download media if present
      const media: MediaAttachment[] = [];
      if (hasMedia) {
        try {
          const attachment = await this.downloadMedia(msg);
          if (!this.isCurrentSocket(epoch, socket)) return;
          if (attachment) {
            media.push(attachment);
          }
        } catch (e) {
          console.error(`[WA:${this.state.accountId}] Media download failed:`, e);
        }
      }
      if (!this.isCurrentSocket(epoch, socket)) return;

      // Build inbound message for Gateway
      const inbound: AdapterInboundMessage = {
        messageId: msg.key.id!,
        surface: {
          kind: isGroup ? "group" : "dm",
          id: surfaceJid,
          name: msg.pushName ?? undefined,
        },
        actor: {
          id: actorId,
          name: msg.pushName ?? undefined,
          handle: actorId,
        },
        text: text || (media.length > 0 ? "[Media]" : hasMedia ? "[Media unavailable]" : ""),
        media: media.length > 0 ? media : undefined,
        replyToId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
        timestamp: msg.messageTimestamp as number,
      };
      console.log(
        `[WA:${this.state.accountId}] inbound actorId=${actorId} surfaceJid=${surfaceJid} deliveryJid=${deliveryJid} remoteJid=${remoteJid} remoteJidAlt=${remoteJidAlt ?? ""} participant=${participantJid ?? ""} participantPn=${participantPn ?? ""}`,
      );

      try {
        const result = await this.callGateway<AdapterInboundResult>(
          "adapter.inbound",
          {
            adapter: "whatsapp",
            accountId: this.state.accountId,
            message: inbound,
          },
        );
        if (!this.isCurrentSocket(epoch, socket)) return;
        if (!result.ok) {
          console.error(
            `[WA:${this.state.accountId}] Gateway RPC inbound rejected: ${result.error || "unknown error"}`,
          );
          continue;
        }
        if (result.challenge?.prompt && !isGroup && this.isCurrentSocket(epoch, socket)) {
          try {
            await socket.sendMessage(deliveryJid, { text: result.challenge.prompt });
            if (!this.isCurrentSocket(epoch, socket)) return;
          } catch (err) {
            console.error(`[WA:${this.state.accountId}] Failed to send challenge prompt:`, err);
          }
        }
        if (result.reply?.text && !isGroup && this.isCurrentSocket(epoch, socket)) {
          try {
            await socket.sendMessage(deliveryJid, { text: result.reply.text });
            if (!this.isCurrentSocket(epoch, socket)) return;
          } catch (err) {
            console.error(`[WA:${this.state.accountId}] Failed to send gateway reply:`, err);
          }
        }
        if (!this.isCurrentSocket(epoch, socket)) return;
        this.state.lastMessageAt = Date.now();
      } catch (e) {
        console.error(`[WA:${this.state.accountId}] Gateway RPC inbound failed:`, e);
      }
    }
  }

  private async resolveStableWhatsAppActorId(
    jid: string | null | undefined,
    alternatePnJid?: string,
    epoch?: number,
  ): Promise<string | null> {
    if (epoch !== undefined) this.lifecycle.assertActive(epoch);
    const normalizedJid = normalizeWhatsAppJid(jid);
    if (!normalizedJid) return null;

    const phoneDigits = phoneDigitsFromJid(alternatePnJid) ?? phoneDigitsFromJid(normalizedJid);
    if (phoneDigits) {
      const canonical = phoneActorId(phoneDigits);
      await this.rememberActorAlias(jidActorId(normalizedJid), canonical, epoch);
      await this.rememberLidAliasForPhone(phoneDigits, canonical, epoch);
      return canonical;
    }

    const rawActorId = jidActorId(normalizedJid);
    const aliased = await this.lookupActorAlias(rawActorId, epoch);
    return aliased ?? rawActorId;
  }

  private async rememberLidAliasForPhone(
    phoneDigits: string,
    canonicalActorId: string,
    epoch?: number,
  ): Promise<void> {
    const lid = await this.lookupLidForPN(`${phoneDigits}@s.whatsapp.net`, epoch);
    if (!lid) return;
    await this.rememberActorAlias(jidActorId(lid), canonicalActorId, epoch);
  }

  private async lookupLidForPN(pnJid: string, epoch?: number): Promise<string | null> {
    if (epoch !== undefined) this.lifecycle.assertActive(epoch);
    if (!this.sock) return null;

    const normalizedPn = normalizeWhatsAppJid(pnJid);
    if (!isPnWhatsAppJid(normalizedPn)) return null;

    try {
      const lid = await this.sock.signalRepository.lidMapping.getLIDForPN(normalizedPn);
      if (epoch !== undefined) this.lifecycle.assertActive(epoch);
      const normalizedLid = normalizeWhatsAppJid(lid);
      if (!isLidWhatsAppJid(normalizedLid)) return null;
      await this.rememberLidPnMapping({ pn: normalizedPn, lid: normalizedLid }, epoch);
      return normalizedLid;
    } catch (error) {
      console.warn(`[WA:${this.state.accountId}] Failed to resolve LID for ${normalizedPn}`, error);
      return null;
    }
  }

  private async rememberLidPnMappings(
    mappings: LIDMapping[] | undefined,
    epoch?: number,
  ): Promise<void> {
    if (!mappings?.length) return;
    await Promise.all(
      mappings.map((mapping) => this.rememberLidPnMapping(mapping, epoch)),
    );
  }

  private async rememberLidPnMapping(mapping: LIDMapping, epoch?: number): Promise<void> {
    if (epoch !== undefined) this.lifecycle.assertActive(epoch);
    const pn = normalizeWhatsAppJid(mapping.pn);
    const lid = normalizeWhatsAppJid(mapping.lid);
    if (!isPnWhatsAppJid(pn) || !isLidWhatsAppJid(lid)) return;

    const phoneDigits = phoneDigitsFromJid(pn);
    const canonicalActorId = phoneDigits ? phoneActorId(phoneDigits) : jidActorId(pn);
    await this.rememberActorAlias(jidActorId(lid), canonicalActorId, epoch);
  }

  private async rememberActorAlias(
    aliasActorId: string,
    canonicalActorId: string,
    epoch?: number,
  ): Promise<void> {
    if (epoch !== undefined) this.lifecycle.assertActive(epoch);
    if (!aliasActorId || !canonicalActorId || aliasActorId === canonicalActorId) return;
    await this.ctx.storage.put(`actor_alias:${aliasActorId}`, canonicalActorId);
  }

  private async lookupActorAlias(aliasActorId: string, epoch?: number): Promise<string | null> {
    if (epoch !== undefined) this.lifecycle.assertActive(epoch);
    const alias = await this.ctx.storage.get<string>(`actor_alias:${aliasActorId}`);
    if (epoch !== undefined) this.lifecycle.assertActive(epoch);
    return typeof alias === "string" && alias.trim().length > 0 ? alias : null;
  }

  /**
   * Download media from a WhatsApp message
   */
  private async downloadMedia(msg: WAMessage): Promise<MediaAttachment | null> {
    if (!this.sock) return null;

    const mContent = extractMessageContent(msg.message);
    if (!mContent) return null;

    const contentType = getContentType(mContent);
    if (!contentType) return null;

    let mediaType: MediaAttachment["type"];
    let mimeType: string;
    let filename: string | undefined;
    let baileysMediaType: string;

    const mediaNode = (mContent as Record<string, unknown>)[contentType] as
      | {
          mimetype?: string;
          caption?: string;
          fileName?: string;
          url?: string;
          directPath?: string;
          mediaKey?: Uint8Array | Buffer;
          fileLength?: number;
        }
      | undefined;

    if (!mediaNode || typeof mediaNode !== "object") return null;

    if (contentType === "imageMessage") {
      mediaType = "image";
      mimeType = mediaNode.mimetype || "image/jpeg";
      filename = mediaNode.caption ?? undefined;
      baileysMediaType = "image";
    } else if (contentType === "videoMessage") {
      mediaType = "video";
      mimeType = mediaNode.mimetype || "video/mp4";
      filename = mediaNode.caption ?? undefined;
      baileysMediaType = "video";
    } else if (contentType === "audioMessage") {
      mediaType = "audio";
      mimeType = mediaNode.mimetype || "audio/ogg";
      baileysMediaType = "audio";
    } else if (contentType === "documentMessage") {
      mediaType = "document";
      mimeType = mediaNode.mimetype || "application/octet-stream";
      filename = mediaNode.fileName ?? undefined;
      baileysMediaType = "document";
    } else {
      return null;
    }

    const media = mediaNode;

    if (!media || typeof media !== "object") return null;
    if (!media.url && !media.directPath) return null;
    if (!media.mediaKey) return null;

    const isValidMediaUrl = media.url?.startsWith("https://mmg.whatsapp.net/");
    const downloadUrl = isValidMediaUrl ? media.url : getUrlFromDirectPath(media.directPath!);
    if (!downloadUrl) return null;

    const keys = await getMediaKeys(media.mediaKey, baileysMediaType as any);

    const response = await fetch(downloadUrl, {
      headers: { Origin: "https://web.whatsapp.com" },
    });

    if (!response.ok) {
      throw new Error(`Media download failed: HTTP ${response.status}`);
    }

    const encryptedData = new Uint8Array(await response.arrayBuffer());
    const ciphertext = encryptedData.slice(0, -10);

    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keys.cipherKey,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: keys.iv },
      cryptoKey,
      ciphertext
    );

    const decryptedArray = new Uint8Array(decrypted);
    const base64 = uint8ArrayToBase64(decryptedArray);

    return {
      type: mediaType,
      mimeType,
      data: base64,
      filename,
      size: decryptedArray.byteLength,
    };
  }

  /**
   * Notify Gateway of status change via Service Binding RPC.
   */
  private async notifyGatewayStatus(epoch: number): Promise<void> {
    if (!this.lifecycle.isActive(epoch)) return;
    if (!this.state.accountId) return;
    
    try {
      const status: ChannelAccountStatus = {
        accountId: this.state.accountId,
        connected: this.state.connected,
        authenticated: !!this.state.selfJid,
        mode: "websocket",
        lastActivity: this.state.lastMessageAt,
        extra: { selfJid: this.state.selfJid, selfE164: this.state.selfE164 },
      };

      await this.callGateway(
        "adapter.state.update",
        {
          adapter: "whatsapp",
          accountId: this.state.accountId,
          status,
        },
      );
      this.lifecycle.assertActive(epoch);
    } catch (e) {
      // Status updates are best-effort.
      console.error(`[WA:${this.state.accountId}] Gateway RPC status failed:`, e);
    }
  }

  private async callGateway<T = unknown>(call: string, args: unknown): Promise<T> {
    const frame: GatewayRequestFrame = {
      type: "req",
      id: crypto.randomUUID(),
      call,
      args,
    };

    const response = await this.env.GATEWAY.serviceFrame(frame);
    if (!response || response.type !== "res") {
      throw new Error("No response from gateway serviceFrame");
    }
    if (!response.ok) {
      throw new Error(response.error?.message || `Gateway error on ${call}`);
    }

    return (response.data ?? {}) as T;
  }

  private waitForQrOrConnection(timeoutMs: number): Promise<{ connected?: boolean; qr?: string }> {
    return new Promise((resolve) => {
      if (this.state.connected) {
        resolve({ connected: true });
        return;
      }

      if (this.qrCode) {
        resolve({ qr: this.qrCode });
        return;
      }

      const timeout = setTimeout(() => {
        console.warn(`[WA:${this.state.accountId}] waitForQrOrConnection timed out after ${timeoutMs}ms`);
        resolve({});
      }, timeoutMs);

      this.waitResolvers.push((result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    });
  }

  private resolveWaiters(result: { connected?: boolean; qr?: string }): void {
    if (this.waitResolvers.length === 0) return;
    const waiters = this.waitResolvers;
    this.waitResolvers = [];
    for (const resolve of waiters) {
      resolve(result);
    }
  }

  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000;

  private async scheduleKeepAlive(epoch: number): Promise<void> {
    this.lifecycle.assertActive(epoch);
    await this.ctx.storage.setAlarm(
      Date.now() + WhatsAppAccount.KEEP_ALIVE_INTERVAL_MS,
    );
  }

  async alarm(): Promise<void> {
    const epoch = this.lifecycle.activeEpoch();
    const hasAuth = await hasAuthState(this.ctx.storage);
    this.lifecycle.assertActive(epoch);
    const loginPending = await this.ctx.storage.get<number>("login_pending");
    this.lifecycle.assertActive(epoch);
    
    // Keep alive during login flow
    if (loginPending && Date.now() - loginPending < 90000) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    
    if (loginPending) {
      await this.ctx.storage.delete("login_pending");
    }

    if (!hasAuth) return;

    await this.scheduleKeepAlive(epoch);

    // Reconnect if needed
    if (!this.sock) {
      try {
        await this.startSocket(epoch);
      } catch (e) {
        console.error(`[WA:${this.state.accountId}] Reconnect failed:`, e);
      }
    }
  }
}
