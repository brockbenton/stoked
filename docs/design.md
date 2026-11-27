# Design

Screens are 390×844 at 2× in [`mockups/png/`](../mockups/png). The PNGs are the source of truth; HTML versions aren't available. Chat chrome is a neutral stand-in, so only the gift UI is ours to build.

| File | Screen |
|---|---|
| `01-sam-picks-a-gift` | Compose: stock grid, amounts, note, open-now/date switch, voice button |
| `02-maya-gets-a-wrapped-bubble` | Wrapped card in the thread |
| `03a-maya-unwraps-it-closed` | Wrapped box, expanded |
| `03b-maya-unwraps-it-opened` | Reveal: amount, shares, value, note, Claim / Swap |
| `04-bubble-updates-in-place` | Claimed card |
| `05-group-chip-in` | Group card with progress |

## Copy that differs from the mockups

The demo uses valueless test tokens, so:

| Mockup | Build |
|---|---|
| "A real stock inside" | "A stock gift inside" |
| "Send a real stock" | "Send a stock gift" |
| "Live value" | "Value" |

Hide the voice button and player until that stretch goal ships. Keep the eligibility footer on the reveal.

## Tokens

| Token | Hex | Use |
|---|---|---|
| `green-900` | `#12372A` | Buttons, wrap, selected states |
| `gold-500` | `#E8B33F` | Ribbon, icons on green, "Opened" badge |
| `gold-400` | `#F2C75C` | Bow |
| `green-50` | `#EEF4F1` | Selected stock card |
| `green-100` | `#DCE7E1` | Avatar |
| `gain` | `#16794A` | Value dot |
| `ink` | `#111111` | Primary text |
| `ink-muted` | `#5F5F5A` | Labels, secondary text |
| `ink-subtle` | `#6B6B6B` | Timestamps |
| `surface` | `#F6F6F4` | Drawer, note cards |
| `border` | `#E4E4E0` | Cards, chips |
| `bubble-in` / `bubble-out` | `#EDEDED` / `#1F1F1F` | Stand-in chat bubbles |

- **Type:** Inter 400–700 for UI; Space Grotesk 600/700 for the wordmark and large amounts. Body 15/20; labels 12 semibold uppercase, 0.04em; hero 34/42.
- **Shape:** cards 14–18px; pills fully rounded; sheets 20–22px top corners; touch targets at least 44px.
- **Wrap:** green box, 20–24px gold ribbon crossing behind a bow of two rotated oval loops and a knot.
- **Unwrap motion:** ribbon loosens, lid lifts, amount resolves; about 1.2s. With reduced motion, a crossfade.

## States the mockups don't show

Loading; not openable yet; claim pending (retryable); already claimed; claim failed; invalid link; chip-in goal reached; offline.
