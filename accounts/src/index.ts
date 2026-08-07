import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  InstallationDirectoryResult,
  InstallationDirectoryService,
} from "@humansandmachines/gsv/protocol";
import { AccountStore } from "./store";

export default class AccountService
  extends WorkerEntrypoint<Env>
  implements InstallationDirectoryService
{
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return Response.json({ status: "healthy" });
    }
    return new Response("Not Found", { status: 404 });
  }

  async resolveHostname(hostname: string): Promise<InstallationDirectoryResult> {
    return await this.store().resolveHostname(hostname);
  }

  private store(): AccountStore {
    return new AccountStore(this.env.ACCOUNT_DB, this.env.GSV_BASE_DOMAIN);
  }
}
