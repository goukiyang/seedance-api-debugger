# Ultimate Canvas Local SD2 Live Link

Date: 2026-07-15  
Status: Approved (local SD2 login and same-origin proxy)

## Context

The Ultimate Canvas browser client already submits upload, text, image, video, save, and polling requests through relative `/api/...` SD2 contracts. The local preview server intentionally replaces those contracts with Mock data or `REAL_BACKEND_REQUIRED`, so localhost cannot exercise the authenticated production chain.

## Goals

- Keep the current local canvas and its existing API payloads unchanged.
- Add an explicit local mode that proxies only canvas-related requests to `https://sd2.youdoodesign.com`.
- Let an ordinary SD2 account log in again on localhost without copying a production browser cookie.
- Preserve uploads, generated-media streaming, task polling, document save/restore, projects, video cards, and library requests.
- Make real mode opt-in so the default preview remains incapable of spending points.

## Non-goals

- Do not read or modify `.env`.
- Do not change admin API settings, provider keys, credit rules, or database schema.
- Do not call third-party providers from the browser or preview server.
- Do not create another canvas or generation workflow.
- Do not automate a paid generation during verification.

## Design

### Explicit runtime modes

`scripts/ultimate-canvas-preview-server.mjs` supports three mutually exclusive modes:

- Default preview: local fixtures, generation disabled.
- `--mock-generation`: deterministic Mock generation, no points.
- `--sd2-live`: local static assets plus an authenticated proxy to the fixed SD2 origin.

The process refuses to start when `--mock-generation` and `--sd2-live` are both present. The SD2 origin is a source constant rather than a browser-provided URL.

### Local login bridge

In live mode, `/__sd2-login` serves a minimal localhost-only account/password form. Its POST goes through the same proxy to `/api/auth/login`. SD2 validates the normal account and returns the existing `session` cookie. Because the upstream cookie has no `Domain` attribute, the browser stores it for localhost; it remains `HttpOnly`, `SameSite=Lax`, and is never exposed to canvas JavaScript.

The proxy does not log or persist credentials or session values. A missing local session redirects the canvas document to `/__sd2-login`; an expired session is handled by the existing 401 UI and can be renewed locally.

### Proxy boundary

A focused proxy module streams requests and responses without decoding uploads or media. It forwards method, query, body, `Cookie`, `Content-Type`, `Accept`, and range headers, rewrites `Origin`/`Referer` to the fixed SD2 origin, and preserves `Set-Cookie`, redirects, downloads, and partial-content responses.

Only these path families are eligible:

- `/api/auth/login`, `/api/auth/me`
- `/api/tools/ultimate-canvas/*`
- `/api/projects/*`, `/api/video-cards/*`
- `/api/assets/*`, `/api/tasks/*`, `/api/video/*`
- `/api/reference-albums/*`
- `/uploads/*`

Other proxy attempts return 404 locally. Static canvas files continue to come from the checked-out branch.

### User-visible state

The proxied SD2 bootstrap already reports `backend.mode = "sd2"`; the existing header therefore displays `SD2 真实后端`, real project/video-card context, and live point balance. No Mock fallback is permitted in this mode. Startup output also labels the URL as `SD2 LIVE` so the operator cannot confuse it with the safe preview.

## Failure behavior

- Upstream unavailable: return 502 with a concise local proxy error.
- Upstream 401: forward the real authentication response; never replace it with Mock data.
- Unsupported local route: return 404 and do not contact SD2.
- Conflicting runtime flags: fail startup before opening a port.

## Verification

- A focused smoke test starts a fake upstream and verifies allowlisting, login `Set-Cookie`, authenticated cookie forwarding, POST body/query forwarding, range/media streaming, and blocked routes.
- Existing preview smoke tests continue proving that default and Mock modes never become real silently.
- Browser verification logs in through localhost and confirms the real bootstrap, projects, points, save/restore, and asset library without submitting a paid generation.
- Full canvas smoke tests, TypeScript, syntax, lint, build, and `git diff --check` remain required.
