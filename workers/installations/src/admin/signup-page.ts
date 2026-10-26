import { adminPageResponse, errorNotice, escapeHtml, type AdminNavigationItem } from "./page";
import type { UsernamePolicyInput } from "../username-policy";

export function adminSignupPage(input: {
  lists: UsernamePolicyInput; head?: boolean; saved?: boolean; error?: string; status?: number; navigation?: readonly AdminNavigationItem[];
}): Response {
  return adminPageResponse({
    title: "Signup", section: "signup", head: input.head, status: input.status, navigation: input.navigation,
    content: `<section class="narrow stack">
      <div class="page-heading"><div><p class="eyebrow">SIGNUP</p><h1>Username policy</h1></div></div>
      ${input.error ? errorNotice(input.error) : ""}
      ${input.saved ? '<section class="notice success" role="status"><p>Username policy saved.</p></section>' : ""}
      <form class="panel stack" method="post" action="/admin/signup">
        <label for="reserved-handles">Reserved usernames — operator-controlled Ships only
          <textarea id="reserved-handles" name="reserved" rows="12" maxlength="16000" aria-describedby="policy-help">${escapeHtml(input.lists.reserved)}</textarea>
        </label>
        <label for="blocked-handles">Blocked usernames — unavailable to everyone
          <textarea id="blocked-handles" name="blocked" rows="12" maxlength="16000" aria-describedby="policy-help">${escapeHtml(input.lists.blocked)}</textarea>
        </label>
        <p id="policy-help">Enter one name per line, or separate them with commas. Up to 500 entries per list. Matches use the entire name, ignoring capitalization, accents, hyphens, underscores, dots and spaces. Blocked takes precedence over reserved.</p>
        <p>Changes apply to new registrations immediately. Existing Ships and unfinished activations keep their usernames. Clear the list to remove these blocks.</p>
        <p>Configured service hostnames and built-in routes stay protected. Context-dependent terms are reviewed when reported; do not add them solely for an ambiguous meaning.</p>
        <div><button type="submit">Save username policy</button></div>
      </form>
    </section>`,
  });
}
