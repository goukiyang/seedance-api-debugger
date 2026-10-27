const assert = require('node:assert/strict');
const { harness, taskRoutes } = require('./task-seedance-pagination-fixture.cjs');

(async () => {
  for (const file of taskRoutes) {
    const h = harness(), handler = h.load(file).GET;
    const props = { params: Promise.resolve({ id: 'card' }) };
    for (const query of ['limit=1000000', 'limit=NaN&page=NaN', 'limit=-1&page=-8', 'limit=1&page=1']) {
      const response = await handler(h.request(query), props);
      assert.equal(response.status, 200);
      const data = await response.json();
      const args = h.calls.filter(call => call.model === 'videoTask' && call.method === 'findMany').at(-1).args;
      // One lookahead proves hasMore; it is not included in the public result.
      assert.ok(Number.isSafeInteger(args.take) && args.take >= 1 && args.take <= 101, `${file}: unbounded take=${args.take}`);
      assert.ok(data.tasks.length <= 100 && data.tasks.length <= data.pagination.limit);
      assert.ok(Number.isSafeInteger(args.skip) && args.skip >= 0, `${file}: invalid offset=${args.skip}`);
    }
    const invalid = await handler(h.request('cursor=not-a-valid-cursor'), props);
    assert.equal(invalid.status, 400, `${file}: an invalid cursor cannot silently restart at the first page`);
  }
  console.log('PASS actual normal/IP/card handlers retain malformed input bounds and reject invalid cursors; public rows<=100, private lookahead<=101');
})().catch(error => { console.error(error); process.exitCode = 1; });
