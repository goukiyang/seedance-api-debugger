import { NextRequest } from 'next/server';
import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
import { createWorkStore } from 'next/dist/server/async-storage/work-store';
import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';

// Exercise real Next cookie/header storage, not a replacement auth implementation.
export const requestAsyncStorage = {
  run<T>(input: { headers: Headers }, action: () => T): T {
    const request = new NextRequest('http://synthetic.invalid/fixture', { headers: input.headers });
    const store = createRequestStoreForAPI(request, { pathname: '/fixture', search: '' },
      { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined);
    const work = createWorkStore({
      page: '/fixture/route', buildId: 'synthetic', previouslyRevalidatedTags: [],
      renderOpts: {
        supportsDynamicResponse: true,
        experimental: { isRoutePPREnabled: false, cacheComponents: false, authInterrupts: false },
        waitUntil: undefined, onClose: () => {}, onAfterTaskError: undefined,
      },
    });
    return workAsyncStorage.run(work, () => workUnitAsyncStorage.run(store, action));
  },
};
