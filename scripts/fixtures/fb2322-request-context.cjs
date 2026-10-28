'use strict';

// Use Next's actual request/cookie storage. No replacement getSession or user proof.
exports.requestContext = function requestContext(headers, work) {
  const major = Number(require('next/package.json').version.split('.')[0]);
  if (major === 14) {
    const { requestAsyncStorage } = require('next/dist/client/components/request-async-storage.external');
    const { RequestCookies, HeadersAdapter } = require('next/dist/server/web/spec-extension/adapters/headers');
    // RequestCookies is supplied by the cookie adapter on supported Next 14 builds.
    const CookieClass = RequestCookies || require('next/dist/compiled/@edge-runtime/cookies').RequestCookies;
    return requestAsyncStorage.run({ headers: HeadersAdapter.seal(headers), cookies: new CookieClass(headers), mutableCookies: new CookieClass(headers) }, work);
  }
  if (major !== 15 && major !== 16) throw Error('fb2322_next_runtime_unsupported');
  const { NextRequest } = require('next/server');
  const { createRequestStoreForAPI } = require('next/dist/server/async-storage/request-store');
  const { workUnitAsyncStorage } = require('next/dist/server/app-render/work-unit-async-storage.external');
  const { createWorkStore } = require('next/dist/server/async-storage/work-store');
  const { workAsyncStorage } = require('next/dist/server/app-render/work-async-storage.external');
  const request = new NextRequest('http://synthetic.invalid/fb2322', { headers });
  const store = createRequestStoreForAPI(request, { pathname: '/fb2322', search: '' }, { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined);
  const workStore = createWorkStore({ page: '/fb2322/route', buildId: 'synthetic', previouslyRevalidatedTags: [],
    renderOpts: { supportsDynamicResponse: true, experimental: { isRoutePPREnabled: false, cacheComponents: false, authInterrupts: false } } });
  return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(store, work));
};
