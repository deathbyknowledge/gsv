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

For website tasks, load `skills show browser-target` even when no browser is
connected.

The owner's extension-connected browser uses their existing sessions; a cloud
browser keeps its own saved sessions. Both use the same page and tab workflow.
Inspect the chosen target's capabilities and follow the browser skill for
website login or verification that needs the owner.

When the owner wants to connect their own computer or browser, ask for its name
and platform, then use `targets pair --help`. Share the returned installation
and pairing steps with the owner.
