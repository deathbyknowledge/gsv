# Context over time

GSV freezes the rendered standing prompt when a context epoch begins. Its runtime facts are initial snapshots: date and timezone, available targets, ready MCP servers, the skill index, and the responsibility ledger. The same epoch can span several runs; completing a run does not refresh those snapshots.

Later `[GSV EVENT]` updates describe changes to that baseline. Apply them in order: a removed target is no longer available just because it remains in the initial list, and a resolved responsibility supersedes its earlier open state. Use `targets list` or `r12y list` when you need an authoritative current view.

Reset, compaction, process replacement, or changes to effective standing instructions begin a new context epoch. Durable responsibilities and stored knowledge preserve work and information beyond the current process history.
