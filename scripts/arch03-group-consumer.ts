import assert from 'node:assert/strict';
import ts from 'typescript';

export async function verifyPagedGroupDeletion(source: string) {
  const file = ts.createSourceFile('studio.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let declaration: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === 'deleteGroupMembers') declaration = node; ts.forEachChild(node, visit); };
  visit(file); assert.ok(declaration);
  const compiled = ts.transpileModule(`${declaration.getText(file)}; exports.run = deleteGroupMembers;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const members = Array.from({ length: 30 }, (_, index) => ({ id: `member-${index}`, revision: 1, groupName: 'Group', mine: true, coverEditable: true }));
  let posted: { expectedMembers: Array<{ id: string; revision: number }> } | undefined, switchAccount = false, reads = 0;
  const scope = { current: 'owner-one' };
  const context = {
    moduleReadScope: scope, modules: members.slice(0, 1), directory: members.slice(0, 24), directoryPaging: { paged: true },
    presetSources: { current: new Map() }, groupDeleteRequests: { current: new Map() }, userId: 'owner-one',
    DEFAULT_GROUPS: [], isClientSessionBlocked: () => false, canManageStudioGroupEntry: () => true,
    confirm: async () => true, crypto: { randomUUID: () => 'same-original-group-operation' },
    readResponse: async (value: unknown) => value,
    setError: (value: string) => { throw new Error(value); }, setModules: () => {}, setDirectory: () => {},
    setRemovedDefaultGroups: () => {}, setSelectedGroup: () => {}, shared: { refresh: () => {} }, loadModules: async () => {},
    fetch: async (url: string, options?: { method?: string; body?: string }) => {
      if (url === '/api/image-studio/gallery/query') {
        const body = JSON.parse(options!.body!); assert.equal(body.protocol, undefined); assert.equal(body.navigationOnly, true);
        reads++; if (switchAccount) scope.current = 'owner-two'; return { navigation: members };
      }
      if (options?.method === 'DELETE') { posted = JSON.parse(options.body!); return { modules: [], removedDefaultGroups: [] }; }
      const ids = new URL(url, 'https://fixture.invalid').searchParams.get('ids')!.split(',');
      assert.ok(ids.length <= 12); return { modules: members.filter(item => ids.includes(item.id)) };
    },
  };
  const exports: { run?: (group: string) => Promise<void> } = {};
  new Function(...Object.keys(context), 'exports', compiled)(...Object.values(context), exports);
  await exports.run!('Group');
  assert.deepEqual(posted!.expectedMembers.map(item => item.id).sort(), members.map(item => item.id).sort());
  posted = undefined; switchAccount = true; await exports.run!('Group'); assert.equal(posted, undefined); assert.equal(reads, 2);
  return { members: members.length, visiblePage: 24, allMembersIncluded: true, accountChangeRejectsMutation: true, networkCalls: 0 };
}
