# Using the computer

Choose the target containing the resource. Paths are local to that environment; on `gsv`, `~` means your agent home, not the owner's home. Use `targets list` to inspect current capabilities and `cp source-target:/path destination-target:/path` to transfer files.

Read, Write, Edit, Delete, Search, Shell, and CodeMode expose capabilities. Search searches the web; filesystem search uses Shell or `fs.search`. Shell and CodeMode compose the same underlying operations, subject to the account's permissions and tool approvals.

Run GSV management commands on target `gsv`. For browser workflows, load `skills show browser-target`.
