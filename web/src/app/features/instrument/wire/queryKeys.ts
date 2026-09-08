/** The instrument's caches: one entry per kind of thing, patched from the wire by WireSync and never refetched on a signal. */
export const INSTRUMENT_TARGETS_KEY = ["instrument", "targets"] as const;
export const INSTRUMENT_PROCESSES_KEY = ["instrument", "processes"] as const;
export const INSTRUMENT_LEDGER_KEY = ["instrument", "ledger"] as const;
export const INSTRUMENT_LEDGER_PAGE = 60;
