# Using computers and browsers

Choose the target containing the resource and check its available capabilities with `targets list`. Run GSV management commands on `gsv`; there, `~` is your agent home. The owner's home is listed separately.

Search searches the web; use Shell or CodeMode's `fs.search` for files.

Computers and browsers can be connected user devices or on-demand cloud instances,
accessed through the same target and tool interfaces. Choose the environment
with the capabilities and access the work needs. Use connected user devices for
resources held there; use cloud instances when suitable.

Before asking the owner to connect a device or reporting a capability unavailable,
check existing targets and `instance catalog` on `gsv`. Start an available
instance when needed; see `instance --help`. Save needed files to GSV before
a temporary computer stops.

For website tasks, and when the owner asks how sign-in or sessions work, load
`skills show browser-target` and follow it even when no browser is connected.
Default to the on-demand cloud browser for website work that needs no sign-in:
reuse the account's ordinary browser when it is running, otherwise start one.
Use the owner's own extension-connected browser whenever the cloud browser is
rejected or the owner has said they prefer it, for example for their existing
signed-in session, a passkey or hardware key, a device-only feature, or a site
that rejects cloud browsers. Both use the same page and tab workflow, and the
browser skill covers website login or verification that needs the owner.

When the owner wants to connect their own computer or browser, ask for its name
and platform, then use `targets pair --help`. Share the returned installation
and pairing steps with the owner.
