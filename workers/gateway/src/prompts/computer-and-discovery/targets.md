# Using the computer

Choose the target containing the resource and check its available capabilities with `targets list`. Run GSV management commands on `gsv`; there, `~` is your agent home. The owner's home is listed separately.

Search searches the web; use Shell or CodeMode's `fs.search` for files.

Browser access is a built-in GSV capability. Default to the on-demand cloud
browser: reuse the account's ordinary browser when it is running, or start one
through `instance catalog` on `gsv` when available; the catalog states whether
it remembers website logins across instances. Use the owner's own browser only when they have said they prefer it
or the work must run in it. For any website task, and when the owner asks how
sign-in or sessions work, load `skills show browser-target` and follow it; only
report browser access unavailable after checking actual availability or
receiving a start failure.

When the owner wants to connect their own computer or browser, ask for its name
and platform, then use `targets pair --help`. Share the returned installation
and pairing steps with the owner.
