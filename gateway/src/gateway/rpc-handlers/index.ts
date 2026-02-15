import type { RpcMethod, Handler } from "../../protocol/methods";
import {
  handleSessionGet,
  handleSessionReset,
  handleSessionStats,
  handleSessionHistory,
  handleSessionPreview,
  handleSessionPatch,
  handleSessionCompact,
  handleSessionsList,
} from "./session";
import {
  handleChannelsList,
  handleChannelInbound,
  handleChannelStart,
  handleChannelStop,
  handleChannelStatus,
  handleChannelLogin,
  handleChannelLogout,
} from "./channel";
import {
  handleToolsList,
  handleNodeExecEvent,
  handleNodeProbeResult,
  handleToolRequest,
  handleToolInvoke,
  handleToolResult,
} from "./tools";
import { handleLogsGet, handleLogsResult } from "./logs";
import { handlePairList, handlePairApprove, handlePairReject } from "./pairing";
import { handleChatSend } from "./chat";
import {
  handleHeartbeatStart,
  handleHeartbeatStatus,
  handleHeartbeatTrigger,
} from "./heartbeat";
import {
  handleCronStatus,
  handleCronList,
  handleCronAdd,
  handleCronUpdate,
  handleCronRemove,
  handleCronRun,
  handleCronRuns,
} from "./cron";
import { handleConfigGet, handleConfigSet } from "./config";
import { handleConnect } from "./connect";
import { handleSkillsStatus, handleSkillsUpdate } from "./skills";
import {
  handleWorkspaceList,
  handleWorkspaceRead,
  handleWorkspaceWrite,
  handleWorkspaceDelete,
} from "./workspace";

export function buildRpcHandlers(): Partial<{ [M in RpcMethod]: Handler<M> }> {
  return {
    connect: handleConnect,
    "tool.invoke": handleToolInvoke,
    "tool.result": handleToolResult,
    "node.probe.result": handleNodeProbeResult,
    "node.exec.event": handleNodeExecEvent,
    "tools.list": handleToolsList,
    "logs.get": handleLogsGet,
    "logs.result": handleLogsResult,
    "session.get": handleSessionGet,
    "session.reset": handleSessionReset,
    "session.stats": handleSessionStats,
    "session.history": handleSessionHistory,
    "session.preview": handleSessionPreview,
    "session.patch": handleSessionPatch,
    "session.compact": handleSessionCompact,
    "sessions.list": handleSessionsList,
    "channels.list": handleChannelsList,
    "channel.inbound": handleChannelInbound,
    "channel.start": handleChannelStart,
    "channel.stop": handleChannelStop,
    "channel.status": handleChannelStatus,
    "channel.login": handleChannelLogin,
    "channel.logout": handleChannelLogout,
    "config.get": handleConfigGet,
    "config.set": handleConfigSet,
    "skills.status": handleSkillsStatus,
    "skills.update": handleSkillsUpdate,
    "heartbeat.trigger": handleHeartbeatTrigger,
    "heartbeat.status": handleHeartbeatStatus,
    "heartbeat.start": handleHeartbeatStart,
    "cron.status": handleCronStatus,
    "cron.list": handleCronList,
    "cron.add": handleCronAdd,
    "cron.update": handleCronUpdate,
    "cron.remove": handleCronRemove,
    "cron.run": handleCronRun,
    "cron.runs": handleCronRuns,
    "pair.list": handlePairList,
    "pair.approve": handlePairApprove,
    "pair.reject": handlePairReject,
    "tool.request": handleToolRequest,
    "chat.send": handleChatSend,
    "workspace.list": handleWorkspaceList,
    "workspace.read": handleWorkspaceRead,
    "workspace.write": handleWorkspaceWrite,
    "workspace.delete": handleWorkspaceDelete,
  };
}
