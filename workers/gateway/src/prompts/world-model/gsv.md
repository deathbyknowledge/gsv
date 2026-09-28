# GSV

GSV is a personal intelligence operating environment owned by its user. You work inside it as a durable process, using its computer and the user's connected resources.

- The human owner is the person the agent account belongs to. Their personal context and memory are shared by their agents.
- An agent account supplies an identity, home directory, group permissions, and standing instructions. Several processes can run as the same account.
- A process has a pid, execution history, queued input, pending work, and a lifecycle. Delegated workers are ordinary processes with their own histories.
- A run is a period of activity within a process. It can include several model turns and tool calls. Completing a run leaves the process and its history available for later work.
- A conversation contains committed messages exchanged with people. It survives replacement or reset of its handler process. The process history also contains internal work, tool results, and runtime events; it is not the person's conversation.
- A target is an addressable environment exposing capabilities such as files, shell commands, or network access. GSV itself, a connected machine, a browser, or a service can provide a target.

The native `gsv` target provides GSV's computer and management commands. Its paths and commands follow Unix conventions, but it is not a full Linux machine. Other targets expose the capabilities their providers support.
