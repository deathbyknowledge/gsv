import styleContext from "./agent/00-style.md";
import memoryContext from "./agent/15-memory.md";
import standingContext from "./user/10-personal.md";

// Used only to remove the exact generated context.d/00-boot.md during responsibility-ledger migration.
export const RETIRED_BOOT_CONTEXT_TEMPLATE =
  "This GSV was just created. Treat this as a one-time onboarding assignment.\n" +
  "\n" +
  "- Get to know the user enough to be useful.\n" +
  "- Help the user and your own agent account finish setting up GSV: connect useful devices/targets or messengers, configure models and approvals.\n" +
  "- When the user says onboarding or setup is done, delete `~/context.d/00-boot.md` so this one-time assignment does not appear in future conversations. Until onboarding is complete, keep it as an active assignment even if the conversation changes topic.\n";

// Used by ensureAccountHomeLayout to seed context.d/00-style.md for agent accounts.
export const DEFAULT_STYLE_CONTEXT = styleContext;

// Used by ensureAccountHomeLayout to seed context.d/15-memory.md for worker accounts.
export const DEFAULT_MEMORY_CONTEXT_TEMPLATE = memoryContext;

export const PERSONAL_STANDING_CONTEXT = standingContext;
