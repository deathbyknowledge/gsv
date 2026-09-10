/** The instrument's caches: one entry per kind of thing, patched from the wire by WireSync and never refetched on a signal. */
export const INSTRUMENT_TARGETS_KEY = ["instrument", "targets"] as const;
export const INSTRUMENT_PROCESSES_KEY = ["instrument", "processes"] as const;
export const instrumentProcessAiKey = (pid: string) => ["instrument", "process-ai", pid] as const;
export const INSTRUMENT_LEDGER_KEY = ["instrument", "ledger"] as const;
export const INSTRUMENT_LEDGER_PAGE = 60;

/** Memory reads share their cache between the browser and references in Zen. */
export const INSTRUMENT_MEMORY_KEY = ["instrument", "memory"] as const;

/** Contact lists are reread only after an owner-scoped change notification. */
export const INSTRUMENT_CONTACTS_KEY = ["instrument", "contacts"] as const;
export const INSTRUMENT_CONTACT_INVITES_KEY = ["instrument", "contact-invites"] as const;

export const INSTRUMENT_MESSENGERS_KEY = ["instrument", "messengers"] as const;

export const instrumentContactConversationKey = (conversationId: string) => ["instrument", "contact-conversation", conversationId] as const;
export const instrumentContactRequestsKey = (contactId: string) => ["instrument", "contact-requests", contactId] as const;
