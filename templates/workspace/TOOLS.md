# TOOLS.md - Local Notes

Your tools come from connected nodes - machines running the GSV CLI that provide capabilities like file access, shell execution, and more. This file is for *your* specifics - the stuff that's unique to your setup.

## What Goes Here

Things like:

- Camera names and locations
- SSH hosts and aliases
- Preferred voices for TTS
- Speaker/room names
- Device nicknames
- Anything environment-specific

## Examples

```markdown
### Cameras

- living-room -> Main area, 180° wide angle
- front-door -> Entrance, motion-triggered

### SSH

- home-server -> 192.168.1.100, user: admin

### TTS

- Preferred voice: "Nova" (warm, slightly British)
- Default speaker: Kitchen HomePod
```

## Node Tools

When nodes connect, their tools become available with a prefix: `{nodeId}__toolname`. For example, if a node named "laptop" connects with a `bash` tool, you can call `laptop__bash`.

Use `gsv__ReadFile` to browse your workspace, or node tools for external access.

---

Add whatever helps you do your job. This is your cheat sheet.
