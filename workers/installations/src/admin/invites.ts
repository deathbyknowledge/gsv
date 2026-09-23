import { z } from "zod";
import { InstallationCreationInvites } from "../creation-invites";
import type { InstallationAdminAccess } from "./access";
import { adminPageResponse, escapeHtml, formatDate } from "./page";
import { adminRedirect, readAdminForm, requireAdminMutationOrigin, AdminForbiddenError } from "./http";
import { readJsonObject } from "../http";

type InvitePolicy = { choices(): Promise<{ id: string; name: string }[]> };

export class InstallationInvitesAdminHttp {
  constructor(private readonly invitations: InstallationCreationInvites, private readonly access: InstallationAdminAccess,
    private readonly origin: string, private readonly policy?: InvitePolicy) {}

  async handle(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    const revoke = /^\/admin\/(?:api\/)?invites\/([A-Za-z0-9_-]{1,128})\/revoke$/.exec(path);
    if (!revoke && !["/admin/invites", "/admin/api/invites"].includes(path)) return null;
    if (!await this.access.allows(request)) return new Response("Forbidden", { status: 403 });
    const api = path.startsWith("/admin/api/");
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
    try {
      let issuedCode: string | undefined;
      if (request.method === "POST") {
        requireAdminMutationOrigin(request, this.origin);
        if (revoke) {
          await this.invitations.revoke(revoke[1]);
          return api ? json({ ok: true }) : adminRedirect("/admin/invites");
        }
        const form = api ? null : await readAdminForm(request);
        const value = api ? await readJsonObject(request) : { note: form?.get("note") ?? "", policyRef: form?.get("policyRef") || null,
          expiresAt: form?.get("expiresAt") ? Date.parse(form.get("expiresAt")! + "Z") : null };
        const input = z.strictObject({ note: z.string().max(160).optional(), policyRef: z.string().nullable().optional(), expiresAt: z.number().int().positive().nullable().optional() }).parse(value);
        const plans = await this.policy?.choices();
        if (plans ? !plans.some((plan) => plan.id === input.policyRef) : input.policyRef) throw new Error("Choose an available plan.");
        const issued = await this.invitations.create(input);
        if (api) return json(issued, 201);
        issuedCode = issued.code;
      } else if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
      const invites = await this.invitations.list();
      if (api) return json({ invites });
      const plans = await this.policy?.choices();
      const rows = invites.map((invite) => `<tr><td>${escapeHtml(invite.prefix)}…</td><td>${escapeHtml(invite.note)}</td>
        <td>${escapeHtml(invite.state)}${invite.lastError ? `<br>${escapeHtml(invite.lastError.replaceAll("_", " "))}` : ""}</td>
        <td>${invite.installationId ? `<a href="/admin/installations/${encodeURIComponent(invite.installationId)}">${escapeHtml(invite.handle ?? "Space")}</a>` : "—"}</td>
        <td>${invite.claimedAt ? formatDate(invite.claimedAt) : "—"}</td><td>${invite.installationId || invite.state === "revoked" ? "" : `<form method="post" action="/admin/invites/${encodeURIComponent(invite.id)}/revoke"><button class="secondary">Revoke</button></form>`}</td></tr>`).join("");
      return adminPageResponse({ title: "Invites", section: "invites", navigation: [{ section: "invites", href: "/admin/invites", label: "Invites" }], content: `<section class="stack"><h1>Invites</h1>
        ${issuedCode ? `<section class="panel"><label>Copy this code<textarea readonly rows="2">${escapeHtml(issuedCode)}</textarea></label><p>It is shown once.</p></section>` : ""}
        <form method="post" action="/admin/invites" class="panel stack"><label>Note<input name="note" maxlength="160"></label>
          ${plans ? `<label>Plan<select name="policyRef" required>${plans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}</option>`).join("")}</select></label>` : ""}
          <label>Expiry (UTC, optional)<input name="expiresAt" type="datetime-local"></label><button ${plans?.length === 0 ? "disabled" : ""}>Create invite</button>
          ${plans?.length === 0 ? '<a href="/admin/plans">Create a plan first</a>' : ""}</form>
        <table><thead><tr><th>Invite</th><th>Note</th><th>Status</th><th>Space</th><th>Claimed</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>` });
    } catch (error) {
      const forbidden = error instanceof AdminForbiddenError;
      const message = forbidden ? "Forbidden" : error instanceof Error && /^(Invite |Choose an available)/.test(error.message)
        ? error.message : "Could not update invites. Check the details and try again.";
      return api ? json({ error: message }, forbidden ? 403 : 400)
        : adminPageResponse({ title: "Invites", section: "invites", status: forbidden ? 403 : 400,
          content: `<section class="narrow stack"><p role="alert">${escapeHtml(message)}</p><a href="/admin/invites">Back to invites</a></section>` });
    }
  }
}
