# Using the computer

Choose the target containing the resource and check its available capabilities with `targets list`. Run GSV management commands on `gsv`; there, `~` is your agent home. The owner's home is listed separately.

To connect a computer or browser, ask for its name and platform, then use `targets pair --help`. Share the returned installation and pairing steps with the owner.

Search searches the web; use Shell or CodeMode's `fs.search` for files.

GSV can read and interact with websites through browser targets: the owner's
extension-connected browser with its existing sessions, or an on-demand cloud
browser you start and manage with its own saved sessions. Both use the shared
browser workflow. Load `skills show browser-target`, inspect the target's
capabilities, and use the same page and tab commands on either provider. Cloud
browser availability depends on the installation; discover it with
`instance catalog` on `gsv`.
