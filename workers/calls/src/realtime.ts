import type { PhoneRealtimeSession } from "@humansandmachines/gsv/services/phone";

export type RealtimeTool = { name: string; description: string; parameters: Record<string, unknown> };
export type RealtimeSetup = {
  instructions: string;
  tools: RealtimeTool[];
  voice: string;
  transcriptionModel: string;
  /** ISO 639-1 hint for transcribing the callee. */
  language?: string;
};

/** Model-neutral session events: telephony audio in, audio, transcript and tool calls out. */
export type RealtimeHandlers = {
  /** Base64 8 kHz μ-law audio for the callee. */
  audio(payload: string): void;
  /** The callee started speaking; queued agent audio must stop. */
  speechStarted(): void;
  agentLine(text: string): void;
  calleeLine(text: string): void;
  toolCall(call: { id: string; name: string; arguments: string }): void;
  responseDone(usage: { inputTokens: number; outputTokens: number }): void;
  closed(cause?: unknown): void;
};

export interface RealtimeSession {
  /** Base64 8 kHz μ-law audio from the callee. */
  appendAudio(payload: string): void;
  /** Context for the agent that is never read out verbatim. */
  inform(text: string, respond: boolean): void;
  toolResult(callId: string, output: string, respond: boolean): void;
  respond(): void;
  close(): void;
}

export interface RealtimeConnector {
  open(credential: PhoneRealtimeSession, setup: RealtimeSetup, handlers: RealtimeHandlers): Promise<RealtimeSession>;
}

/** OpenAI Realtime over one WebSocket, authenticated with the per-call client secret. */
/**
 * Semantic turn detection at low eagerness waits for the callee to finish a
 * thought, so a short "OK" or "mm" does not cut the agent off; a real
 * interruption still stops its reply.
 */
export function openAiSession(setup: RealtimeSetup) {
  return {
    type: "realtime", instructions: setup.instructions, tool_choice: "auto",
    tools: setup.tools.map(tool => ({ type: "function", ...tool })),
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        turn_detection: { type: "semantic_vad", eagerness: "low", create_response: true, interrupt_response: true },
        transcription: { model: setup.transcriptionModel, ...(setup.language ? { language: setup.language } : {}) },
      },
      output: { format: { type: "audio/pcmu" }, voice: setup.voice },
    },
  };
}

export class OpenAiRealtimeConnector implements RealtimeConnector {
  async open(credential: PhoneRealtimeSession, setup: RealtimeSetup, handlers: RealtimeHandlers): Promise<RealtimeSession> {
    const url = new URL(credential.url);
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol;
    url.searchParams.set("model", credential.model);
    const response = await fetch(url, { headers: { Upgrade: "websocket", Authorization: `Bearer ${credential.clientSecret}` } });
    const socket = response.webSocket;
    if (!socket) throw new Error(`Realtime session refused with ${response.status}`);
    socket.accept();
    const send = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    let closed = false;
    const finish = (cause?: unknown) => { if (closed) return; closed = true; handlers.closed(cause); };
    socket.addEventListener("close", () => finish());
    socket.addEventListener("error", event => finish(event));
    socket.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as Record<string, unknown>;
      switch (message.type) {
        case "response.output_audio.delta": handlers.audio(String(message.delta)); break;
        case "response.output_audio_transcript.done": if (message.transcript) handlers.agentLine(String(message.transcript)); break;
        case "conversation.item.input_audio_transcription.completed": if (message.transcript) handlers.calleeLine(String(message.transcript)); break;
        case "input_audio_buffer.speech_started": handlers.speechStarted(); break;
        case "response.function_call_arguments.done":
          handlers.toolCall({ id: String(message.call_id), name: String(message.name), arguments: String(message.arguments ?? "{}") });
          break;
        case "response.done": {
          const usage = (message.response as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage;
          handlers.responseDone({ inputTokens: usage?.input_tokens ?? 0, outputTokens: usage?.output_tokens ?? 0 });
          break;
        }
      }
    });
    send({ type: "session.update", session: openAiSession(setup) });
    return {
      appendAudio: payload => { if (!closed) send({ type: "input_audio_buffer.append", audio: payload }); },
      inform: (text, respond) => {
        if (closed) return;
        send({ type: "conversation.item.create", item: { type: "message", role: "system", content: [{ type: "input_text", text }] } });
        if (respond) send({ type: "response.create" });
      },
      toolResult: (callId, output, respond) => {
        if (closed) return;
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } });
        if (respond) send({ type: "response.create" });
      },
      respond: () => { if (!closed) send({ type: "response.create" }); },
      close: () => { closed = true; try { socket.close(1000, "call ended"); } catch { /* already closed */ } },
    };
  }
}
