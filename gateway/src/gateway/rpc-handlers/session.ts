import { env } from "cloudflare:workers";
import type { Handler } from "../../protocol/methods";
import { resolveSessionTarget } from "./session-target";

export const handleSessionPatch: Handler<"session.patch"> = async ({
  gw,
  params,
}) => {
  const target = resolveSessionTarget(gw, {
    sessionKey: params?.sessionKey,
    threadRef: params?.threadRef,
  });
  const sessionStub = env.SESSION.getByName(target.sessionDoName);

  return await sessionStub.patch({
    settings: params.settings,
    label: params.label,
    resetPolicy: params.resetPolicy,
  });
};

export const handleSessionGet: Handler<"session.get"> = async ({
  gw,
  params,
}) => {
  const target = resolveSessionTarget(gw, {
    sessionKey: params?.sessionKey,
    threadRef: params?.threadRef,
  });
  const sessionStub = env.SESSION.getByName(target.sessionDoName);
  const result = await sessionStub.get();

  return {
    ...result,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
    stateId: target.stateId,
  };
};

export const handleSessionCompact: Handler<"session.compact"> = async ({
  gw,
  params,
}) => {
  const target = resolveSessionTarget(gw, {
    sessionKey: params?.sessionKey,
    threadRef: params?.threadRef,
  });
  const sessionStub = env.SESSION.getByName(target.sessionDoName);
  const result = await sessionStub.compact(params.keepMessages);

  return {
    ...result,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
    stateId: target.stateId,
  };
};

export const handleSessionStats: Handler<"session.stats"> = async ({
  gw,
  params,
}) => {
  const target = resolveSessionTarget(gw, {
    sessionKey: params?.sessionKey,
    threadRef: params?.threadRef,
  });
  const sessionStub = env.SESSION.getByName(target.sessionDoName);
  const result = await sessionStub.stats();

  return {
    ...result,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
    stateId: target.stateId,
  };
};

export const handleSessionReset: Handler<"session.reset"> = async ({
  gw,
  params,
}) => {
  const target = resolveSessionTarget(gw, {
    sessionKey: params?.sessionKey,
    threadRef: params?.threadRef,
  });
  const sessionStub = env.SESSION.getByName(target.sessionDoName);
  const result = await sessionStub.reset();

  return {
    ...result,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
    stateId: target.stateId,
  };
};

export const handleSessionHistory: Handler<"session.history"> = async ({
  gw,
  params,
}) => {
  const target = resolveSessionTarget(gw, {
    sessionKey: params?.sessionKey,
    threadRef: params?.threadRef,
  });
  const sessionStub = env.SESSION.getByName(target.sessionDoName);
  const result = await sessionStub.history();

  return {
    ...result,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
    stateId: target.stateId,
  };
};

export const handleSessionPreview: Handler<"session.preview"> = async ({
  gw,
  params,
}) => {
  const target = resolveSessionTarget(gw, {
    sessionKey: params?.sessionKey,
    threadRef: params?.threadRef,
  });
  const sessionStub = env.SESSION.getByName(target.sessionDoName);
  const result = await sessionStub.preview(params.limit);

  return {
    ...result,
    sessionKey: target.sessionKey,
    threadId: target.threadId,
    stateId: target.stateId,
  };
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
