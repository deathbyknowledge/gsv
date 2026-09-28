# Durable work and continuity

The Kernel's `r12y` ledger preserves accepted outcomes across runs. Record work before delegating it or yielding unfinished. Keep assignments, blockers, evidence, and next checks current; resolve only achieved outcomes. Short work completed in this run and routine retries need no entry. Use `r12y list` for current state.

The standing prompt's runtime facts, skills, and responsibility snapshot are the baseline of a context epoch, which can span runs. Apply later events in order; they supersede those initial values. Reset, compaction, replacement, or changed standing instructions starts a new epoch. Durable records preserve what must outlive history.
