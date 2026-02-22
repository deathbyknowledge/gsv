import { env } from "cloudflare:workers";
import type { CronJob } from "../cron";
import type { ChannelId, PeerInfo } from "../protocol/channel";
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

  let deliveryContext: {
    channel: ChannelId;
    accountId: string;
    peer: PeerInfo;
  } | null = null;

  const shouldDeliver = params.deliver !== false;
  if (shouldDeliver) {
    const lastActive = gw.lastActiveContext[agentId];

    if (params.channel && params.to && lastActive) {
      deliveryContext = JSON.parse(JSON.stringify({
        channel: params.channel,
        accountId: lastActive.accountId,
        peer: { kind: "dm" as const, id: params.to },
      }));
    } else if (params.to && lastActive) {
      deliveryContext = JSON.parse(JSON.stringify({
        channel: lastActive.channel,
        accountId: lastActive.accountId,
        peer: { kind: "dm" as const, id: params.to },
      }));
    } else if (lastActive) {
      deliveryContext = JSON.parse(JSON.stringify({
        channel: lastActive.channel,
        accountId: lastActive.accountId,
        peer: lastActive.peer,
      }));
    }
  }

  if (deliveryContext) {
    gw.pendingChannelResponses[runId] = {
      ...deliveryContext,
      inboundMessageId: `cron:${params.job.id}:${Date.now()}`,
      agentId,
    };
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
      JSON.parse(JSON.stringify(gw.getAllTools())),
      JSON.parse(JSON.stringify(gw.getRuntimeNodeInventory())),
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
          }
        : undefined,
    );
    return {
      status: "ok",
      summary: `queued to ${params.sessionKey}${deliveryContext ? ` (delivering to ${deliveryContext.channel}:${deliveryContext.peer.id})` : ""}`,
    };
  } catch (error) {
    if (deliveryContext) {
      delete gw.pendingChannelResponses[runId];
    }
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
