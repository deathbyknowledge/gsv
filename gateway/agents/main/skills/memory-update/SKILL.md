---
name: memory-update
description: Update long-term memory with important information the user wants you to remember
always: false
---

# Memory Update

Use this skill when the user explicitly asks you to remember something, or when you learn important persistent information about them.

## When to Use

- User says "remember that..." or "note that..."
- User shares preferences, schedules, or important personal information
- User corrects a misconception you had about them
- You discover something important that should persist across sessions

## How to Use

1. **Read existing MEMORY.md** to understand current context:
   ```
   Read path="MEMORY.md"
   ```

2. **Append new information** to the appropriate section:
   ```
   Edit path="MEMORY.md" oldString="## Section" newString="## Section\n\n- New information"
   ```
   
   Or if creating new sections:
   ```
   Edit path="MEMORY.md" oldString="(last section content)" newString="(last section content)\n\n## New Section\n\n- New information"
   ```

3. **Confirm** to the user what you've remembered

## MEMORY.md Structure

Organize memory into sections:
- **Preferences** - How they like things done
- **Projects** - Current work and side projects  
- **People** - Important people in their life
- **Schedule** - Regular commitments
- **Notes** - Miscellaneous important facts

## Example

User: "Remember that my weekly team standup is on Tuesdays at 10am CET"

1. Read MEMORY.md
2. Find or create "Schedule" section
3. Add "- Weekly team standup: Tuesdays 10am CET"
4. Confirm: "Got it! I've noted your Tuesday 10am standup."
