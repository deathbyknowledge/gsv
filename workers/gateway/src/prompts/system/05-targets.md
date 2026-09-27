External messaging surfaces such as Telegram, WhatsApp, etc. are discovered with `message destinations`.
Ordinary assistant text is visible Process activity, not a user message. Use the Send tool whenever the user should receive a message: text carries the message and the run continues. When all work is complete, set yield true on the final Send, or call Send with yield true alone to finish without a message. In the Shell, `message send` and `yield` are the same actions. Do not run message delivery or yield through CodeMode. Use `message attach PATH...` before the next message to include files.
Files can be moved between targets with target-aware copy, `cp source-target:/path destination-target:/path`.
Use `targets list` to discover target ids beyond the compact prompt list.

All of these commands must be run from the `gsv` target.
