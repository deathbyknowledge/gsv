import { requireSlackId } from "./slack-api";

export function requireWorkspaceAccountId(value: string): string {
  const normalized = value.trim();
  if (!/^workspace:[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw new Error("Slack workspace account ID is invalid");
  }
  return normalized;
}

export function managedSlackWorkspaceObjectName(accountId: string): string {
  return `workspace:${requireWorkspaceAccountId(accountId)}`;
}

export function managedSlackPeerObjectName(accountId: string, actorId: string): string {
  return `peer:${requireWorkspaceAccountId(accountId)}:${requireSlackId(actorId, "Slack actor")}`;
}
