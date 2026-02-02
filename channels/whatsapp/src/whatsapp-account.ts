/**
 * WhatsApp Account Durable Object
 * 
 * Manages a single WhatsApp account connection:
 * - Stores auth credentials in DO storage
 * - Maintains WebSocket connection to WhatsApp via Baileys
 * - Connects to GSV Gateway as a channel
 * - Routes messages between WhatsApp and Gateway
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
import QRCode from "qrcode";
import { useDOAuthState, clearAuthState, hasAuthState } from "./auth-store";
import { GatewayClient } from "./gateway-client";
import type {
  WhatsAppAccountState,
  ChannelInboundParams,
  ChannelOutboundPayload,
  PeerInfo,
  MediaAttachment,
} from "./types";

interface Env {
  GSV_GATEWAY_URL: string;
  GSV_GATEWAY_TOKEN?: string;
}

export class WhatsAppAccount extends DurableObject<Env> {
  private sock: WASocket | null = null;
  private gatewayClient: GatewayClient | null = null;
  private state: WhatsAppAccountState = {
    accountId: "",
    connected: false,
  };
  private qrCode: string | null = null;
  private qrResolvers: Array<(qr: string) => void> = [];

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.state.accountId = ctx.id.toString();
  }

  /**
   * HTTP fetch handler - used for management API
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      switch (path) {
        case "/status":
          return this.handleStatus();
        case "/login":
          return await this.handleLogin(url);
        case "/logout":
          return await this.handleLogout();
        case "/stop":
          return await this.handleStop();
        case "/wake":
          return await this.handleWake();
        default:
          return new Response("Not Found", { status: 404 });
      }
    } catch (e) {
      return new Response(String(e), { status: 500 });
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
      hasAuth: this.sock !== null,
      gatewayConnected: this.gatewayClient?.isConnected() ?? false,
    });
  }

  private async handleLogin(url: URL): Promise<Response> {
    const format = url.searchParams.get("format") || "json";
    
    // If already connected, return success
    if (this.state.connected && this.sock) {
      if (format === "html") {
        return new Response(this.renderHtml("Connected", "<p>Already connected to WhatsApp.</p>"), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return Response.json({ connected: true, message: "Already connected" });
    }

    // Start the socket if not running
    if (!this.sock) {
      await this.startSocket();
    }

    // Wait for QR code or connection
    const result = await this.waitForQrOrConnection(60000);
    
    if (result.connected) {
      if (format === "html") {
        return new Response(this.renderHtml("Connected", "<p>Successfully connected to WhatsApp!</p>"), {
          headers: { "Content-Type": "text/html" },
        });
      }
      return Response.json({ connected: true, message: "Connected" });
    }
    
    if (result.qr) {
      if (format === "html") {
        // Generate QR code as SVG
        const qrSvg = await QRCode.toString(result.qr, { type: "svg", width: 300 });
        const html = this.renderHtml("Scan QR Code", `
          <p>Scan this QR code with WhatsApp to connect:</p>
          <div style="background: white; padding: 20px; display: inline-block; border-radius: 8px;">
            ${qrSvg}
          </div>
          <p style="margin-top: 20px; color: #888;">QR code expires in ~20 seconds. Refresh if needed.</p>
          <script>setTimeout(() => location.reload(), 25000);</script>
        `);
        return new Response(html, {
          headers: { "Content-Type": "text/html" },
        });
      }
      return Response.json({ 
        connected: false, 
        qr: result.qr,
        message: "Scan QR code with WhatsApp" 
      });
    }

    if (format === "html") {
      return new Response(this.renderHtml("Error", "<p>Failed to get QR code. Please try again.</p>"), {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }
    return Response.json({ 
      connected: false, 
      message: "Failed to get QR code" 
    }, { status: 500 });
  }

  private renderHtml(title: string, body: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - GSV WhatsApp</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #1a1a2e;
      color: #eee;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      text-align: center;
    }
    .container {
      padding: 40px;
    }
    h1 { color: #25D366; margin-bottom: 20px; }
    p { margin: 10px 0; }
    a { color: #25D366; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    ${body}
  </div>
</body>
</html>`;
  }

  private async handleLogout(): Promise<Response> {
    // Close socket
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    // Clear auth state
    await clearAuthState(this.ctx.storage);
    
    // Reset state
    this.state = {
      accountId: this.state.accountId,
      connected: false,
    };

    return Response.json({ success: true, message: "Logged out" });
  }

  private async handleStop(): Promise<Response> {
    this.gatewayClient?.close();
    this.gatewayClient = null;

    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }

    this.state.connected = false;
    this.state.lastDisconnectedAt = Date.now();

    return Response.json({ success: true, message: "Stopped" });
  }

  /**
   * Wake up the DO and reconnect if needed
   * This is useful when the DO has hibernated and lost connections
   */
  private async handleWake(): Promise<Response> {
    const actions: string[] = [];
    
    // Check if we have auth
    const hasAuth = await hasAuthState(this.ctx.storage);
    if (!hasAuth) {
      return Response.json({ 
        success: false, 
        message: "No auth credentials. Call /login first.",
        actions,
      }, { status: 400 });
    }

    // Check WhatsApp connection
    const waConnected = this.sock !== null && this.state.connected;
    if (!waConnected) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Wake: WhatsApp not connected, reconnecting...`);
      actions.push("reconnecting_whatsapp");
      await this.startSocket();
      
      // Wait a bit for connection to establish
      await new Promise(resolve => setTimeout(resolve, 3000));
    } else {
      actions.push("whatsapp_already_connected");
    }

    // Check Gateway connection
    const gwConnected = this.gatewayClient?.isConnected() ?? false;
    if (!gwConnected && this.state.connected) {
      console.log(`[WhatsAppAccount:${this.state.accountId}] Wake: Gateway not connected, reconnecting...`);
      actions.push("reconnecting_gateway");
      await this.connectToGateway();
    } else if (gwConnected) {
      actions.push("gateway_already_connected");
    }

    return Response.json({
      success: true,
      message: "Wake complete",
      actions,
      status: {
        whatsappConnected: this.state.connected,
        gatewayConnected: this.gatewayClient?.isConnected() ?? false,
        selfJid: this.state.selfJid,
      },
    });
  }

  private async startSocket(): Promise<void> {
    const { state: authState, saveCreds } = await useDOAuthState(this.ctx.storage);

    const { version } = await fetchLatestBaileysVersion();

    const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, child: () => noopLogger } as any;
    
    this.sock = makeWASocket({
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, noopLogger),
      },
      version,
      printQRInTerminal: false,
      browser: ["GSV WhatsApp", "Channel", "1.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      logger: noopLogger,
    });

    this.sock.ev.on("creds.update", saveCreds);
    this.sock.ev.on("connection.update", (update) => this.handleConnectionUpdate(update));
    this.sock.ev.on("messages.upsert", (m) => {
      this.handleMessagesUpsert(m).catch((e) => {
        console.error(`[WA] handleMessagesUpsert error:`, e);
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
      
      // Extract E164 from JID (format: 14155551234@s.whatsapp.net or 14155551234:13@s.whatsapp.net)
      if (this.state.selfJid) {
        const match = this.state.selfJid.match(/^(\d+)(?::\d+)?@/);
        if (match) {
          this.state.selfE164 = `+${match[1]}`;
        }
      }
      
      this.connectToGateway().catch((e) => {
        console.error(`[WA] Gateway connect failed:`, e);
      });
      
      this.scheduleKeepAlive();
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      
      console.log(`[WA] Connection closed. statusCode=${statusCode}, isLoggedOut=${isLoggedOut}`);
      
      this.state.connected = false;
      this.state.lastDisconnectedAt = Date.now();

      if (isLoggedOut) {
        console.log(`[WA] Logged out - clearing auth state`);
        clearAuthState(this.ctx.storage);
        // Don't schedule alarm - user needs to re-auth
      } else {
        // Quick reconnect attempt
        console.log(`[WA] Scheduling reconnect alarm in 5s`);
        this.ctx.storage.setAlarm(Date.now() + 5000);
      }
    }
  }

  private async handleMessagesUpsert(m: BaileysEventMap["messages.upsert"]): Promise<void> {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      // Skip our own messages
      if (msg.key.fromMe) continue;

      // Check for media messages
      const hasImage = !!msg.message?.imageMessage;
      const hasVideo = !!msg.message?.videoMessage;
      const hasAudio = !!msg.message?.audioMessage;
      const hasDocument = !!msg.message?.documentMessage;
      const hasMedia = hasImage || hasVideo || hasAudio || hasDocument;

      // Get text content (could be caption for media or regular text)
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   msg.message?.videoMessage?.caption ||
                   (hasMedia ? "" : undefined); // Allow empty text if media present
      
      if (text === undefined) continue;

      const remoteJid = msg.key.remoteJid!;
      const isGroup = remoteJid.endsWith("@g.us");
      const isLid = remoteJid.endsWith("@lid");
      
      // For LID-based JIDs, we need to:
      // 1. Use the original remoteJid (LID) for sending replies (WhatsApp requires this)
      // 2. Extract the real phone number from senderPn for allowlist/display purposes
      // The peer.id must be the JID we send replies to, but we pass the E.164 number
      // separately for the gateway to use in allowlist checks.
      let senderId: string | undefined;
      if (isLid && msg.key.senderPn) {
        const senderPn = msg.key.senderPn as string;
        const match = senderPn.match(/^(\d+)@/);
        if (match) {
          senderId = `+${match[1]}`;  // E.164 format for allowlist
        }
        console.log(`[WA] LID: ${senderId}`);
      }
      
      const peer: PeerInfo = {
        kind: isGroup ? "group" : "dm",
        id: remoteJid,  // Keep original JID for replies (including LID)
        name: msg.pushName ?? undefined,
      };

      // Download media if present
      const media: MediaAttachment[] = [];
      if (hasMedia) {
        try {
          const attachment = await this.downloadMedia(msg);
          if (attachment) {
            media.push(attachment);
            console.log(`[WA] Media: ${attachment.type} ${attachment.mimeType} ${Math.round((attachment.data?.length ?? 0) / 1024)}KB`);
          }
        } catch (e) {
          console.error(`[WA] Media download failed:`, e);
        }
      }

      console.log(`[WA] ${remoteJid}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"${media.length > 0 ? ` +${media.length} media` : ''}`);

      // Build inbound params
      // For LID-based DMs, we pass the E.164 number in sender.id for allowlist checking
      // The peer.id contains the actual JID to reply to (which may be a LID)
      const inbound: ChannelInboundParams = {
        channel: "whatsapp",
        accountId: this.state.selfE164 || this.state.accountId,
        peer,
        sender: isGroup ? {
          id: msg.key.participant!,
          name: msg.pushName ?? undefined,
        } : (senderId ? {
          id: senderId,  // E.164 number for allowlist
          name: msg.pushName ?? undefined,
        } : undefined),
        message: {
          id: msg.key.id!,
          text: text || (media.length > 0 ? "[Media]" : ""),
          timestamp: msg.messageTimestamp as number,
          replyToId: msg.message?.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
          media: media.length > 0 ? media : undefined,
        },
      };

      // Send to gateway
      if (this.gatewayClient?.isConnected()) {
        try {
          await this.gatewayClient.sendInbound(inbound);
          this.state.lastMessageAt = Date.now();
        } catch (e) {
          console.error(`[WA] Gateway send failed:`, e);
        }
      }
    }
  }

  /**
   * Download media from a WhatsApp message and return as MediaAttachment
   * 
   * Custom implementation for Cloudflare Workers since Baileys' downloadMediaMessage
   * uses Node.js streams (pipe) which aren't supported in Workers.
   */
  private async downloadMedia(msg: WAMessage): Promise<MediaAttachment | null> {
    if (!this.sock) return null;

    const mContent = extractMessageContent(msg.message);
    if (!mContent) return null;

    const contentType = getContentType(mContent);
    if (!contentType) return null;

    // Determine media type and get metadata
    let mediaType: MediaAttachment["type"];
    let mimeType: string;
    let filename: string | undefined;
    let baileysMediaType: string;

    if (msg.message?.imageMessage) {
      mediaType = "image";
      mimeType = msg.message.imageMessage.mimetype || "image/jpeg";
      filename = msg.message.imageMessage.caption ?? undefined;
      baileysMediaType = "image";
    } else if (msg.message?.videoMessage) {
      mediaType = "video";
      mimeType = msg.message.videoMessage.mimetype || "video/mp4";
      filename = msg.message.videoMessage.caption ?? undefined;
      baileysMediaType = "video";
    } else if (msg.message?.audioMessage) {
      mediaType = "audio";
      mimeType = msg.message.audioMessage.mimetype || "audio/ogg";
      baileysMediaType = "audio";
    } else if (msg.message?.documentMessage) {
      mediaType = "document";
      mimeType = msg.message.documentMessage.mimetype || "application/octet-stream";
      filename = msg.message.documentMessage.fileName ?? undefined;
      baileysMediaType = "document";
    } else {
      return null;
    }

    const media = mContent[contentType] as {
      url?: string;
      directPath?: string;
      mediaKey?: Uint8Array | Buffer;
      fileLength?: number;
    };

    if (!media || typeof media !== "object") return null;
    if (!media.url && !media.directPath) return null;
    if (!media.mediaKey) return null;

    // Get download URL
    const isValidMediaUrl = media.url?.startsWith("https://mmg.whatsapp.net/");
    const downloadUrl = isValidMediaUrl ? media.url : getUrlFromDirectPath(media.directPath!);
    if (!downloadUrl) return null;

    // Get decryption keys
    const keys = await getMediaKeys(media.mediaKey, baileysMediaType as any);

    // Download encrypted content using fetch (Workers-compatible)
    const response = await fetch(downloadUrl, {
      headers: {
        Origin: "https://web.whatsapp.com",
      },
    });

    if (!response.ok) {
      throw new Error(`Media download failed: HTTP ${response.status}`);
    }

    const encryptedData = new Uint8Array(await response.arrayBuffer());

    // WhatsApp media format: [encrypted data][10-byte MAC]
    // The last 10 bytes are the HMAC-SHA256 truncated to 10 bytes
    const ciphertext = encryptedData.slice(0, -10);
    // const mac = encryptedData.slice(-10); // Could verify MAC if needed

    // Decrypt using AES-256-CBC
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

    // Convert to base64
    const base64 = btoa(String.fromCharCode(...decryptedArray));

    return {
      type: mediaType,
      mimeType,
      data: base64,
      filename,
      size: decryptedArray.byteLength,
    };
  }

  private async connectToGateway(): Promise<void> {
    if (this.gatewayClient?.isConnected()) return;

    this.gatewayClient = new GatewayClient({
      url: this.env.GSV_GATEWAY_URL,
      token: this.env.GSV_GATEWAY_TOKEN,
      accountId: this.state.selfE164 || this.state.accountId,
      onOutbound: (payload) => this.handleOutbound(payload),
      onDisconnect: () => {
        this.ctx.storage.setAlarm(Date.now() + 3000);
      },
    });

    await this.gatewayClient.connect();
  }

  private async handleOutbound(payload: ChannelOutboundPayload): Promise<void> {
    if (!this.sock || !this.state.connected) return;

    // Convert peer ID to WhatsApp JID format
    // E.164 format (+31649988417) -> WhatsApp JID (31649988417@s.whatsapp.net)
    let jid = payload.peer.id;
    if (jid.startsWith("+") && !jid.includes("@")) {
      jid = `${jid.slice(1)}@s.whatsapp.net`;
    }
    
    const text = payload.message.text;

    try {
      await this.sock.sendMessage(jid, { text });
      console.log(`[WA] Sent to ${jid}: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);
    } catch (e) {
      console.error(`[WA] Send failed:`, e);
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

  // Keep-alive interval in ms 10 seconds
  private static readonly KEEP_ALIVE_INTERVAL_MS = 10_000;

  /** Schedule a keep-alive alarm to prevent DO hibernation */
  private scheduleKeepAlive(): void {
    this.ctx.storage.setAlarm(Date.now() + WhatsAppAccount.KEEP_ALIVE_INTERVAL_MS);
  }

  /** Alarm handler - reconnection and keep-alive */
  async alarm(): Promise<void> {
    const hasAuth = await hasAuthState(this.ctx.storage);
    if (!hasAuth) {
      // No auth, nothing to do - don't schedule another alarm
      return;
    }

    // ALWAYS schedule next alarm first, before any async work that might fail
    // This ensures we never lose the keep-alive loop
    this.scheduleKeepAlive();

    // Reconnect WhatsApp if needed (sock is lost on hibernation)
    if (!this.sock) {
      console.log(`[WA] Alarm: WhatsApp socket lost, reconnecting...`);
      try {
        await this.startSocket();
      } catch (e) {
        console.error(`[WA] Alarm: WhatsApp reconnect failed:`, e);
      }
      return;
    }

    // WhatsApp socket exists but not connected - might be mid-reconnect
    if (!this.state.connected) {
      console.log(`[WA] Alarm: WhatsApp socket exists but not connected, waiting...`);
      return;
    }

    // WhatsApp connected - check Gateway connection
    if (!this.gatewayClient?.isConnected()) {
      console.log(`[WA] Alarm: Gateway not connected, reconnecting...`);
      try {
        await this.connectToGateway();
      } catch (e) {
        console.error(`[WA] Alarm: Gateway reconnect failed:`, e);
      }
    }
  }
}
