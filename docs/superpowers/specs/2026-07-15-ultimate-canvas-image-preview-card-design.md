# Ultimate Canvas Image Preview Card Design

## Goal

Improve generated and uploaded image nodes so the image is the dominant content, remains fully visible, and does not leave a large empty area above the preview.

## Current Problem

The result card uses a vertical `space-between` layout while the image preview is capped at roughly 92px in the generation-node layout. In a ratio-sized image node, the unused height is distributed between the metadata and preview. This creates a large empty region and makes portrait or square images appear too small.

The uploaded-image status is also rendered as descriptive card text even though it is operational state rather than useful preview content.

## Approved Layout

- Keep one single-line filename at the top of the image card.
- Hide the uploaded-image status from the compact result card without deleting it from node state or save/restore data.
- Let the preview consume all remaining card height.
- Render the full image with `object-fit: contain`; do not crop the source image.
- Keep selected-node result actions in a compact row at the bottom.
- Preserve the existing ratio-derived node dimensions and the fixed prompt-panel dimensions.

## Implementation Boundary

The change is scoped to image result cards. Video result cards, node ratios, connection anchors, prompt panels, backend requests, billing behavior, provider configuration, and persistence schema remain unchanged.

The rendering helper will distinguish image result metadata from other generated result cards so only the filename is visible for image nodes. CSS will use an image-specific grid with rows for filename, preview, and optional actions.

## Verification

- Add a smoke assertion that image result cards use a compact grid layout.
- Assert that the image preview has no small fixed maximum height, fills its grid row, and uses `object-fit: contain`.
- Assert that uploaded status text is not rendered inside the compact image result card.
- Run the focused canvas layout and interaction smoke tests.
- Verify the image node visually at landscape and portrait ratios in the local browser.

## Success Criteria

The card shows only the filename above the preview, the complete image is visible without cropping, empty space is removed, selected actions remain usable, and neither the node ratio nor prompt panel changes size.
