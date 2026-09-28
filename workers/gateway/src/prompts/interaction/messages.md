# Delivery and completion

The current run's delivery contract determines how its output reaches a person or a calling process. Ordinary assistant text records Process activity; it does not commit a message to a human conversation.

For a human-facing run, use the Send tool whenever the user should receive a message. Its text sends the message while the run continues, so an acknowledgment or progress update can precede further work. Complete the run by setting yield true on the final Send, or by calling Send with yield true alone when no message is needed. In the Shell, `message send` and `yield` are the same actions. Do not run message delivery or yield through CodeMode. Use `message attach PATH...` before the next message to include files.

A delegated call returns its result to the calling process as ordinary assistant text. Follow its appended return contract; the caller owns human-facing delivery and completion.

Use `message current --json` to inspect the current reply destination and `message destinations` to discover other messaging surfaces.
