# Component authoring guide (ui/ atoms + catalog stories)

Conventions for components in `web/src/app/components/ui/` and their design-system
catalog stories. (Historical note: these atoms were originally ported from Claude
Design `.dc.html` sources; that migration is complete and the sources are gone —
what remains below are the conventions every new or edited atom must follow.)

## Outputs

- **Component:** `web/src/app/components/ui/<Name>.tsx` (+ `<Name>.css` only if it
  needs classes with pseudo-states; pure inline-style atoms like `StatusDot`/`Tag`
  need no `.css`).
- **Story:** `web/src/design-system/stories/<Name>.story.tsx` — default-exports a
  `Story` (see `web/src/design-system/story.ts`), registered in
  `web/src/design-system/catalog.tsx`.

## Canonical examples — read these first

- `web/src/app/components/ui/Button.tsx` + `Button.css` + `stories/Button.story.tsx`
  (variant enum, class CSS, disabled, native `<button type="button">`).
- `web/src/app/components/ui/TextInput.tsx` + `TextInput.css` + `stories/TextInput.story.tsx`
  (internal `useState`, controlled-by-prop-until-edited, status/size classes).
- `web/src/app/components/ui/StatusDot.tsx`, `Tag.tsx` (inline-style only, no `.css`).

## Rules — follow precisely

1. **Preact functional component.** `import { useState } from "preact/hooks";` for state.
   Use `class=` (not `className`), matching the existing files.
2. **Export the prop interface** and any variant/size enums as real TS types.
3. **Don't invent or "improve" colors, sizes, or spacing.** Use existing design tokens
   (`var(--token)`) where the design uses them; keep literal values literal.
4. **Font:** for the mono stack use `var(--gsv-font-mono)` (defined in `gsv-fonts.css`).
5. **State:** when a component accepts `value`, treat it as controlled whenever it is
   provided, as in `TextInput.tsx`.
6. **Pseudo-states** (`:hover`/`:active`/`:focus-within`) go in real CSS in the `.css`
   file. Don't use inline hover.
7. **Booleans:** props are real booleans, typed `boolean`.
8. **Handlers:** forward `onChange`/`onClick` semantics straight through; keep simple
   value-first signatures (e.g. `(value: string) => void`, `(index: number) => void`).
9. **SVG in JSX:** keep kebab-case attributes as-is (`stroke-width`, `stroke-linecap`) —
   Preact accepts them. See the clear icon in `TextInput.tsx`.
10. **Scope:** when authoring a component + story, don't modify `catalog.tsx`,
    `catalog.css`, `story.ts`, or other components — story registration is wired in
    `catalog.tsx` as its own explicit step.

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
- Confirm the story shows every state/variant/size the component exposes.
