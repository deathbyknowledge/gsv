import { BinaryBodyChannel } from "@humansandmachines/gsv/protocol/binary-body-channel";
import type { BinaryFrameDescriptor, JsonValue } from "@humansandmachines/gsv/protocol";

type MachineFrame = { type: string; id: string; call: string; args: { input?: string; path?: string }; body?: BinaryFrameDescriptor };

/**
 * The machine side of the workspace commands. Archiving copies `workspace`
 * into the archive file and unpacking copies it back, so a test can follow
 * the bytes through a save and a restore without a real tar.
 */
export class FakeMachine {
  workspace: Uint8Array | undefined = new TextEncoder().encode("main.py and its outputs");
  archive: Uint8Array | undefined;
  readonly commands: string[] = [];
  /** Leaves the archive transfer unanswered, as a stalled computer would. */
  stallTransfer = false;
  /** Claims a larger archive than the bytes it sends. */
  claimedSize: number | undefined;

  attach(peer: WebSocket): void {
    peer.binaryType = "arraybuffer";
    const bodies = new BinaryBodyChannel({ role: "acceptor", sendFrame: frame => peer.send(frame) });
    const reply = (id: string, data: JsonValue) => { if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "res", id, ok: true, data })); };
    peer.addEventListener("close", () => bodies.close());
    peer.addEventListener("message", message => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The fake machine receives the WebSocket text/binary union.
      if (typeof message.data !== "string") { bodies.handleFrame(message.data); return; }
      // SAFETY: The computer sends machine protocol frames; the fake reads only the fields it answers.
      void answer(JSON.parse(message.data) as MachineFrame);
    });
    const answer = async (frame: MachineFrame) => {
      if (frame.type !== "req") return;
      if (frame.call === "shell.exec") {
        const input = frame.args.input ?? "";
        this.commands.push(input);
        if (input.includes("-czf")) {
          if (!this.workspace) { reply(frame.id, { status: "completed", output: "", exitCode: 2 }); return; }
          this.archive = this.workspace;
        } else if (input.includes("-xzf")) {
          this.workspace = this.archive; this.archive = undefined;
        }
        reply(frame.id, { status: "completed", output: "", exitCode: 0 });
      } else if (frame.call === "fs.transfer.send") {
        if (this.stallTransfer) return;
        if (!this.archive) { reply(frame.id, { ok: false, error: "No such file" }); return; }
        const outgoing = bodies.prepare({ stream: new Blob([this.archive]).stream(), length: this.archive.byteLength });
        peer.send(JSON.stringify({ type: "res", id: frame.id, ok: true, data: { ok: true, size: this.claimedSize ?? this.archive.byteLength }, body: outgoing.descriptor }));
        await outgoing.send().catch(() => {});
      } else if (frame.call === "fs.transfer.receive" && frame.body) {
        try {
          this.archive = new Uint8Array(await new Response(bodies.receive(frame.body).stream).arrayBuffer());
          reply(frame.id, { ok: true });
        } catch (cause) { reply(frame.id, { ok: false, error: cause instanceof Error ? cause.message : String(cause) }); }
      }
    };
  }
}
