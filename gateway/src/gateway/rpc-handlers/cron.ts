import type { Handler } from "../../protocol/methods";
import { RpcError } from "../../shared/utils";

export const handleCronStatus: Handler<"cron.status"> = async ({ gw }) => {
  return gw.getCronStatus();
};

export const handleCronList: Handler<"cron.list"> = async ({ gw, params }) => {
  return gw.listCronJobs({
    agentId: params?.agentId,
    includeDisabled: params?.includeDisabled,
    limit: params?.limit,
    offset: params?.offset,
  });
};

export const handleCronAdd: Handler<"cron.add"> = async ({ gw, params }) => {
  if (!params?.name || !params?.schedule || !params?.spec) {
    throw new RpcError(400, "name, schedule, and spec are required");
  }

  const job = await gw.addCronJob(params);
  return { ok: true, job };
};

export const handleCronUpdate: Handler<"cron.update"> = async ({ gw, params }) => {
  if (!params?.id || !params?.patch) {
    throw new RpcError(400, "id and patch are required");
  }

  const job = await gw.updateCronJob(params.id, params.patch);
  return { ok: true, job };
};

export const handleCronRemove: Handler<"cron.remove"> = async ({ gw, params }) => {
  if (!params?.id) {
    throw new RpcError(400, "id is required");
  }

  const result = await gw.removeCronJob(params.id);
  return { ok: true, removed: result.removed };
};

export const handleCronRun: Handler<"cron.run"> = async ({ gw, params }) => {
  const result = await gw.runCronJobs({
    id: params?.id,
    mode: params?.mode,
  });
  return {
    ok: true,
    ran: result.ran,
    results: result.results,
  };
};

export const handleCronRuns: Handler<"cron.runs"> = async ({ gw, params }) => {
  return gw.listCronRuns({
    jobId: params?.jobId,
    limit: params?.limit,
    offset: params?.offset,
  });
};
