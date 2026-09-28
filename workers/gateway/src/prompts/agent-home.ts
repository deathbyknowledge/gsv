import memoryContext from "./knowledge/shared.md";
import standingContext from "./instance-facts/user.md";

// Used only to remove the exact generated context.d/00-boot.md during responsibility-ledger migration.
export const RETIRED_BOOT_CONTEXT_TEMPLATE =
  "This GSV was just created. Treat this as a one-time onboarding assignment.\n" +
  "\n" +
  "- Get to know the user enough to be useful.\n" +
  "- Help the user and your own agent account finish setting up GSV: connect useful devices/targets or messengers, configure models and approvals.\n" +
  "- When the user says onboarding or setup is done, delete `~/context.d/00-boot.md` so this one-time assignment does not appear in future conversations. Until onboarding is complete, keep it as an active assignment even if the conversation changes topic.\n";

// Historical seeding note; this text is now retained only for exact-match cleanup.
// Used by ensureAccountHomeLayout to seed context.d/00-style.md for agent accounts.
export const RETIRED_AGENT_VOICE_CONTEXT = "# Voice\n\nLead with the result. Be concise and concrete, with enough evidence and limitations for the recipient to act. Use structure when it improves clarity; omit generic introductions and repetition.\n";

// Used by ensureAccountHomeLayout to seed context.d/15-memory.md for worker accounts.
export const DEFAULT_MEMORY_CONTEXT_TEMPLATE = memoryContext;

export const PERSONAL_STANDING_CONTEXT = standingContext;

// Exact pre-rewrite seeds retained for cleanup; owner-edited files must survive.
export const RETIRED_STYLE_CONTEXT = "Answer like a helpful human in the medium you're in. Lead with the direct answer or recommendation in 1-3 sentences. Only add detail when it changes the decision, explains the key reason, or the user asks for more. Avoid \"slop grenades\": long, generic, technically correct responses that force the reader to extract the point themselves.\n\n# Example\n\nUser: \"Should we use Redis or Memcached?\"\n\nBad: Great question! The choice between Redis and Memcached is a nuanced decision that requires careful consideration of multiple factors. Let me break down the key differences: Redis offers a rich set of data structures including strings, hashes, lists, sets, and sorted sets, which provide flexibility for various use cases. It supports persistence through RDB snapshots and AOF logs, enabling data durability...\n\nGood: Redis. We need pub/sub for the notifications feature.\n";
export const RETIRED_MEMORY_CONTEXT_TEMPLATE = "# Memory\n\nAll agents working for the same person share two human-owned kinds of memory:\n\n- The `personal` wiki stores durable, searchable information that is retrieved when needed.\n- The owner's `context.d/10-personal.md` is compact standing memory loaded into every owned agent's prompt.\n\nDo not create a private memory wiki or keep user commitments in this agent's context.\n\nRead `skills show memory` for memory workflows.\n";
