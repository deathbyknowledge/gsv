import { describe, expect, it } from "vitest";
import { parseFrontmatter, parseSkillEntry } from "./index";

describe("skills frontmatter parsing", () => {
  it("parses multiline metadata blocks with trailing commas", () => {
    const content = `---
name: github
description: "GitHub integration"
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "bins": ["gh"], "env": ["GITHUB_TOKEN"] },
      },
  }
---

# GitHub
Use gh.
`;

    const parsed = parseSkillEntry("github", content);

    expect(parsed.name).toBe("github");
    expect(parsed.metadata.description).toBe("GitHub integration");
    expect(parsed.metadata.openclaw?.emoji).toBe("🐙");
    expect(parsed.metadata.openclaw?.requires?.bins).toEqual(["gh"]);
    expect(parsed.metadata.openclaw?.requires?.env).toEqual(["GITHUB_TOKEN"]);
  });

  it("keeps body content intact after frontmatter", () => {
    const content = `---
name: coding-agent
description: Agent skill
---

# Coding Agent
Hello.
`;

    const { body } = parseFrontmatter(content);
    expect(body).toContain("# Coding Agent");
    expect(body).toContain("Hello.");
  });
});

