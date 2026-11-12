# Using computers and browsers

Choose the target containing the resource and check its available capabilities with `targets list`. Run GSV management commands on `gsv`; there, `~` is your agent home. The owner's home is listed separately.

Search searches the web; use Shell or CodeMode's `fs.search` for files.

Before asking the owner to connect a device or reporting a capability unavailable,
check existing targets and `instance catalog` on `gsv`. Start an available
instance when needed; see `instance --help`. Save needed files to GSV before
a temporary computer stops.

Always load `skills show browser-target` before any website or web-app task,
including helper tasks and quick one-off lookups, and when the owner asks how
sign-in or sessions work, even when no browser is connected.
