# Compact Image and Video Generation Nodes

Date: 2026-07-15  
Status: Approved direction (option 1: real-function-first compact redesign)

## Context

The current image and video generation nodes expose mode, reference, status, prompt, model, specification, cost, and task actions in several stacked rows. The controls work, but the repeated labels make selected nodes tall and visually noisy. The redesign should follow the supplied compact reference while preserving the existing canvas, same-origin sd2 backend integration, normal-account access, task polling, and save/restore behavior.

## Goals

- Give image and video nodes the same information hierarchy.
- Keep the preview card visually primary and the prompt editor compact.
- Show only controls backed by current real behavior.
- Keep media sized from the selected aspect ratio without resizing the prompt editor.
- Preserve the existing submit payloads, backend routes, polling, references, and task actions.
- Reduce persistent status and explanatory copy to the minimum needed to act.

## Non-goals

- No new backend endpoints or provider integrations.
- No placeholder controls for unsupported style, effects, subject, character-library, or storyboard features.
- No changes to `.env`, admin API settings, provider keys, credit rules, or database schema.
- No separate canvas or alternative generation flow.

## Shared Layout

### Preview card

- Keep the node label outside and above the card.
- Selection changes only the border treatment; it must not scale the node.
- Size the preview frame from the node's selected aspect ratio, within stable minimum and maximum dimensions.
- Empty image nodes show an image icon plus compact `Try` actions for text-to-image and reference-image generation.
- Empty video nodes show a play icon plus compact `Try` actions for first-frame and first/last-frame generation.
- Uploaded and generated media use `object-fit: contain` so the entire image or video remains visible.
- Retain only the file name when a useful name exists. Upload and generation status text moves to a compact overlay or status line.

### Prompt editor

- The prompt editor keeps one fixed responsive width independent of the preview aspect ratio.
- The top row contains only real, contextual tools.
- Image tools: add/select reference. Reference removal lives on each reference item, so a permanent `clear references` button is unnecessary.
- Video tools: add/select reference, optimize prompt, and camera presets. Task actions appear as a compact `more` icon only when available.
- The reference row is hidden when empty and appears only when references exist.
- A large borderless textarea occupies the flexible middle area.
- The footer contains model display, generation mode, one consolidated specification control, low-priority cost information, and submit.

### Specification popover

- Open from the consolidated footer specification control.
- Render only capability-backed options returned by the existing bootstrap data.
- Use tile/segmented controls for ratios and binary choices.
- Keep size/resolution, duration, audio, return-last-frame, watermark, and count only when supported for that node type.
- Update the compact footer summary immediately after a choice and keep the existing node settings persistence.

## States

- Idle: icon, compact quick actions, and no explanatory paragraph.
- Uploading/submitting/polling: preserve the preview footprint and show one concise status overlay.
- Success: show complete media; do not place task details or action buttons inside the media frame.
- Failure: show a concise error with a retry action. Detailed task actions stay in the contextual `more` menu.
- References: show thumbnails only when present; removal updates mode eligibility and saved node data as it does today.

## Interaction and Data Boundaries

- Existing delegated `data-generation-*` events remain the interaction contract.
- Existing image and video settings objects remain the persisted data contract.
- Existing same-origin sd2 submission, upload, polling, and normal-user authentication paths remain unchanged.
- Popovers are anchored to their footer controls, close on outside click or Escape, and remain inside the viewport.
- Selecting a node reveals the prompt editor without changing the preview card dimensions.

## Verification

- Add smoke coverage for compact DOM order, hidden empty-reference rows, media aspect-ratio sizing hooks, and real control wiring.
- Preserve and run the existing canvas smoke suites, TypeScript check, lint, and production build.
- Verify image and video nodes in the local browser at desktop and narrow viewports, including empty, selected, referenced, generating, success, and error states without paid generation.

