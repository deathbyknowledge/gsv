# GSV Architecture Explorer

## Job

Explain the repository's runtime architecture as an inspectable system map. The
surface turns GSV's source ownership, trust boundaries, and request paths into a
navigable visual model without becoming a source of runtime state.

## Questions answered at a glance

- Which subsystem owns a behavior?
- What are that subsystem's major components and source paths?
- How do requests, messages, syscalls, and durable data move through GSV?
- Where are the important authorization, identity, cancellation, and storage
  boundaries?

## Primary actions

1. Select a subsystem on the map and inspect its responsibility boundary.
2. Drill into a component to understand what it does and where it lives.
3. Follow a guided end-to-end flow or search for a concept/source path.

## Layout

- A command strip for search, flow selection, and view controls.
- An fsn-inspired perspective map of repository-owned subsystems.
- A persistent inspector with subsystem and component explanations.
- A compact flow sequencer that highlights the active path across the map.

## Out of scope

- Live health, deployment, configuration, or permission state.
- Editing source, configuration, prompts, or runtime data.
- Replacing the operational Processes, Machines, Files, Repositories, or
  Integrations surfaces.

The architecture data is deliberately explicit and source-linked. It is an
explanatory projection maintained with architectural changes, not a second
runtime discovery mechanism.
