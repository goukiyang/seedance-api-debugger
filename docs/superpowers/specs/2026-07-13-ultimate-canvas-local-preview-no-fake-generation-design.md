# Ultimate Canvas Local Preview Without Fake Generation

Date: 2026-07-13

Target branch: `teammate/ultimate-canvas-complete`

## Context

Ultimate Canvas production requests already use the SD2 same-origin backend. The local preview server on port 4400 currently supplies an in-memory user, projects, documents, assets, text results, generated images, video tasks, and polling results. This is useful for automated interaction coverage, but a manually opened preview can look like a working generation environment even though no real model or account is involved.

The local preview must stop returning fake generation results by default. Automated tests may retain deterministic in-memory generation only when they explicitly opt in.

## Goals

- Keep the production SD2 same-origin request paths and ordinary-user authorization unchanged.
- Make the default local preview clearly identify that no SD2 generation backend is connected.
- Reject text, image, video, retry, and other paid generation mutations in default preview mode.
- Preserve the local fixture data needed to inspect and test the canvas layout without creating fake generated results.
- Preserve end-to-end generation lifecycle coverage behind an explicit test-only command-line switch.
- Keep third-party provider keys and backend configuration out of the browser and local preview.

## Non-Goals

- Do not proxy local browser requests to `https://sd2.youdoodesign.com`.
- Do not bypass authentication or make the local preview behave as an admin account.
- Do not change production generation routes, provider settings, credit rules, database schema, or `.env` files.
- Do not perform a real text, image, or video generation during this change.

## Runtime Modes

The preview server has two explicit modes.

### Default Preview Mode

Running:

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4400
```

serves the canvas and non-generation fixture data, but does not return fake generated content. Bootstrap reports a local preview backend that is not real and is not Mock generation. The UI label is `未连接 SD2`.

Generation and paid mutation endpoints return a structured unavailable response with an HTTP 503 status. The message explains that the local preview has no real SD2 backend and that the deployed same-origin application is required for real generation.

### Explicit Test Mock Mode

Running:

```powershell
node scripts/ultimate-canvas-preview-server.mjs 4400 --mock-generation
```

enables the existing deterministic in-memory text, image, video, task polling, and retry behavior. This mode exists only for automated tests and remains visibly identified as test Mock behavior.

The preview server must not infer test Mock mode from environment variables. The command-line flag is the only activation path.

## Backend Contract

The frontend backend contract gains a non-real local preview state in addition to the existing production SD2 and explicit test Mock states:

- Production: `{ mode: "sd2", transport: "same-origin", mock: false }`
- Local preview without generation: `{ mode: "preview", transport: "same-origin", mock: false }`
- Explicit test Mock: `{ mode: "mock", transport: "same-origin", mock: true }`

The contract maps these states to:

- SD2: label `SD2`, `isReal: true`
- Preview: label `未连接 SD2`, `isReal: false`
- Test Mock: label `测试 Mock`, `isReal: false`

Unknown or contradictory backend metadata remains an error and must not silently fall back to Mock.

## Request Behavior

Default preview mode continues to support read-only canvas inspection and fixture-backed document interactions. It rejects any endpoint that can claim to have generated, retried, uploaded to a provider, approved as a paid operation, or produced a billable task.

At minimum, default preview rejection covers:

- Text generation.
- Image generation and image variants.
- Video task creation.
- Paid retry and regeneration.
- Generation task state mutation that would synthesize a successful result.

The server returns a stable JSON error code such as `REAL_BACKEND_REQUIRED`, an HTTP 503 status, and a user-facing Chinese message. No fake asset URL, task ID, success state, or point estimate is returned in default mode.

Explicit test Mock mode preserves the current response contracts so lifecycle smoke tests can continue exercising submit, poll, restore, and result rendering.

## Frontend Experience

- The backend badge in default preview mode displays `未连接 SD2` instead of `本地 Mock`.
- The canvas remains usable for layout inspection, node editing, connection behavior, save/restore fixtures, and responsive QA.
- A generation attempt displays the structured unavailable message in the existing node error surface.
- The frontend does not fabricate a success state and does not retain a fake pending task after a 503 response.
- Production behavior is unchanged because production bootstrap remains `mode: sd2` and `mock: false`.

## Testing

Tests are divided by intent:

1. Default preview smoke starts the server without `--mock-generation` and verifies:
   - Bootstrap reports preview mode.
   - The UI contract maps the backend to `未连接 SD2` and `isReal: false`.
   - Text, image, video, and retry generation endpoints return HTTP 503 with `REAL_BACKEND_REQUIRED`.
   - Responses contain no fake task ID, generated asset URL, or succeeded result.

2. Lifecycle smoke starts the server with `--mock-generation` and verifies the existing deterministic generation, polling, recovery, and result contracts.

3. Same-origin contract smoke verifies:
   - Production remains `sd2`, same-origin, and `mock: false`.
   - Preview and test Mock metadata are distinct.
   - Contradictory metadata is rejected.

4. Browser QA verifies the default preview badge and one rejected generation attempt, with no console warning or error regression.

The final suite includes all Ultimate Canvas smoke scripts, JavaScript syntax checks, TypeScript, lint, build, and task-scoped `git diff --check`.

## Safety And Delivery

- No real model call or paid retry is performed.
- Points consumed remain zero.
- `.env`, admin API settings, provider secrets, credit core logic, and database schema are not read or modified.
- The implementation report records the files changed, commands run, results, generation/point status, protected-area status, remaining deployment work, and risks.

## Acceptance Criteria

- A manual port-4400 preview never returns fake text, image, video, task, or paid retry success by default.
- Fake generation is available only with the explicit `--mock-generation` flag used by tests.
- The default preview visibly says `未连接 SD2`.
- Production SD2 same-origin behavior and ordinary-user access rules are unchanged.
- Automated lifecycle coverage remains available and the full verification suite passes.
