// Existing synthetic suites inject their observed client at the shared factory
// boundary, not through the retired production globals. No application hook.
export function setFixtureDatabase(client: unknown) {
  const key = Symbol.for('video-api.database-client.v1');
  if (client === undefined) {
    Reflect.deleteProperty(globalThis, key);
    Reflect.deleteProperty(globalThis, 'prisma');
    return;
  }
  Reflect.set(globalThis, 'prisma', client);
  Reflect.set(globalThis, key, { raw: client, extended: client, mode: 'write', sqlite: false });
}
