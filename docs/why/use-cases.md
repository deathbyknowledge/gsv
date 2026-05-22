# GSV Use Cases

These are the kinds of situations where GSV makes more sense than a plain chat
agent.

## Solo development across multiple machines

You want one agent that can:

- inspect a repo in the cloud workspace
- run commands on your laptop
- read and write files in a consistent way
- keep project continuity over time

GSV is strong here because devices and the cloud `gsv` target share the same tool
surface.

## Personal operations and private automation

You want an agent that can:

- run recurring operational checks
- manage notes, files, and scripts
- keep durable context about your preferences and environment
- interact with you through chat while still writing real artifacts

GSV is strong here because processes, schedules, files, and devices are all part
of one system model.

## Messaging-based access without turning everything into a bot silo

You want to reach the same system from:

- the Desktop
- the CLI
- WhatsApp
- Discord

GSV is strong here because adapters are routing surfaces into the same durable
process model, not separate bot products with separate state.

## Package-backed custom tools and apps

You want to extend the system with:

- browser apps
- backend logic
- CLI commands
- package-specific storage
- package-defined capabilities

GSV is strong here because packages behave more like installed software than like
one-off integrations.

## People who care about inspectability

You want to know:

- what the agent can see
- what files it changed
- how context is loaded
- where state lives
- why a tool call worked or failed

GSV is strong here because it exposes more of the machine model directly.

## When GSV is overkill

GSV is not the best choice for:

- simple one-shot prompting
- users who do not want to think about files, processes, or devices at all
- disposable AI interactions with no durable workflow behind them

## See also

- [Why GSV?](./)
- [Get Started](../get-started/)
- [Architecture Overview](../architecture/)
