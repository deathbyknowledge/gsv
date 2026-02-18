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
  type WASocket,
  type BaileysEventMap,
  type WAMessage,
} from "@whiskeysockets/baileys";
import {
  getMediaKeys,
  getUrlFromDirectPath,
} from "@whiskeysockets/baileys/lib/Utils/messages-media";
import { useDOAuthState, clearAuthState, hasAuthState } from "./auth-store";
import type {
  WhatsAppAccountState,
  PeerInfo,
  MediaAttachment,
} from "./types";
import type {
  ChannelInboundMessage,
  ChannelOutboundMessage,
  ChannelPeer,
  ChannelAccountStatus,
} from "./channel-types";

type GatewayChannelBinding = Fetcher & {
  channelInbound: (
    channelId: string,
    accountId: string,
    message: ChannelInboundMessage,
  ) => Promise<{ ok: boolean; sessionKey?: string; status?: string; error?: string }>;
  channelStatusChanged: (
    channelId: string,
    accountId: string,
    status: ChannelAccountStatus,
  ) => Promise<void>;
};

interface Env {
  // Direct service binding to Gateway entrypoint.
  GATEWAY: GatewayChannelBinding;
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

export class WhatsAppAccount extends DurableObject<Env> {
  private sock: WASocket | null = null;
  private state: WhatsAppAccountState = {
    accountId: "",
    connected: false,
  };
  private qrCode: string | null = null;
  private qrResolvers: Array<(qr: string) => void> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // accountId is set from X-Account-Id header on first request
    // and persisted in storage.kv for subsequent requests
    const storedAccountId = this.ctx.storage.kv.get<string>("accountId");
    this.state.accountId = storedAccountId || "";
  }

  /**
   * HTTP fetch handler - internal API for WhatsAppChannel entrypoint
   */
  async fetch(request: Request): Promise<Response> {
    // Ensure accountId is set from header (required on all requests)
    const headerAccountId = request.headers.get("X-Account-Id");
    if (headerAccountId && !this.state.accountId) {
      this.state.accountId = headerAccountId;
      this.ctx.storage.kv.put("accountId", headerAccountId);
      console.log(`[WA] Set accountId from header: ${headerAccountId}`);
    }
    
    if (!this.state.accountId) {
      return Response.json({ error: "Missing X-Account-Id header" }, { status: 400 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/status":
          return this.handleStatus();
        case "/login":
          return await this.handleLogin(url, request.method === "POST");
        case "/logout":
          return await this.handleLogout();
        case "/stop":
          return await this.handleStop();
        case "/wake":
          return await this.handleWake();
        case "/send":
          return await this.handleSend(request);
        case "/typing":
          return await this.handleTyping(request);
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
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
    });
  }

  private async handleLogin(url: URL, isPost: boolean): Promise<Response> {
    const force = url.searchParams.get("force") === "true";
    
    // If already connected, return success
    if (this.state.connected && this.sock) {
      return Response.json({ connected: true, message: "Already connected" });
    }

    // Only clear auth if explicitly requested with force=true
    // This prevents rate-limiting issues from repeated new device pairing attempts
    const hasAuth = await hasAuthState(this.ctx.storage);
    if (force && hasAuth) {
      console.log(`[WA] Force login: clearing existing auth state`);
      await clearAuthState(this.ctx.storage);
    }

    // Mark login as pending BEFORE starting socket
    // This prevents alarm from interfering with the login flow
    await this.ctx.storage.put("login_pending", Date.now());
    
    // Start the socket
    if (!this.sock) {
      await this.startSocket();
    }

    // Wait for QR code to be generated (60s to allow time for scanning)
    const result = await this.waitForQrOrConnection(60000);
    
    if (result.connected) {
      // Login succeeded - clear pending flag and schedule keep-alive
      await this.ctx.storage.delete("login_pending");
      this.ctx.storage.setAlarm(Date.now() + 10000);
      return Response.json({ connected: true, message: "Connected" });
    }
    
    if (result.qr) {
      // Schedule alarm to keep DO alive during QR scan window
      this.ctx.storage.setAlarm(Date.now() + 5000);
      
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
    console.log(`[WA] Logout requested`);
    
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    await clearAuthState(this.ctx.storage);
    await this.ctx.storage.delete("login_pending");
    
    this.state = {
      accountId: this.state.accountId,
      connected: false,
    };

    console.log(`[WA] Logged out successfully`);
    return Response.json({ success: true, message: "Logged out" });
  }

  private async handleStop(): Promise<Response> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    this.state.connected = false;
    this.state.lastDisconnectedAt = Date.now();

    // Notify Gateway of status change
    await this.notifyGatewayStatus();

    return Response.json({ success: true, message: "Stopped" });
  }

  private async handleWake(): Promise<Response> {
    const actions: string[] = [];
    
    const hasAuth = await hasAuthState(this.ctx.storage);
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
      await this.startSocket();
      await new Promise(resolve => setTimeout(resolve, 3000));
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
    if (!this.sock || !this.state.connected) {
      return Response.json({ error: "Not connected" }, { status: 503 });
    }

    const message = await request.json() as ChannelOutboundMessage;
    
    // Convert peer ID to WhatsApp JID format
    let jid = message.peer.id;
    if (jid.startsWith("+") && !jid.includes("@")) {
      jid = `${jid.slice(1)}@s.whatsapp.net`;
    }

    try {
      const sent = await this.sock.sendMessage(jid, { text: message.text });
      console.log(`[WA] Sent to ${jid}: "${message.text.substring(0, 50)}..."`);
      return Response.json({ messageId: sent?.key?.id });
    } catch (e) {
      console.error(`[WA] Send failed:`, e);
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }

  /**
   * Handle typing indicator from Gateway
   */
  private async handleTyping(request: Request): Promise<Response> {
    if (!this.sock || !this.state.connected) {
      return Response.json({ error: "Not connected" }, { status: 503 });
    }

    const { peer, typing } = await request.json() as { peer: ChannelPeer; typing: boolean };
    
    let jid = peer.id;
    if (jid.startsWith("+") && !jid.includes("@")) {
      jid = `${jid.slice(1)}@s.whatsapp.net`;
    }

    try {
      const presence = typing ? "composing" : "paused";
      await this.sock.sendPresenceUpdate(presence, jid);
      return Response.json({ ok: true });
    } catch (e) {
      // Typing is best-effort
      return Response.json({ ok: true });
    }
  }

  private async startSocket(): Promise<void> {
    const { state: authState, saveCreds } = await useDOAuthState(this.ctx.storage);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
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

    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(update));
    this.sock.ev.on("messages.upsert", (m) => {
      this.handleMessagesUpsert(m).catch((e) => {
        console.error(`[WA:${this.state.accountId}] Message handling error:`, e);
      });
    });
  }

  private handleConnectionUpdate(update: Partial<BaileysEventMap["connection.update"]>): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrCode = qr;
      for (const resolve of this.qrResolvers) {
        resolve(qr);
      }
      this.qrResolvers = [];
    }

    if (connection === "open") {
      this.state.connected = true;
      this.state.lastConnectedAt = Date.now();
      this.state.selfJid = this.sock?.user?.id;
      
      if (this.state.selfJid) {
        const match = this.state.selfJid.match(/^(\d+)(?::\d+)?@/);
        if (match) {
          this.state.selfE164 = `+${match[1]}`;
        }
      }
      
      this.ctx.storage.delete("login_pending").catch(() => {});
      console.log(`[WA:${this.state.accountId}] Connected as ${this.state.selfE164 || this.state.selfJid}`);
      
      this.notifyGatewayStatus().catch(() => {});
      this.scheduleKeepAlive();
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isConnectionReplaced = statusCode === 515;
      
      this.state.connected = false;
      this.state.lastDisconnectedAt = Date.now();
      this.sock = null;

      this.notifyGatewayStatus().catch(() => {});

      if (isLoggedOut) {
        clearAuthState(this.ctx.storage);
        this.ctx.storage.delete("login_pending").catch(() => {});
      } else if (isConnectionReplaced) {
        this.ctx.storage.delete("login_pending").catch(() => {});
      } else {
        this.ctx.storage.setAlarm(Date.now() + 5000);
      }
    }
  }

  private async handleMessagesUpsert(m: BaileysEventMap["messages.upsert"]): Promise<void> {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
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

      const remoteJid = msg.key.remoteJid!;
      const isGroup = remoteJid.endsWith("@g.us");
      const isLid = remoteJid.endsWith("@lid");
      
      let senderId: string | undefined;
      if (isLid && msg.key.senderPn) {
        const senderPn = msg.key.senderPn as string;
        const match = senderPn.match(/^(\d+)@/);
        if (match) {
          senderId = `+${match[1]}`;
        }
      }
      
      const peer: PeerInfo = {
        kind: isGroup ? "group" : "dm",
        id: remoteJid,
        name: msg.pushName ?? undefined,
      };

      // Download media if present
      const media: MediaAttachment[] = [];
      if (hasMedia) {
        try {
          const attachment = await this.downloadMedia(msg);
          if (attachment) {
            media.push(attachment);
          }
        } catch (e) {
          console.error(`[WA:${this.state.accountId}] Media download failed:`, e);
        }
      }

      // Build inbound message for Gateway
      const inbound: ChannelInboundMessage = {
        messageId: msg.key.id!,
        peer: {
          kind: peer.kind,
          id: peer.id,
          name: peer.name,
        },
        sender: isGroup ? {
          id: msg.key.participant!,
          name: msg.pushName ?? undefined,
        } : (senderId ? {
          id: senderId,
          name: msg.pushName ?? undefined,
        } : undefined),
        text: text || (media.length > 0 ? "[Media]" : hasMedia ? "[Media unavailable]" : ""),
        media: media.length > 0 ? media : undefined,
        replyToId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
        timestamp: msg.messageTimestamp as number,
      };

      try {
        const result = await this.env.GATEWAY.channelInbound(
          "whatsapp",
          this.state.accountId,
          inbound,
        );
        if (!result.ok) {
          console.error(
            `[WA:${this.state.accountId}] Gateway RPC inbound rejected: ${result.error || "unknown error"}`,
          );
          continue;
        }
        this.state.lastMessageAt = Date.now();
      } catch (e) {
        console.error(`[WA:${this.state.accountId}] Gateway RPC inbound failed:`, e);
      }
    }
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
  private async notifyGatewayStatus(): Promise<void> {
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

      await this.env.GATEWAY.channelStatusChanged(
        "whatsapp",
        this.state.accountId,
        status,
      );
    } catch (e) {
      // Status updates are best-effort.
      console.error(`[WA:${this.state.accountId}] Gateway RPC status failed:`, e);
    }
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

      const timeout = setTimeout(() => resolve({}), timeoutMs);

      this.qrResolvers.push((qr) => {
        clearTimeout(timeout);
        resolve({ qr });
      });
    });
  }

  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000;

  private scheduleKeepAlive(): void {
    this.ctx.storage.setAlarm(Date.now() + WhatsAppAccount.KEEP_ALIVE_INTERVAL_MS);
  }

  async alarm(): Promise<void> {
    const hasAuth = await hasAuthState(this.ctx.storage);
    const loginPending = await this.ctx.storage.get<number>("login_pending");
    
    // Keep alive during login flow
    if (loginPending && Date.now() - loginPending < 90000) {
      this.ctx.storage.setAlarm(Date.now() + 5000);
      return;
    }
    
    if (loginPending) {
      await this.ctx.storage.delete("login_pending");
    }

    if (!hasAuth) return;

    this.scheduleKeepAlive();

    // Reconnect if needed
    if (!this.sock) {
      try {
        await this.startSocket();
      } catch (e) {
        console.error(`[WA:${this.state.accountId}] Reconnect failed:`, e);
      }
    }
  }
}
