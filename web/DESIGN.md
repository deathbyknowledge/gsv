# Design System Document: The Explorer’s Horizon

## 1. Overview & Creative North Star
**Creative North Star: The Celestial Expedition**

This design system is a bridge between the vast, untamed beauty of a primordial landscape and the precision of advanced interstellar travel. It rejects the "flat and sterile" tech aesthetic in favor of a "High-End Editorial" experience that feels both futuristic and deeply grounded in the earth. 

We move beyond standard UI templates by embracing **Intentional Asymmetry** and **Tonal Depth**. The layout should mimic the provided landscape: heavy, solid foundations (mountains) supporting light, airy, and floating structures (spacecraft). By utilizing overlapping elements, expansive negative space, and a cinematic typography scale, we create an interface that doesn't just display information—it narrates an adventure.

---

## 2. Colors: The Terracotta & Deep Sea Palette
Our palette captures the high-contrast drama of a sun-drenched valley meeting a deep oceanic basin.

*   **The Primary Core:** `primary` (#003466) represents the crushing depth of the sea, used for foundational elements and authoritative actions.
*   **The Terrestrial Warmth:** `secondary` (#904b36) and its variants provide the warmth of mountain terracotta. Use these for highlights and moments of human connection.
*   **The Cloud Canvas:** `surface` (#f7f9fc) and `surface_container_lowest` (#ffffff) provide the crisp, clean atmosphere of the spacecraft.

### The "No-Line" Rule
**Explicit Instruction:** Do not use 1px solid borders for sectioning. Boundaries must be defined solely through background color shifts. For example, a `surface_container_low` section should sit against a `surface` background to define its edge. This creates a more organic, premium feel that mimics the natural horizon line.

### Surface Hierarchy & Nesting
Treat the UI as a series of physical layers. Use the `surface_container` tiers to create depth:
*   **Base:** `surface`
*   **Nested Content:** `surface_container_low` or `high`
*   **Floating Detail:** `surface_container_lowest` (the "purest" white)

### The "Glass & Gradient" Rule
To evoke the spacecraft's canopy, use **Glassmorphism** for floating menus or overlay panels. Apply a semi-transparent `surface` color with a `backdrop-blur` (16px–32px). 
*   **Signature Textures:** For Hero sections or Primary CTAs, use a subtle linear gradient from `primary` (#003466) to `primary_container` (#1a4b84) at a 135-degree angle. This adds a "soul" and metallic sheen that flat color cannot provide.

---

## 3. Typography: Editorial Authority
The typography pairing reflects the dual nature of our North Star: technical precision and human narrative.

*   **Display & Headlines (Space Grotesk):** This typeface provides a technical, futuristic edge. Use large scales (`display-lg`: 3.5rem) with tighter letter-spacing (-0.02em) to create an authoritative, editorial impact.
*   **Body & Titles (Manrope):** A modern, geometric sans-serif that remains highly legible and warm. It grounds the technical headlines in a human-centric experience.

**Hierarchy Tip:** Use `label-md` in all-caps with a 0.1em letter-spacing for category tags, reminiscent of technical markings on a ship’s hull.

---

## 4. Elevation & Depth: Tonal Layering
Traditional drop shadows are often a crutch for poor contrast. This system prioritizes **Tonal Layering**.

*   **The Layering Principle:** Achieve lift by stacking. A `surface_container_lowest` card placed on a `surface_container_low` background creates a natural, soft lift.
*   **Ambient Shadows:** If a shadow is required for a floating spacecraft-like element, use a multi-layered shadow:
    *   `box-shadow: 0 20px 40px rgba(25, 28, 30, 0.06), 0 10px 10px rgba(25, 28, 30, 0.04);`
    *   The shadow must be tinted with `on_surface` to feel integrated.
*   **The "Ghost Border" Fallback:** For high-density data, use a `outline_variant` at **15% opacity**. Never use 100% opaque lines.
*   **Glassmorphism:** Use `surface_container_lowest` at 70% opacity with a blur to allow the terracotta mountain or oceanic blue tones to bleed through.

---

## 5. Components

### Buttons
*   **Primary:** A gradient of `primary` to `primary_container`. Shape: `md` (0.375rem) for a grounded, architectural feel.
*   **Secondary:** Ghost-style with a `primary` label and a 10% opacity `primary` fill on hover. No border.

### Cards & Lists
*   **Rule:** Forbid divider lines. Use `spacing-lg` (vertical whitespace) or a shift from `surface` to `surface_container_low` to separate items.
*   **Layout:** Cards should use the `xl` (0.75rem) roundedness to mimic the aerodynamic curves of the spacecraft seen in the reference image.

### Input Fields
*   **Style:** Minimalist. No bottom line or full box. Use a subtle `surface_container_high` background with a `sm` (0.125rem) corner radius.
*   **Active State:** The background shifts to `surface_container_highest` with a 2px `primary` accent on the left edge only.

### Navigation (The "Horizon Bar")
*   Floating at the top or bottom of the screen using the **Glassmorphism** rule. It should feel like it is hovering over the landscape of the content.

---

## 6. Do's and Don'ts

### Do
*   **Do** use asymmetrical layouts where text blocks are offset from images to create an editorial, magazine-like feel.
*   **Do** use `secondary` (#904b36) sparingly as a "call to adventure" accent.
*   **Do** lean into large images of landscapes to provide the "Grounded" part of the aesthetic.
*   **Do** ensure all interactive elements have a clear `surface_tint` state change.

### Don't
*   **Don't** use black (#000000). Use `on_surface` (#191c1e) for all deep tones.
*   **Don't** use standard "Material Design" shadows. Keep them diffused, light, and airy.
*   **Don't** crowd the interface. If a screen feels busy, increase the whitespace between sections by 2x.
*   **Don't** use 1px dividers. If you feel the need for a line, try a background color change first.