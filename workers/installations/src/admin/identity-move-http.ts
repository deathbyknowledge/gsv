import { exceptionDiagnostics } from "@humansandmachines/gsv/telemetry";
import { z } from "zod";
import { json, readJsonObject } from "../http";
import { IdentityMoveRefusal, type IdentityMoves } from "../identity-moves";
import { AdminForbiddenError, type InstallationAdminAccess } from "./access";
import { adminRedirect, adminText, readAdminForm, requireAdminMutationOrigin } from "./http";
import type { AdminAuditRecorder } from "./insight";
import { identityMovePage } from "./identity-move-page";
import { adminErrorPage, type AdminNavigationItem } from "./page";

/** The move's page and JSON share one runtime and the operator's admission and audit. */
export class IdentityMoveHttp {
  constructor(
    private readonly moves: IdentityMoves,
    private readonly access: InstallationAdminAccess,
    private readonly origin: string,
    private readonly audited: AdminAuditRecorder,
    private readonly navigation: readonly AdminNavigationItem[] = [],
  ) {}

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const route = /^\/admin(\/api)?\/identity-move(?:\/(survey|apply))?$/.exec(url.pathname);
    if (!route) return null;
    const api = route[1] !== undefined;
    const action = route[2];
    const forbidden = () => api ? json({ error: "Forbidden" }, 403) : adminText("Forbidden", 403);
    if (!await this.access.allows(request)) return forbidden();
    const head = request.method === "HEAD";
    try {
      if (!action && (request.method === "GET" || head)) {
        const status = await this.moves.status();
        return api ? json(status) : identityMovePage(status, undefined, head, 200, this.navigation);
      }
      if (!action || request.method !== "POST") {
        return api ? json({ error: "Not Found" }, 404) : adminErrorPage("The operator page does not exist.", 404, head, this.navigation);
      }
      requireAdminMutationOrigin(request, this.origin);
      const input = await readActionInput(request, api);
      if (action === "apply" && input.confirm !== "move") throw new IdentityMoveRefusal("Type move to confirm the move", 400);
      const status = await this.audited(request,
        { name: `deployment.identity-move.${action}`, reason: input.reason },
        () => action === "survey" ? this.moves.survey() : this.moves.apply(),
        (result) => ({ detail: { phase: result.phase, ships: String(result.ships.total) } }));
      return api ? json(status) : adminRedirect("/admin/identity-move");
    } catch (error) {
      if (error instanceof AdminForbiddenError) return forbidden();
      const refusal = error instanceof IdentityMoveRefusal ? error : null;
      if (!refusal) console.warn("[Operator] Identity move request failed:", url.pathname, exceptionDiagnostics(error));
      const message = refusal?.message ?? "The operator request could not be completed.";
      const status = refusal?.status ?? 503;
      if (api) return json({ error: message }, status);
      try {
        return identityMovePage(await this.moves.status(), message, false, status, this.navigation);
      } catch (statusError) {
        console.warn("[Operator] Identity move status unavailable:", exceptionDiagnostics(statusError));
        return adminErrorPage(message, status, false, this.navigation);
      }
    }
  }
}

const actionInputSchema = z.strictObject({ reason: z.string().optional(), confirm: z.string().optional() });

async function readActionInput(request: Request, api: boolean): Promise<z.infer<typeof actionInputSchema>> {
  let body: unknown;
  try {
    body = api ? await readJsonObject(request) : Object.fromEntries(await readAdminForm(request));
  } catch (error) {
    throw new IdentityMoveRefusal(error instanceof Error ? error.message : "The request body is unreadable", 400);
  }
  const input = actionInputSchema.safeParse(body);
  if (!input.success) throw new IdentityMoveRefusal("The request accepts only a reason and a confirmation", 400);
  return input.data;
}
