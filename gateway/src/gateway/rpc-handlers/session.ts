import { env } from "cloudflare:workers";
import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleSessionPatch: Handler<"session.patch"> = async ({
  params,
}) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.patch({
    settings: params.settings,
    label: params.label,
    resetPolicy: params.resetPolicy,
  });
};

export const handleSessionGet: Handler<"session.get"> = async ({ params }) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.get();
};

export const handleSessionCompact: Handler<"session.compact"> = async ({
  params,
}) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.compact(params.keepMessages);
};

export const handleSessionStats: Handler<"session.stats"> = async ({
  params,
}) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.stats();
};

export const handleSessionReset: Handler<"session.reset"> = async ({
  params,
}) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.reset();
};

export const handleSessionHistory: Handler<"session.history"> = async ({
  params,
}) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.history();
};

export const handleSessionPreview: Handler<"session.preview"> = async ({
  params,
}) => {
  if (!params?.sessionKey) {
    throw new RpcError(400, "sessionKey required");
  }

  const sessionStub = env.SESSION.getByName(params.sessionKey);

  return await sessionStub.preview(params.limit);
};

export const handleSessionsList: Handler<"sessions.list"> = ({
  gw,
  params,
}) => {
  const limit = params?.limit ?? 100;
  const offset = params?.offset ?? 0;

  const allSessions = Object.values(gw.sessionRegistry).sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );

  const sessions = allSessions.slice(offset, offset + limit);

  return {
    sessions,
    count: allSessions.length,
  };
};
