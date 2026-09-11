import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { AdapterGatewayInterface, AdapterInstallationContext, AdapterGatewayFrame as Frame } from "@humansandmachines/gsv/protocol";
import type { AdapterGatewayService, AdapterService } from "@humansandmachines/gsv/services/adapters";

type Adapter = "telegram" | "slack" | "discord";
type Gateway = AdapterGatewayInterface & AdapterGatewayService;
type Env = {
  STATE: DurableObjectNamespace<MessengerGateState>;
  TELEGRAM_GATEWAY: Gateway;
  SLACK_GATEWAY: Gateway;
  DISCORD_GATEWAY: Gateway;
  CHANNEL_TELEGRAM: AdapterService;
  CHANNEL_SLACK: AdapterService;
  CHANNEL_DISCORD: AdapterService;
};
export type AdmissionRecord = {
  adapter: Adapter;
  installationId: string;
  direction: "inbound" | "outbound";
  text: string;
  deliveryId: string;
  response?: string;
};

/** A controllable wire, never an authorization or admission implementation. */
export class MessengerGateState extends DurableObject<Env> {
  async control(command: { hold?: string; release?: string; loseFinalize?: string }): Promise<void> {
    if (command.hold) await this.ctx.storage.put(`hold:${command.hold}`, true);
    if (command.release) await this.ctx.storage.delete(`hold:${command.release}`);
    if (command.loseFinalize) await this.ctx.storage.put(`finalize:${command.loseFinalize}`, true);
  }
  async enter(record: AdmissionRecord): Promise<string> {
    const key = `record:${crypto.randomUUID()}`;
    await this.ctx.storage.put(key, record);
    const deadline = Date.now() + 15_000;
    while (await this.ctx.storage.get(`hold:${record.text}`)) {
      if (Date.now() >= deadline) throw new Error("Messenger test gate was not released");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return key;
  }
  async complete(key: string, response: string): Promise<void> {
    const prior = await this.ctx.storage.get<AdmissionRecord>(key);
    if (!prior) throw new Error("Missing messenger test gate record");
    await this.ctx.storage.put(key, { ...prior, response });
  }
  async loseFinalize(adapter: string): Promise<boolean> {
    return await this.ctx.storage.delete(`finalize:${adapter}`);
  }
  async records(): Promise<AdmissionRecord[]> {
    return [...(await this.ctx.storage.list<AdmissionRecord>({ prefix: "record:" })).values()];
  }
}

export class MessengerGatewayGate extends WorkerEntrypoint<Env, { id: Adapter }> {
  private gateway(): Gateway { return { telegram: this.env.TELEGRAM_GATEWAY, slack: this.env.SLACK_GATEWAY, discord: this.env.DISCORD_GATEWAY }[this.ctx.props.id]; }
  async serviceFrame(installation: AdapterInstallationContext, frame: Frame): Promise<Frame | null> {
    if (frame.type !== "req" || frame.call !== "adapter.inbound") return await this.gateway().serviceFrame(installation, frame);
    // SAFETY: These records observe real adapter.inbound frames; the actual Gateway validates them below.
    const args = frame.args as { deliveryId: string; message: { text: string } };
    const state = this.env.STATE.getByName("wire");
    const key = await state.enter({ adapter: this.ctx.props.id, installationId: installation.installationId, direction: "inbound", text: args.message.text, deliveryId: args.deliveryId });
    const response = await this.gateway().serviceFrame(installation, frame);
    await state.complete(key, JSON.stringify(response));
    return response;
  }
  async linkedPeerFrame(...args: Parameters<AdapterGatewayInterface["linkedPeerFrame"]>) { return await this.gateway().linkedPeerFrame(...args); }
  async unlinkAdapterIdentity(...args: Parameters<Gateway["unlinkAdapterIdentity"]>) { return await this.gateway().unlinkAdapterIdentity(...args); }
}

export class MessengerChannelGate extends WorkerEntrypoint<Env, { id: Adapter }> {
  private channel(): AdapterService { return { telegram: this.env.CHANNEL_TELEGRAM, slack: this.env.CHANNEL_SLACK, discord: this.env.CHANNEL_DISCORD }[this.ctx.props.id]; }
  async adapterDescribe() { return await this.channel().adapterDescribe(); }
  async adapterStatus(...args: Parameters<NonNullable<AdapterService["adapterStatus"]>>) { return await this.channel().adapterStatus!(...args); }
  async adapterSetActivity(...args: Parameters<NonNullable<AdapterService["adapterSetActivity"]>>) { return await this.channel().adapterSetActivity!(...args); }
  async adapterPairingInfo(...args: Parameters<NonNullable<AdapterService["adapterPairingInfo"]>>) { return await this.channel().adapterPairingInfo!(...args); }
  async adapterPairingInspect(...args: Parameters<NonNullable<AdapterService["adapterPairingInspect"]>>) { return await this.channel().adapterPairingInspect!(...args); }
  async adapterPairingPrepare(...args: Parameters<NonNullable<AdapterService["adapterPairingPrepare"]>>) { return await this.channel().adapterPairingPrepare!(...args); }
  async adapterPairingActivate(...args: Parameters<NonNullable<AdapterService["adapterPairingActivate"]>>) { return await this.channel().adapterPairingActivate!(...args); }
  async adapterPairingFinalize(...args: Parameters<NonNullable<AdapterService["adapterPairingFinalize"]>>) {
    const result = await this.channel().adapterPairingFinalize!(...args);
    if (await this.env.STATE.getByName("wire").loseFinalize(this.ctx.props.id)) throw new Error("Fixture lost finalized pairing response");
    return result;
  }
  async adapterPairingDisconnect(...args: Parameters<NonNullable<AdapterService["adapterPairingDisconnect"]>>) { return await this.channel().adapterPairingDisconnect!(...args); }
  async adapterFrame(...args: Parameters<NonNullable<AdapterService["adapterFrame"]>>) {
    const [installation, context, frame] = args;
    if (frame.call !== "adapter.send") return await this.channel().adapterFrame!(...args);
    const state = this.env.STATE.getByName("wire");
    // SAFETY: Only a real Kernel-produced adapter.send frame reaches this fixture.
    const send = frame.args as { text?: string };
    const key = await state.enter({ adapter: this.ctx.props.id, installationId: installation.installationId, direction: "outbound", text: send.text ?? "", deliveryId: context.deliveryId });
    const response = await this.channel().adapterFrame!(...args);
    await state.complete(key, JSON.stringify(response));
    return response;
  }
}

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const state = this.env.STATE.getByName("wire");
    if (request.method === "POST") {
      await state.control(await request.json());
      return new Response(null, { status: 204 });
    }
    return Response.json(await state.records());
  }
}
