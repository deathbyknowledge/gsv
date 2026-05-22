# Why GSV?

GSV exists because useful agents need a better runtime model than a chat box.

Most AI products are built around short-lived conversations, hidden state, and a
backend that feels opaque to the person using it. That model is fine for simple
Q&A. It breaks down when you want an agent to keep working over time, inspect
real files, route work across machines, and expose what it knows in a way you
can actually reason about.

GSV takes a different approach. It treats the system as a personal cloud
computer:

- agents are durable processes
- tools look like a Linux-shaped syscall surface
- context is inspectable and file-backed
- devices extend the same computer instead of acting like disconnected plugins
- packages can add apps, commands, and runtime behavior

## Why the usual chat model breaks down

Short-lived chat systems tend to hide the important parts:

- where the state lives
- what the agent can actually do
- what changed between runs
- how files, credentials, and devices are accessed
- why one conversation can do something another cannot

That makes them feel magical at first and frustrating later, especially once you
start depending on them for real work.

## What GSV does differently

GSV prefers explicit operating-system style affordances over hidden prompt magic.

Instead of pretending everything is a conversation, GSV gives you:

- durable processes with identities, working directories, and history
- files and repositories as first-class state
- the same tool surface across cloud and device targets
- inspectable config, context, packages, and capabilities
- routing that works across CLI, browser apps, adapters, and connected machines

## Who GSV is for

GSV is for people who want an agent system that can:

- keep working across resets and long-lived projects
- operate on real files and repositories
- route work to remote or local devices
- expose durable state instead of hiding it
- support both interactive use and automation

## Who it is not for

GSV is probably not the right fit if you want:

- a lightweight consumer chatbot
- a purely hosted tool with no concern for files or infrastructure
- a system where every detail is abstracted away
- a product optimized for one-shot prompting instead of durable work

## See examples

- [Use Cases](./use-cases.md)

## Where to go next

- [Get Started](../get-started/)
- [How-to Guides](../how-to/)
- [Architecture Overview](../architecture/)
- [Reference](../reference/)
