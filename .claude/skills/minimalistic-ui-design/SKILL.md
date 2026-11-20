---
name: minimalistic-ui-design
description: >-
  Use this skill whenever the user asks to build, implement, add, redesign, or review any UI, screen, page, component, form, dashboard, modal, panel, menu, or navigation in any project — even if they don't say "design" or "UI" explicitly, e.g. "add a settings page," "build a user profile screen," "make this table nicer," "clean up the dashboard." Also use it when the user asks for feedback, a design review, or improvements on existing frontend code. Always apply this skill's minimalist design principles (whitespace, visual hierarchy, limited on-screen elements, balanced spacing) to any UI work in this project, not just when explicitly asked for a "minimalist" look.
---

# Minimalistic UI Design

The goal is a UI where people can see what matters, read it easily, and do the main task without hunting. Minimalism here means every element has earned its place. It does not mean hiding functions or making the interface sparse for its own sake.

Start by identifying the kind of work, because the workflow differs:

- **New feature, page or screen:** follow "Building new UI".
- **Existing UI, or a request for feedback:** follow "Improving existing UI".
- **Small tweak to one element** (a label, a colour, one button): skip the questions, make the change, and keep it consistent with the principles below.

Before designing anything, look at what the project already has: components, design tokens, theme files, CSS variables, layout primitives. Reuse them. A new one-off style adds visual noise even when it looks fine alone. If the project has an established design system, its values replace the default numbers below, while the principles still apply.

## Building new UI

### 1. Ask about purpose and functionality first

A minimal design is built by deciding what to leave out, and that decision is impossible without knowing what the page is for. Before writing code, ask the user about anything the request and the codebase don't already answer:

- **Purpose:** what is this page or feature for, and who uses it?
- **Main task:** what is the one thing someone must be able to do here?
- **Functionality:** which actions and data are required, and which are occasional or nice to have?
- **Constraints:** devices to support, permissions, data volume, or an existing page to match?

Ask only what is still unknown, in one short round. If the user has already explained all of this, confirm your understanding in a sentence and continue.

### 2. Plan the content before the layout

Sort everything the page needs into three groups:

| Group | Treatment |
|---|---|
| **Essential:** needed for the main task | Visible and prominent |
| **Secondary:** used sometimes | Visible but quiet, or one click away |
| **Rare:** settings, advanced options, bulk actions | Behind a menu, disclosure or separate page |

Share this grouping with the user when the page is complex or the priorities are a judgment call, since it is much cheaper to change here than after building.

### 3. Build, then apply the removal test

Implement using the principles below. Then look at each element and ask what would be lost if it were removed. If the answer is "nothing much", remove it, merge it with something else, or move it a level down.

## Improving existing UI

Read the relevant code, and view the running UI when that is possible, because spacing and balance problems often can't be seen from code alone. Check both areas below.

**Design**
- Is the main purpose and main action obvious within a few seconds?
- Is any element redundant, decorative or competing for attention?
- Do spacing, type and colour follow a consistent system?
- Are tabs, menus and panels balanced, or is one area crowded while another sits empty?
- Is the text comfortable to read?

**Behaviour**
- Are loading, empty, error and success states handled?
- Do long text, large numbers, many rows and missing values hold up without breaking the layout?
- Does it work at phone, tablet and desktop widths?
- Does everything work by keyboard, with visible focus and clear labels?
- Do controls do what they appear to do, with feedback after an action and confirmation before a destructive one?

If the user asked for a review or feedback, report and don't edit. If they asked for improvements, apply the changes, keeping functionality intact and telling them about anything moved or removed. Removing a feature is the user's decision, so propose it and don't do it silently.

### Review report format

```markdown
## Verdict
[One or two sentences: how well this serves its purpose and the biggest opportunity.]

## Issues
| Priority | Where | Problem | Fix |
|---|---|---|---|
| High / Medium / Low | file:line or screen area | What is wrong and who it affects | Specific change |

## Can be removed or moved
[Elements that don't earn their place, and where each could go.]

## Working well
[What to preserve, so later changes don't undo it.]
```

High means people can't complete the task or something is broken. Medium means real friction or clutter. Low means polish. List the fewest, most useful issues and not every possible nitpick.

## Design principles

The numbers are sensible defaults. They exist to make decisions quick and consistent, so depart from them when the content has a good reason.

### Limit what is on screen

Every extra element makes all the others harder to notice.

- Give each screen one purpose and one primary action. Style other actions more quietly.
- Keep top-level navigation to about 5–7 items.
- Show the most useful information first and reveal detail on demand with disclosure, drawers or detail pages.
- Avoid repeating the same information or action in two places on one screen.
- Skip decoration that carries no meaning: ornamental icons, gradients, heavy shadows, badges with nothing to report.
- Keep something discoverable when it is out of the way. Hiding a frequently used function saves space but costs effort every time.

### Use whitespace as structure

Space can group and separate content without adding visible elements.

- Use one spacing scale built on 4 or 8 px (for example 4, 8, 16, 24, 32, 48, 64).
- Put related items closer together than unrelated ones, and keep padding inside a group smaller than the gap between groups.
- Prefer whitespace to borders, and use a thin divider or surface only when space alone isn't enough.
- Avoid a card inside a card, since each extra box adds outlines without adding meaning.

### Make the hierarchy obvious

People should be able to tell what to read first without thinking about it.

- Express importance through size and weight first, and colour second.
- Use one type family, about 3–4 text sizes per screen, and two weights.
- Use neutral colours plus one accent, reserving the accent for primary actions and key states.
- Use red, amber and green only for status, and pair them with text or an icon so colour isn't the only signal.

### Keep it easy to read

- Use at least 16 px for body text, about 14 px for secondary text, and a line height of 1.4–1.6.
- Keep text blocks to about 45–75 characters per line.
- Meet WCAG AA contrast: 4.5:1 for normal text and 3:1 for large text and control boundaries.
- Write short, specific labels. "Save changes" tells people more than "Submit".
- Left-align text and right-align numbers in tables so columns can be scanned.
- On zoomable canvases (graphs, maps, diagrams), keep labels at a constant on-screen size that matches the surrounding UI text, and hide them below a zoom level where they would overlap rather than letting them shrink or grow with the zoom.

### Balance tabs, menus and panels

Choose the pattern from what the content needs, and distribute weight evenly across the screen.

| Need | Use | Keep in mind |
|---|---|---|
| 2–5 peer views of the same subject | Tabs | Don't nest tabs inside tabs |
| More than about 5 sections in an app | Sidebar navigation | Group items and let it collapse |
| Occasional actions on an item | Overflow menu | Keep frequent actions outside it |
| Detail while keeping the list in view | Side panel, about 1/4–1/3 of the width | One panel at a time |
| A focused decision that must interrupt | Modal | Keep it short, and don't stack modals |

- Limit a layout to two main content regions, with a third only when it is clearly needed and collapsible.
- Align everything to a shared grid so edges line up across panels.
- Let the most important region take the most space, and avoid leaving large dead areas beside crowded ones.
- On narrow screens, stack regions in priority order and turn side panels into full-width views.

### Don't over-apply minimalism

- Keep text labels on anything whose meaning an icon alone wouldn't make clear, and give icon-only controls an accessible name and tooltip.
- Keep click targets at least 24×24 px, and about 44×44 px on touch screens.
- Don't remove focus outlines, form labels or error messages to get a cleaner look.
- Dense data screens are legitimate. For tables and dashboards, reduce noise through alignment, consistent number formats and fewer grid lines, not by dropping data people need.
- An explicit user request for a different style takes priority. Follow it, and mention a concern only if it would hurt usability.
