# Ultimate Canvas Local SD2 Live Link

Date: 2026-07-15  
Status: Approved (Feishu loopback login and same-origin proxy)

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

### Local Feishu login bridge

In live mode, `/__sd2-login` offers Feishu as the primary login method. It opens the deployed SD2 `/api/auth/feishu/authorize` route so the existing production Feishu application, state cookie, callback URI, provider secrets, tenant policy, and ordinary-account provisioning remain authoritative.

The OAuth state stores a special relative relay marker. After the deployed callback validates that state, it does not consume the code itself; it may forward the single-use Feishu authorization code only to an exact loopback callback (`http://127.0.0.1:<port>/__sd2-feishu-callback`, with equivalent `localhost`/`::1` hosts). External hosts, HTTPS targets, user-info URLs, fragments, unexpected paths, and invalid ports are rejected.

The localhost callback immediately removes the code from browser history and posts it through the fixed SD2 proxy to the existing `/api/auth/feishu/login-by-code` endpoint. SD2 exchanges the code, applies the normal account rules, and returns the existing `session` cookie. The browser stores that cookie for localhost; it remains `HttpOnly`, `SameSite=Lax`, and is never exposed to canvas JavaScript. No SD2 session token is placed in a URL.

The local login page also creates a five-minute, host-only `HttpOnly` relay-binding cookie and a matching in-memory nonce. The callback must consume that binding exactly once before it can receive an exchange-capable page. A successful callback then receives a separate 60-second one-time exchange permit. The proxy accepts `login-by-code` only from the exact local host and origin, with `POST`, `application/json`, and that permit; it consumes the permit before opening the upstream request and strips the local-only header before forwarding.

The proxy does not log or persist authorization codes, credentials, or session values. A missing local session redirects the canvas document to `/__sd2-login`; an expired session returns to the same local bridge through `/login`. Account/password login remains a secondary compatibility option.

### Proxy boundary

A focused proxy module streams requests and responses without decoding uploads or media. It forwards method, query, body, `Cookie`, `Content-Type`, `Accept`, and range headers, rewrites `Origin`/`Referer` to the fixed SD2 origin, and preserves `Set-Cookie`, redirects, downloads, and partial-content responses.

Only these path families are eligible:

- `/api/auth/login`, `/api/auth/me`, `/api/auth/feishu/login-by-code`
- `/api/tools/ultimate-canvas/*`
- `/api/projects/*`, `/api/video-cards/*`
- `/api/assets/*`, `/api/tasks/*`, `/api/video/*`
- `/api/reference-albums/*`
- `/api/approvals`
- `/uploads/*`

Other proxy attempts return 404 locally. Static canvas files continue to come from the checked-out branch.

### User-visible state

The proxied SD2 bootstrap already reports `backend.mode = "sd2"`; the existing header therefore displays `SD2 真实后端`, real project/video-card context, and live point balance. No Mock fallback is permitted in this mode. Startup output also labels the URL as `SD2 LIVE` so the operator cannot confuse it with the safe preview.

## Failure behavior

- Upstream unavailable: return 502 with a concise local proxy error.
- Upstream 401: forward the real authentication response; never replace it with Mock data.
- Unsupported local route: return 404 and do not contact SD2.
- Conflicting runtime flags: fail startup before opening a port.
- Invalid OAuth state or non-loopback relay target: preserve the normal SD2 callback error path and never expose the authorization code.

## Verification

- A focused smoke test starts a fake upstream and verifies allowlisting, login `Set-Cookie`, authenticated cookie forwarding, POST body/query forwarding, range/media streaming, and blocked routes.
- A pure relay smoke verifies valid loopback destinations, rejects open redirects, and locks the callback branch before code exchange. Proxy behavior tests also prove that missing, wrong, expired, cross-origin, wrong-host, non-JSON, wrong-method, and replayed permits cannot contact upstream.
- Existing preview smoke tests continue proving that default and Mock modes never become real silently.
- Browser verification completes Feishu login through localhost and confirms the real bootstrap, projects, points, save/restore, and asset library without submitting a paid generation.
- Full canvas smoke tests, TypeScript, syntax, lint, build, and `git diff --check` remain required.
