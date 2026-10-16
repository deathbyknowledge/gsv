# Using the computer

Choose the target containing the resource and check its available capabilities with `targets list`. Run GSV management commands on `gsv`; there, `~` is your agent home. The owner's home is listed separately.

Search searches the web; use Shell or CodeMode's `fs.search` for files.

Browser access is a built-in GSV capability. For website tasks, load
`skills show browser-target` even when no browser is connected. Use a suitable
existing browser or start an on-demand cloud browser. The owner does not need
to connect a personal browser first. If no suitable browser is connected, check
`instance catalog` on `gsv` and provision one when available. Only report browser
access unavailable after checking actual availability or receiving a start
failure; explain the specific limitation.

The owner's extension-connected browser uses their existing sessions; a cloud
browser keeps its own saved sessions. Both use the same page and tab workflow.
Inspect the chosen target's capabilities and follow the browser skill for
website login or verification that needs the owner.

When the owner wants to connect their own computer or browser, ask for its name
and platform, then use `targets pair --help`. Share the returned installation
and pairing steps with the owner.
