# Atom porting guide (.dc.html → Preact)

How to port a GSV design-system component from its Claude Design `.dc.html` source
into this web client. Follow this exactly so every ported atom is consistent.

## Inputs & outputs

- **Source:** `/tmp/gsv_design/<Name>.dc.html` (read the WHOLE file).
- **Component output:** `web/src/app/components/ui/<Name>.tsx` (+ `<Name>.css` only if
  the source has a `<style>` block with classes; pure inline-style atoms like
  `StatusDot`/`Tag` need no `.css`).
- **Story output:** `web/src/design-system/stories/<Name>.story.tsx` — default-exports a
  `Story` (see `web/src/design-system/story.ts`).

## Canonical examples — read these first

- `web/src/app/components/ui/Button.tsx` + `Button.css` + `stories/Button.story.tsx`
  (variant enum, class CSS, disabled, native `<button type="button">`).
- `web/src/app/components/ui/TextInput.tsx` + `TextInput.css` + `stories/TextInput.story.tsx`
  (internal `useState`, controlled-by-prop-until-edited, status/size classes).
- `web/src/app/components/ui/StatusDot.tsx`, `Tag.tsx` (inline-style only, no `.css`).

## Rules — follow precisely

1. **Preact functional component.** `import { useState } from "preact/hooks";` for state.
   Use `class=` (not `className`), matching the existing files.
2. **Props mirror the `data-props` JSON** at the bottom of the `.dc.html`. Turn each
   `tsType` into a real TS type. Export the prop interface and any enums.
3. **Transcribe values VERBATIM.** If the source CSS uses a literal hex (`#5a52a8`),
   keep the literal hex. If it uses `var(--token)`, keep the `var(--token)`. **Do NOT
   convert between them, and do NOT invent or "improve" any color, size, or spacing.**
   This is a faithful port, not a redesign.
4. **Font:** wherever the source sets `font-family:'Departure Mono','JetBrains Mono',monospace`,
   use `var(--gsv-font-mono)` instead (defined in `gsv-fonts.css` — same stack).
5. **State:** the `.dc.html` uses `class Component extends DCLogic { state=…; renderVals() }`.
   Port `this.state`/`setState` to `useState`. When a component accepts `value`,
   treat it as controlled whenever it is provided, as in `TextInput.tsx`.
6. **Pseudo-states** (`:hover`/`:active`/`:focus-within`) go in real CSS in the `.css`
   file (the source keeps them in its `<helmet><style>`). Don't use inline hover.
7. **Booleans:** props are real booleans here (the catalog passes real booleans), so you
   do NOT need the source's `=== 'true'` string coercion. Just type them `boolean`.
8. **Handlers:** preserve `onChange`/`onClick` semantics — forward them straight through.
   `onChange` signatures follow the source (e.g. `(value: string) => void`,
   `(index: number) => void`).
9. **SVG in JSX:** keep kebab-case attributes as-is (`stroke-width`, `stroke-linecap`) —
   Preact accepts them. See the clear icon in `TextInput.tsx`.
10. **Do NOT** modify `catalog.tsx`, `catalog.css`, `story.ts`, other components, or any
    file outside your assigned set. The orchestrator wires story imports into the catalog.

## Story file shape

```tsx
import { Foo } from "../../app/components/ui/Foo";
import type { Story } from "../story";

const story: Story = {
  title: "Foo",
  group: "Forms", // Foundations | Forms | Feedback | Data Display | Chrome | Composite
  blurb: "short · description",
  render: () => (
    <div class="ds-col">
      <div class="ds-cell">
        <div class="ds-label">Variants</div>
        <div class="ds-row">{/* every variant */}</div>
      </div>
      {/* + sizes, states, disabled, etc. — show the full surface */}
    </div>
  ),
};
export default story;
```

Catalog layout helpers available (from `catalog.css`): `ds-col`, `ds-row`, `ds-grid`,
`ds-cell`, `ds-label`. The catalog backdrop is dark, so components render in context.

## Verify before finishing

- `cd web && npx tsc --noEmit` — your files must add **no** type errors.
- Re-read your `.tsx` against the `.dc.html` and confirm every state/variant/size is present
  and values match exactly.
