# Task 2 Prompt Panel Correction Report

## Scope

- Restored the video and image prompt panels to the pre-Task-2 640px desktop editing surface.
- Kept the ratio-derived generation card dimensions and `.canvas-node` width basis unchanged.
- Kept the Task 3 right-aligned `更多` menu rules unchanged.
- Limited changes to the allowed CSS and result-layout smoke test files.

## RED

Updated `scripts/ultimate-canvas-result-layout-smoke.ts` before production CSS changes with the required panel declarations and portrait, landscape, and mobile geometry assertions. It also verifies the pre-Task-2 single-row behavior for the image footer, summary row, and toolbar.

Command:

```powershell
npx tsx scripts/ultimate-canvas-result-layout-smoke.ts
```

Observed failure:

```text
AssertionError [ERR_ASSERTION]: .node-video-props,
.node-image-props must set width: 640px

'350px' !== '640px'
```

The failing assertion identified the regression: Task 2 had changed the shared prompt panel width to `350px`.

## GREEN

Applied the minimal CSS correction:

- `width: 640px`
- `max-width: min(640px, calc(100vw - 24px))`
- preserved `margin-left: 0`, `left: 50%`, and `transform: translateX(-50%)`
- removed only the Task 2 `flex-wrap` declarations from `.image-props-footer`, `.generation-summary-row`, and `.generation-node-toolbar`

No aspect-ratio or generation-size variables were added to the prompt panels. No application, backend, persistence, pricing, settings, schema, package, lockfile, credential, or protected configuration files were read or changed.

## Verification

All required commands completed with exit code 0:

```powershell
npx tsx scripts/ultimate-canvas-result-layout-smoke.ts
# ultimate-canvas-result-layout-smoke passed

npx tsx scripts/ultimate-canvas-generation-node-interactions-smoke.ts
# ultimate-canvas-generation-node-interactions-smoke passed

npx tsx scripts/ultimate-canvas-complete-smoke.ts
# ultimate-canvas-complete-smoke passed

git diff --check
```

## Self Review

- Confirmed the diff touches only the two allowed implementation files plus this required report.
- Confirmed the restored panel remains centered independently of ratio-derived card width.
- Confirmed ratio-derived `.canvas-node` and card declarations remain unchanged.
- Confirmed the Task 3 `.generation-task-more` rule remains present and unchanged.
