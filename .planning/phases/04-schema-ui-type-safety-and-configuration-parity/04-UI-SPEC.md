---
phase: 4
slug: schema-ui-type-safety-and-configuration-parity
status: approved
shadcn_initialized: false
preset: existing-webapp
created: 2026-05-01
---

# Phase 4 - UI Design Contract

> Visual and interaction contract for frontend phases. Generated inline by the plan-phase auto UI gate, verified against the existing webapp design system.

---

## Design System

| Property          | Value                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------- |
| Tool              | none                                                                                      |
| Preset            | Existing Signal K Edge Link admin webapp                                                  |
| Component library | React 16, RJSF v5                                                                         |
| Icon library      | none; preserve existing text/icon glyph usage for this maintenance phase                  |
| Font              | Inherit host/admin font; fallback remains `Segoe UI`, Tahoma, Geneva, Verdana, sans-serif |

---

## Spacing Scale

Declared values for touched configuration-panel UI:

| Token | Value | Usage                                                 |
| ----- | ----- | ----------------------------------------------------- |
| xs    | 4px   | Inline helper text, validation message offsets        |
| sm    | 8px   | Inline gaps, compact badges                           |
| md    | 12px  | Banner/card vertical rhythm already used by the panel |
| lg    | 16px  | Card body padding, toolbar top padding                |
| xl    | 20px  | Outer load/error padding and card stack gaps          |

Exceptions: preserve existing `.skel-*` values where this phase does not touch layout.

---

## Typography

| Role            | Size            | Weight  | Line Height |
| --------------- | --------------- | ------- | ----------- |
| Body            | 0.9rem-0.95rem  | 400     | inherit     |
| Label           | 0.9rem          | 500     | inherit     |
| Section heading | 1rem            | 600     | inherit     |
| Badge/counter   | 0.75rem-0.85rem | 600-700 | inherit     |

---

## Color

| Role            | Value                           | Usage                                                    |
| --------------- | ------------------------------- | -------------------------------------------------------- |
| Dominant (60%)  | `#ffffff`, `#f8f9fa`            | Form panels, card body, plugin settings surface          |
| Secondary (30%) | `#dee2e6`, `#ced4da`, `#6c757d` | Borders, muted copy, disabled state                      |
| Accent (10%)    | `#0d6efd`, `#2c5aa0`, `#4a90e2` | Primary save action, connection/system emphasis          |
| Destructive     | `#dc3545`                       | Remove button, duplicate-port and validation errors only |
| Warning         | `#fff3cd`, `#664d03`, `#ffc107` | Unsaved changes and saving state                         |
| Success         | `#d1e7dd`, `#0a3622`, `#28a745` | Save success and client/status badges                    |

Accent reserved for: save action, connection emphasis, existing cards/badges. Do not introduce a new palette in Phase 4.

---

## Copywriting Contract

| Element                  | Copy                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| Primary CTA              | `Save Configuration` when clean, `Save Changes` when dirty                                |
| Add server               | `+ Add Server`                                                                            |
| Add client               | `+ Add Client`                                                                            |
| Empty state heading      | Not introduced in Phase 4                                                                 |
| Error state              | `Error loading configuration:` followed by the error message                              |
| Duplicate server port    | `Port {port} is used by multiple server connections. Each server requires a unique port.` |
| Empty save error         | `Cannot save an empty configuration. Add at least one connection.`                        |
| Destructive confirmation | Not introduced in Phase 4                                                                 |

---

## Interaction Contract

- Preserve the existing card-based connection editor, collapsed/expanded card behavior, add/remove buttons, management token fields, dirty banner, and save status alerts.
- Type-safety work must not change visible field labels, button copy, badge copy, or save payload semantics except for intentional schema parity fixes.
- If `udpMetaPort` becomes visible in the form, label it `v1 Metadata UDP Port` and describe it as optional and only used for v1 metadata transport.
- Validation errors must stay inline or in the existing alert style; do not add modals or new navigation.

---

## Registry Safety

| Registry        | Blocks Used | Safety Gate                            |
| --------------- | ----------- | -------------------------------------- |
| shadcn official | none        | not applicable                         |
| third-party     | none        | no third-party registry blocks allowed |

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved 2026-05-01
