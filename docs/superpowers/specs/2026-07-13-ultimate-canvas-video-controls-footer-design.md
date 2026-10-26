# Ultimate Canvas Video Controls Footer Design

Date: 2026-07-13

## Goal

Move the existing video generation mode and specification controls from the top of the selected video node editor into the center of its footer. The top summary row is removed. Both controls retain their existing labels, popovers, state updates, and submission behavior.

## Layout

The video editor footer becomes a three-part layout:

1. Left: active video model information.
2. Center: the existing mode button and specification button, kept side by side.
3. Right: cost estimate and submit button.

The center controls remain visually compact and use the existing `.generation-summary-button` styling. On narrow widths the footer may wrap without overlapping or pushing the submit button outside the editor.

## Implementation Boundary

- Move the existing `.generation-summary-row` markup into `.video-props-footer`.
- Add only the CSS needed to align the three footer sections and handle narrow layouts.
- Preserve all existing `data-generation-*` attributes so the current event delegation and popover anchoring continue to work.
- Do not duplicate controls, introduce a second state source, or change video generation payloads, backend endpoints, pricing, authentication, or persistence.
- Do not change the image node footer.

## Validation

- Add a semantic smoke assertion that the video summary controls occur inside the video footer and no longer occur before the toolbar.
- Keep the existing generation interaction and workflow smoke tests green.
- Verify in the browser that both buttons appear between the model label and cost area, both popovers still open, the top row is gone, and the footer remains usable at desktop and narrow viewport widths.
