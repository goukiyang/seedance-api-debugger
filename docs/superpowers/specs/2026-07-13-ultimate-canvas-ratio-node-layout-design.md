# Ultimate Canvas Ratio-Aware Node Layout Design

Date: 2026-07-13

Branch: `teammate/ultimate-canvas-complete`

## Goal

Make image and video node cards reflect the selected generation ratio while keeping the selected prompt/settings panel visually stable. The node card uses a fixed maximum long edge and derives its short edge from the current ratio. The prompt/settings panel remains a normal fixed-width form and does not inherit the media ratio.

## Confirmed Visual Rules

- Supported ratios remain `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, and `9:16`.
- On desktop, the node card's long edge is `350px`.
- Landscape dimensions use `width = 350` and `height = 350 / ratio`.
- Portrait dimensions use `height = 350` and `width = 350 * ratio`.
- Square nodes are `350x350`.
- The prompt/settings panel is always `350px` wide with natural content height. It is centered below the node card and never receives `aspect-ratio`.
- On narrow viewports, the long edge becomes `min(350px, calc(100vw - 24px))`; the same ratio calculation applies. The prompt/settings panel independently uses that same capped width.

Examples at desktop size:

| Ratio | Node card | Prompt/settings panel |
| --- | --- | --- |
| `16:9` | `350x197` | `350px` wide, natural height |
| `1:1` | `350x350` | `350px` wide, natural height |
| `9:16` | `197x350` | `350px` wide, natural height |

## Architecture

### Pure dimension calculation

`generation-node-interactions.js` will expose a pure ratio-to-dimensions helper. It will parse only the supported ratio set, calculate width and height from a supplied long edge, and return the normalized ratio plus CSS-safe dimensions. Missing or invalid ratios fall back to `16:9`.

This keeps ratio arithmetic out of rendering code and gives the smoke tests an executable contract.

### DOM application

`renderGenerationNodeControls(nodeId)` already reads `imageSettings.ratio` or `videoSettings.ratio` whenever a node is created, restored, selected, or edited. It will call the pure helper and write the result to CSS custom properties on the corresponding `.canvas-node`:

- `--generation-node-width`
- `--generation-node-height`
- `--generation-node-ratio`

Changing a ratio in the existing specification popover updates node data, rerenders the same node, and immediately refreshes these variables. No new state store or workflow is introduced.

### Card and result layout

`styles.css` will consume the custom properties for image/video `.node-card` width and height. Selected and unselected cards use the same dimensions.

Because very wide ratios have limited height and portrait ratios have limited width, generated result content becomes media-first:

- The result card fills the ratio-aware node card.
- Media uses `object-fit: contain` and is never cropped.
- Title/status occupy a compact top overlay with ellipsis where needed.
- Result actions remain a 24px bottom row and can scroll horizontally without a visible scrollbar.
- Empty-node quick actions remain centered and wrap within the available width.

No result action is removed. Video task, preview, download, retry, candidate, best, and final-version actions remain accessible.

### Prompt/settings panel

`.node-video-props` and `.node-image-props` will use a fixed `350px` desktop width and natural height. They are centered with `left: 50%` and `transform: translateX(-50%)` relative to the node, so the centering remains correct for every ratio without duplicating ratio arithmetic in CSS.

Rows and toolbars may wrap at 350px, but controls keep their current meaning and submission behavior. Popovers continue to use the existing viewport-aware positioning and are not constrained to the node ratio.

### Connections and persistence

The existing `ResizeObserver` remains the single mechanism for refreshing connection paths after card dimensions change. Connector ports stay at the actual vertical center of the current card.

Ratio data is already persisted in `imageSettings` and `videoSettings`. The new CSS variables are derived presentation state and are not saved in the canvas document.

## Error Handling

- Invalid or missing ratios normalize to `16:9`.
- Non-numeric or non-positive long-edge inputs fall back to `350`.
- If a restored node has legacy settings without a ratio, its existing context fallback is used before the final `16:9` fallback.
- A ratio rendering failure must not block generation submission or canvas saving.

## Scope

In scope:

- Image and video node card dimensions.
- Selected prompt/settings panel width and centering.
- Generated result compaction required to preserve actions inside ratio-aware cards.
- Desktop and mobile layout tests.

Out of scope:

- Text, audio, director, camera, or other node types.
- Backend request contracts, provider routing, model settings, pricing, credits, authentication, admin behavior, or database schema.
- Changing the actual generated media ratio; this work only reflects the ratio already selected for generation.

## Test Strategy

1. Add pure helper tests for every supported ratio, desktop long edge, mobile long edge, and invalid-ratio fallback.
2. Update the semantic CSS smoke to reject fixed `350x240` cards and assert CSS-variable dimensions, fixed-width prompt panels, centered transforms, compact result overlays, and retained 24px actions.
3. Verify ratio changes call the existing rerender path and update derived dimensions without changing request payloads.
4. Run all 11 Ultimate Canvas smoke scripts, TypeScript, lint, build, and `git diff --check`.
5. Browser acceptance:
   - `16:9`, `1:1`, and `9:16` cards match calculated dimensions.
   - Selection does not alter card dimensions.
   - The prompt/settings panel remains 350px wide and centered for all ratios.
   - Actions remain inside the card and usable.
   - At 390px, document width equals scroll width and the panel remains centered.
   - Browser warning/error log remains empty.

## Acceptance Criteria

- Ratio changes immediately resize only the image/video card.
- Card dimensions use a 350px maximum long edge and the selected exact ratio.
- Selecting a node does not resize its card.
- The prompt/settings panel remains a normal 350px-wide form with natural height and is centered below the card.
- Generated media is not cropped and result actions remain available.
- Saved/restored nodes recover the same dimensions from existing ratio settings.
- No backend, provider, credit, authentication, admin, secret, or schema behavior changes.
