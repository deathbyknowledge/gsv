# Writing Your First Skill

In this tutorial, we will create a custom skill that teaches the GSV agent how to use a specific tool. We will write a `SKILL.md` file with frontmatter metadata, upload it to the agent's workspace, and verify the skill is loaded. By the end, your agent will have a new capability defined by your skill.

This tutorial assumes you have completed [Getting Started with GSV](getting-started.md) and have a deployed gateway with a connected node.

## 1. Look at an existing skill

Before writing our own, let's look at what an existing skill looks like. The GSV repository includes several skill templates. Here is the `github` skill (`templates/skills/github/SKILL.md`):

```markdown
---
name: github
description: "Interact with GitHub using the `gh` CLI."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "capabilities": ["shell.exec"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub...
```

Notice the structure:

- A YAML **frontmatter** block between `---` markers at the top
- `name` and `description` fields that identify the skill
- A `metadata` field containing a JSON object with requirement declarations
- A **body** with markdown instructions that get included in the agent's prompt

## 2. Plan your skill

For this tutorial, we will create a skill called `docker` that teaches the agent how to use Docker commands. The skill will:

- Require shell execution capability on a connected node
- Provide the agent with instructions for common Docker operations

## 3. Create the SKILL.md file

Create a file called `SKILL.md` with the following content. You can put it anywhere on your local filesystem for now -- we will upload it in the next step.

```bash
mkdir -p /tmp/gsv-skills/docker
```

Create `/tmp/gsv-skills/docker/SKILL.md` with this content:

```markdown
---
name: docker
description: "Manage Docker containers, images, and compose stacks."
metadata:
  {
    "gsv":
      {
        "emoji": "🐳",
        "requires": { "capabilities": ["shell.exec"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "docker",
              "bins": ["docker"],
              "label": "Install Docker (brew)",
            },
          ],
      },
  }
---

# Docker Skill

Manage containers, images, and compose stacks using the `docker` CLI.

## Common operations

List running containers:

    docker ps

List all containers (including stopped):

    docker ps -a

View container logs:

    docker logs <container-id> --tail 100

Start a compose stack:

    docker compose up -d

Stop a compose stack:

    docker compose down

Build an image:

    docker build -t <name>:<tag> .

## Troubleshooting

Check disk usage:

    docker system df

Remove unused resources:

    docker system prune

Inspect a container:

    docker inspect <container-id>
```

Let's walk through the frontmatter fields:

- **`name`** -- the skill identifier. Must be unique across all skills.
- **`description`** -- a short summary shown in skill listings.
- **`metadata`** -- a JSON object under the `gsv` key (this is the platform identifier). Inside it:
  - **`emoji`** -- a visual identifier for the skill.
  - **`requires.capabilities`** -- an array of capabilities that must be present on at least one connected node for this skill to be eligible.
  - **`install`** -- optional instructions GSV can show for installing missing dependencies.

The body after the frontmatter closing `---` is markdown that gets injected into the agent's system prompt when the skill is active. Write it as instructions the agent should follow.

## 4. Upload the skill to your agent's workspace

Skills live in R2 storage under the agent's workspace. The path format is `agents/{agentId}/skills/{skillName}/SKILL.md`. For the default agent (`main`), that means `agents/main/skills/docker/SKILL.md`.

We will use the CLI client to ask the agent to write the file itself. Since the agent has native workspace tools (`gsv__WriteFile`), it can create files in its own workspace.

Copy the full content of the SKILL.md file you created, then run:

```bash
gsv client "Please write the following content to your workspace at path skills/docker/SKILL.md (use gsv__WriteFile):"
```

Then paste the full SKILL.md content as a follow-up message, or include it inline. The agent will use `gsv__WriteFile` to save it.

Alternatively, if you have the R2 mount set up (`gsv mount start`), you can copy the file directly:

```bash
cp /tmp/gsv-skills/docker/SKILL.md ~/.gsv/r2/agents/main/skills/docker/SKILL.md
```

## 5. Make sure a node satisfies the skill's requirements

Our docker skill requires the `shell.exec` capability.

First, verify Docker is installed on your machine:

```bash
docker --version
```

If Docker is installed and your node is connected, you can verify current skill eligibility:

```bash
gsv skills status
```

You should see output listing all skills and their eligibility status. Look for the `docker` skill as `eligible`.

If it shows as ineligible, make sure your node is running and advertises `shell.exec` in its host capabilities.

## 6. Verify the skill is loaded

Now ask the agent about Docker to confirm it has the skill loaded:

```bash
gsv client "What Docker commands do you know? Do you have a Docker skill?"
```

The agent should reference the Docker skill instructions and demonstrate knowledge of the commands from your SKILL.md body.

You can also check the skill status directly:

```bash
gsv skills status
```

This shows all skills the agent has access to, their eligibility, and which node satisfies the requirements.

## What we accomplished

You created a custom skill that:

- Declares capability requirements in frontmatter metadata
- Provides structured instructions to the agent in the markdown body
- Is stored in the agent's workspace in R2
- Is automatically loaded into the agent's prompt when a connected node satisfies the requirements

## Frontmatter reference

Here is a summary of the metadata fields available under the `gsv` key in `metadata`:

| Field | Type | Purpose |
|---|---|---|
| `emoji` | string | Visual identifier |
| `requires.capabilities` | string[] | All listed capabilities required (actively enforced) |
| `install` | array | Dependency install instructions |

Each entry in `install` has:

| Field | Type | Purpose |
|---|---|---|
| `id` | string | Unique identifier for the install method |
| `kind` | string | One of: `brew`, `apt`, `node`, `go`, `uv`, `download` |
| `formula` / `package` | string | Package name for the installer |
| `bins` | string[] | Binaries provided by this install |
| `label` | string | Human-readable description |

You can also set `always: true` in the frontmatter (outside of `metadata`) to make the skill always load regardless of node availability.

From here, you can:

- Create more skills for other tools your agent should know about
- Browse the built-in skill templates in `templates/skills/` for more examples
- Share skills globally (stored at `skills/{skillName}/SKILL.md` in R2, available to all agents) vs. per-agent (stored at `agents/{agentId}/skills/{skillName}/SKILL.md`)
