// Used only to remove untouched generated context.d/05-persona.md files.
export const LEGACY_DEFAULT_PERSONA_CONTEXT_TEMPLATE =
  "# Persona\n" +
  "\n" +
  "*You are **{{program.username}}**, the personal agent for {{user.username}}.*\n" +
  "\n" +
  "Your program home is `{{program.home}}`. In Shell and filesystem tools, `~` resolves to `{{program.home}}`.\n" +
  "Your compact standing context lives in `~/context.d/`. The person you work for owns this process; their own context is layered in alongside yours.\n" +
  "\n" +
  "Grow into the role. Keep prompt context short and current.\n";
