# Settings: first slice

One Settings surface uses the Instrument header and existing gateway services. It edits the signed-in account’s defaults; it never chooses another account when identity is unavailable.

- Preferences shows the effective first choice and fallback order. Personal entries can be reordered, and a shared or included model can be promoted without copying it. Saves use the existing stack/preference keys and preserve credential keys; reasoning is saved independently.
- Permissions edits simple approval policies without changing rule order. Target specificity, then capability specificity, then source order determine matching. Conditional, unknown, or malformed policies remain read-only rather than being normalized away. Account grants remain authoritative.
- Instructions lists existing `~/context.d/*.md` files and loads one selected file at a time. Reads retain exact text; non-text, incomplete, and failed reads cannot be saved. A blank file is a valid edit. Only the selected file is written.
- Integrations lists MCP servers and supports adding a URL, following a returned sign-in link, refreshing, and removing owned servers. No credential or connection operation is performed until the person invokes its control.

Section switches preserve drafts. Unsaved changes are reported to Instrument’s navigation guard and browser unload handling. Loading, disconnection, authorization, and mutation failures remain visible; backend authorization is unchanged.

The existing settings surfaces remain available. Remaining parity includes messenger setup and pairing, Contacts and invitations, model profiles/provider credentials/Codex sign-in, advanced approval policies and account grants, instruction file creation/deletion, and MCP custom headers. This slice does not introduce new integrations or change production prompt defaults.
