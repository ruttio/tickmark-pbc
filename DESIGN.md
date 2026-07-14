---
name: Tickmark PBC Portal
description: A calm, precise document workflow for audit firms and their clients.
colors:
  audit-navy: "#081A34"
  ledger-navy: "#123563"
  action-mint: "#12B39A"
  signal-mint: "#5EEAD0"
  workspace-mist: "#F6F8FB"
  paper-surface: "#FFFFFF"
  rule-gray: "#E5E7EB"
  primary-ink: "#0F172A"
  secondary-ink: "#64748B"
  pending-amber: "#F59E0B"
  exception-red: "#EF4444"
  information-blue: "#3B82F6"
typography:
  display:
    fontFamily: "Inter, IBM Plex Sans Thai, system-ui, sans-serif"
    fontSize: "44px"
    fontWeight: 800
    lineHeight: 1.12
    letterSpacing: "0"
  headline:
    fontFamily: "Inter, IBM Plex Sans Thai, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0"
  title:
    fontFamily: "Inter, IBM Plex Sans Thai, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "0"
  body:
    fontFamily: "Inter, IBM Plex Sans Thai, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
  label:
    fontFamily: "Inter, IBM Plex Sans Thai, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0"
rounded:
  compact: "8px"
  control: "10px"
  medium: "12px"
  card: "14px"
  panel: "16px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.action-mint}"
    textColor: "{colors.paper-surface}"
    typography: "{typography.body}"
    rounded: "{rounded.medium}"
    padding: "11px 18px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 14px"
    height: "38px"
  input-default:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.primary-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.medium}"
    padding: "9px 13px"
    height: "40px"
  status-accepted:
    backgroundColor: "{colors.workspace-mist}"
    textColor: "{colors.action-mint}"
    typography: "{typography.label}"
    rounded: "{rounded.panel}"
    padding: "4px 10px"
  engagement-card:
    backgroundColor: "{colors.paper-surface}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.card}"
    padding: "16px"
  modal-panel:
    backgroundColor: "{colors.workspace-mist}"
    textColor: "{colors.primary-ink}"
    rounded: "{rounded.panel}"
    padding: "18px"
    width: "460px"
---

# Design System: Tickmark PBC Portal

## 1. Overview

**Creative North Star: "The Calm Audit Desk"**

Tickmark should feel like a well-run audit desk: every document has a place, every status is exact, and the next action is immediately clear. The interface is trustworthy, professional, and precise without becoming stiff. Firm users receive compact, scannable information; client users receive the same visual language with less density and more reassurance.

The system is restrained and operational. Navy establishes authority, mint marks progress and action, and neutral surfaces keep long review sessions calm. Decoration never competes with dates, counts, statuses, file names, or comments. The product must not feel like generic template SaaS, a cramped legacy ERP, or a playful consumer app.

**Key Characteristics:**

- Calm authority from a navy frame and cool, quiet work surfaces.
- Exact status communication using stable semantic colors and plain Thai copy.
- One visual vocabulary across firm and client experiences, with density adjusted by audience.
- Restrained motion and elevation that explain state instead of decorating the page.
- Thai-first typography with enough line-height for mixed Thai and Latin text.

**The Two Audiences, One Desk Rule.** Firm and client views always share colors, type, controls, and status language; only information density changes.

## 2. Colors

The palette is a disciplined navy-and-mint system supported by cool neutrals and unambiguous semantic status colors.

### Primary

- **Audit Navy** (`audit-navy`): The deepest authority color. Use it for the global frame, secure environments, and high-contrast brand moments.
- **Ledger Navy** (`ledger-navy`): The lighter navy for secondary navigation, links, and structure within the audit workspace.
- **Action Mint** (`action-mint`): The primary action and accepted-state color. Its purpose is progress, selection, and completion—not decoration.
- **Signal Mint** (`signal-mint`): A brighter supporting mint for marks and highlights placed on navy surfaces.

### Neutral

- **Workspace Mist** (`workspace-mist`): The cool page background that separates work areas without adding visual noise.
- **Paper Surface** (`paper-surface`): The working surface for cards, controls, lists, and modal content.
- **Rule Gray** (`rule-gray`): Dividers, input outlines, and quiet container boundaries.
- **Primary Ink** (`primary-ink`): Default high-contrast text and dense data.
- **Secondary Ink** (`secondary-ink`): Supporting labels and metadata; never use it where contrast becomes marginal.

### Semantic

- **Pending Amber** (`pending-amber`): Waiting, approaching deadlines, and review states.
- **Exception Red** (`exception-red`): Overdue, returned, destructive, and failed states only.
- **Information Blue** (`information-blue`): Neutral informational activity such as comments and unread updates.

**The One Signal Rule.** Mint is reserved for primary actions, current selection, progress, and accepted states. If mint appears where nothing can happen and no state is being communicated, remove it.

**The Semantic Stability Rule.** Amber always means pending or attention; red always means exception or danger; blue always means information. Never change those meanings between screens.

## 3. Typography

**Display Font:** Inter (with IBM Plex Sans Thai, system UI, and sans-serif fallbacks)  
**Body Font:** Inter (with IBM Plex Sans Thai, system UI, and sans-serif fallbacks)  
**Label Font:** Inter (with IBM Plex Sans Thai, system UI, and sans-serif fallbacks)

**Character:** One familiar sans-serif system keeps the product operational and consistent. Weight and spacing create hierarchy; display styling never leaks into buttons, labels, or data.

### Hierarchy

- **Display** (800, `44px`, `1.12`): Authentication and singular high-emphasis titles only; reduce to `34px` on narrow mobile screens.
- **Headline** (700, `24px`, `1.1`): Page titles and primary workspace headings.
- **Title** (700, `17px`, `1.2`): Engagement names, card titles, and modal subheads.
- **Body** (400, `13.5px`, `1.5`): Default instructions, descriptions, and workflow copy; prose is capped at `70ch`.
- **Label** (600, `11px`, `1.2`): Statuses, metadata, and compact control labels. Uppercase is permitted only for short system identifiers, never Thai sentences.

**The Thai-First Clarity Rule.** Thai and Latin must share a stable baseline and comfortable line-height. Never tighten Thai labels merely to match an English mockup.

**The Data Is the Point Rule.** Dates, counts, percentages, file names, and statuses must be as legible as headings. Never trade numeric clarity for typographic drama.

## 4. Elevation

Tickmark is flat by default. Page hierarchy comes first from navy framing, cool background layers, white working surfaces, and rules. Shadows are ambient and reserved for genuinely elevated or interactive layers; they must never be the only signal that a control exists.

### Shadow Vocabulary

- **Soft Surface** (`0 16px 40px rgba(8,26,52,.08)`): Cards and compact floating panels when separation from Workspace Mist is necessary.
- **Panel Overlay** (`0 24px 60px rgba(8,26,52,.14)`): Modals, notification panels, and temporary layers above a scrim.
- **Mint Action** (`0 10px 22px rgba(18,179,154,.22)`): Primary-action emphasis on navy or quiet neutral surfaces; remove it when the action is disabled.
- **Visible Focus** (`0 0 0 4px rgba(18,179,154,.14)`): Keyboard focus around fields and critical controls, paired with a mint border or outline.

**The Flat-by-Default Rule.** A surface starts flat. Add elevation only when it floats, opens, or needs to clarify an interaction layer.

**The One Depth Cue Rule.** Do not combine a decorative wide shadow with a prominent border. Use a quiet boundary for resting content and an ambient shadow for elevated content.

## 5. Components

Components are restrained and operational: familiar shapes, explicit states, stable semantics, and generous enough targets for occasional client users.

### Buttons

- **Shape:** Gently curved rectangular controls (`10px`–`12px` radius), never oversized pills.
- **Primary:** Mint action surface with white text, strong weight, and `11px 18px` padding. Use once per action cluster.
- **Hover / Focus:** Brightness or a one-pixel lift may acknowledge hover; visible mint focus treatment is mandatory. State transitions stay between `140ms` and `200ms`.
- **Secondary:** White surface, Primary Ink text, and a Rule Gray border with `9px 14px` padding.
- **Disabled:** Preserve the label, reduce emphasis, remove the action shadow, and show a non-interactive cursor.

### Status Chips

- **Style:** Compact semantic tint with matching semantic text, `4px 10px` padding, and a `16px` radius.
- **State:** Slate is outstanding, blue is informational, amber is pending, mint is accepted, and red is overdue or returned.
- **Copy:** Status text is plain Thai and never relies on color alone.

### Cards / Containers

- **Corner Style:** Moderately curved (`14px` cards; `16px` panels).
- **Background:** Paper Surface over Workspace Mist.
- **Shadow Strategy:** Soft Surface only when a card must read as interactive or raised.
- **Border:** One-pixel Rule Gray boundary for lists and resting containers.
- **Internal Padding:** `16px` for cards and `18px` for panel bodies.

### Inputs / Fields

- **Style:** White field, Primary Ink text, Rule Gray outline, and an `8px`–`12px` radius depending on density.
- **Focus:** Mint border plus a visible focus ring; never remove focus without replacing it.
- **Error / Disabled:** Exception Red is reserved for actionable errors. Disabled fields remain readable and visibly inactive.
- **Placeholder:** Placeholder copy must remain readable and specific; never use it as the only label.

### Navigation

- **Style:** Sticky Audit Navy-to-Ledger Navy frame with Signal Mint brand cues and white controls.
- **States:** Hover is a subtle lightening of the navy surface; current location or selection uses mint purposefully.
- **Responsive:** Navigation may wrap or collapse structurally; core identity, current context, and exit controls remain visible.

### Engagement Card

The engagement card summarizes client, period, completion, and attention states in one scan. The title dominates, percentage and progress support it, and status tags remain compact. The whole surface is interactive with a visible focus state; internal decoration never competes with the client name.

### Upload Dropzone

The client upload target uses a dashed Action Mint boundary and a quiet mint tint. Drag state increases the tint, while copy lists accepted formats and keeps the explicit choose-file action visible. Uploading, success, validation failure, and disabled states must be expressed in text as well as color.

### Modal / Drawer

Temporary layers use a navy scrim and Panel Overlay shadow. Modals top out at `460px` by default; drawers top out at `420px` or `94vw`. Closing is available by a labeled control and keyboard, and destructive confirmation never hides its consequence.

**The Same Job, Same Control Rule.** If two actions perform the same job, they use the same component, shape, state language, and icon treatment everywhere.

## 6. Do's and Don'ts

### Do:

- **Do** preserve the existing navy/mint system and reserve Action Mint for progress, selection, acceptance, and primary action.
- **Do** make every status chip, date, count, and progress figure exact and highly legible.
- **Do** use one component vocabulary across firm and client surfaces while adjusting density for the audience.
- **Do** keep motion between `150ms` and `250ms`, use it to communicate state, and provide a reduced-motion alternative.
- **Do** keep keyboard focus visible and maintain at least `4.5:1` contrast for body and placeholder text.
- **Do** test Thai labels, long client names, dates, percentages, empty states, loading states, and mobile wrapping before shipping.

### Don't:

- **Don't** turn Tickmark into generic template SaaS: no rainbow gradients, endless identical icon-heading-text card grids, or big hero-metric vanity blocks.
- **Don't** make it feel like a stiff, outdated government or legacy-ERP system: never dense, cramped, gray, or hostile.
- **Don't** make it playful or toy-like: no candy colors, cartoon illustration, or emoji-as-personality that undercuts financial trust.
- **Don't** use decorative motion, orchestrated page-load sequences, or effects that do not explain state.
- **Don't** invent different button, input, chip, or modal styles for the same job on different screens.
- **Don't** use a colored side stripe wider than `1px` as a status accent; use a full tint, chip, icon, or semantic label instead.
- **Don't** pair a one-pixel decorative border with a wide soft shadow on the same resting surface.
- **Don't** use mint, amber, red, or blue as decoration; every semantic color must communicate action or state.
