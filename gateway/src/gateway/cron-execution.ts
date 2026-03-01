import { env } from "cloudflare:workers";
import type { CronJob } from "../cron";
import type { SessionOutputContext } from "../protocol/channel";
import { formatTimeFull, resolveTimezone } from "../shared/time";
import type { Gateway } from "./do";

export type ExecuteCronJobParams = {
  job: CronJob;
  text: string;
  sessionKey: string;
  deliver?: boolean;
  channel?: string;
  to?: string;
  bestEffortDeliver?: boolean;
};

export type ExecuteCronJobResult = {
  status: "ok" | "error" | "skipped";
  error?: string;
  summary?: string;
};

export async function executeCronJob(
  gw: Gateway,
  params: ExecuteCronJobParams,
): Promise<ExecuteCronJobResult> {
  const runId = crypto.randomUUID();
  const agentId = params.job.agentId;
  const session = env.SESSION.getByName(params.sessionKey);

  let deliveryContext: SessionOutputContext | null = null;

  const shouldDeliver = params.deliver !== false;
  if (shouldDeliver) {
    const lastActive = gw.lastActiveContext[agentId];

    if (params.channel && params.to && lastActive) {
      deliveryContext = JSON.parse(JSON.stringify({
        channel: params.channel,
        accountId: lastActive.accountId,
        peer: { kind: "dm", id: params.to },
        inboundMessageId: `cron:${params.job.id}:${Date.now()}`,
        agentId,
      }));
    } else if (params.to && lastActive) {
      deliveryContext = JSON.parse(JSON.stringify({
        channel: lastActive.channel,
        accountId: lastActive.accountId,
        peer: { kind: "dm", id: params.to },
        inboundMessageId: `cron:${params.job.id}:${Date.now()}`,
        agentId,
      }));
    } else if (lastActive) {
      deliveryContext = JSON.parse(JSON.stringify({
        channel: lastActive.channel,
        accountId: lastActive.accountId,
        peer: lastActive.peer,
        inboundMessageId: `cron:${params.job.id}:${Date.now()}`,
        agentId,
      }));
    }
  }

  if (deliveryContext) {
    gw.lastActiveContext[agentId] = {
      agentId,
      channel: deliveryContext.channel,
      accountId: deliveryContext.accountId,
      peer: deliveryContext.peer,
      sessionKey: params.sessionKey,
      timestamp: Date.now(),
    };
  }

  const config = gw.getFullConfig();
  const tz = resolveTimezone(config.userTimezone);
  const timePrefix = `[cron · ${formatTimeFull(new Date(), tz)}]`;
  const deliveryNote = deliveryContext
    ? `\n[Your response will be delivered automatically to ${deliveryContext.channel}:${deliveryContext.peer.id} — reply normally, do NOT use gsv__Message for this.]`
    : "";
  const cronMessage = `${timePrefix} ${params.text}${deliveryNote}`;

  try {
    await session.chatSend(
      cronMessage,
      runId,
      JSON.parse(JSON.stringify(gw.nodeService.listTools(gw.nodes.keys()))),
      JSON.parse(
        JSON.stringify(gw.nodeService.getRuntimeNodeInventory(gw.nodes.keys())),
      ),
      params.sessionKey,
      undefined,
      undefined,
      deliveryContext
        ? {
            channel: deliveryContext.channel,
            accountId: deliveryContext.accountId,
            peer: {
              kind: deliveryContext.peer.kind,
              id: deliveryContext.peer.id,
              name: deliveryContext.peer.name,
            },
            inboundMessageId: deliveryContext.inboundMessageId,
            agentId: deliveryContext.agentId,
          }
        : undefined,
    );
    return {
      status: "ok",
      summary: `queued to ${params.sessionKey}${deliveryContext ? ` (delivering to ${deliveryContext.channel}:${deliveryContext.peer.id})` : ""}`,
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
