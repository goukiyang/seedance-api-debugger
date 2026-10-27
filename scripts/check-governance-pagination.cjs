'use strict';
const fs = require('node:fs');
const ts = require('typescript');
const ownedFiles = [
  'src/lib/reference-albums/governance-page.ts', 'src/lib/reference-albums/governance-client.ts',
  'src/app/api/reference-album-folders/route.ts', 'src/app/api/reference-albums/[id]/shares/route.ts',
  'src/app/api/admin/reference-album-submissions/route.ts', 'src/app/collections/ReferenceAlbumsClient.tsx',
  'src/components/ShareAlbumDialog.tsx', 'src/lib/projects/album-projection.ts', 'src/app/api/projects/[id]/route.ts',
];
function checkGovernancePagination(root = process.cwd()) {
  const errors = [], read = f => fs.readFileSync(`${root}/${f}`, 'utf8');
  const requirements = [
    [ownedFiles[2], ['readFolderPage(', 'assertPageOwner(', 'pagination']],
    [ownedFiles[3], ['assertCanShareAlbum(', 'readSharePage(', 'assertPageOwner(', 'pagination']],
    [ownedFiles[4], ['assertAdmin(', 'readSubmissionPage(', 'assertPageOwner(', 'pagination']],
    [ownedFiles[5], ['loadAllFolderPages<PublicFolder>', 'fetchGovernancePage<PublicSubmission>', 'setPendingTotal(data.pagination.total)', 'loadPendingSubmissions(true)', 'controller.signal.aborted || !isCurrent(epoch)']],
    [ownedFiles[6], ['loadAllFolderPages<PublicFolderOption>', 'fetchGovernancePage<ShareItem>', 'setShareTotal(data.pagination.total)', 'loadShares(true)', 'boundaryRef.current.epoch !== boundaryEpoch']],
    [ownedFiles[7], ['getAlbumAccess(user, album)', 'total++', 'take: 100', 'take: 4', 'readProjectAlbumDirectory']],
    [ownedFiles[8], ['readProjectAlbumDirectory(user, projectId, requestedPage)']],
  ];
  for (const [file, texts] of requirements) for (const text of texts) if (!read(file).includes(text)) errors.push(`${file}: missing ${text}`);
  for (const [file] of requirements.slice(0, 3)) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const get = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'GET') || source.statements.filter(ts.isVariableStatement)
      .flatMap(n => Array.from(n.declarationList.declarations)).find(n => n.name.getText(source) === 'GET');
    if (!get || get.getText(source).includes('.findMany({\n      where,\n      orderBy:')) errors.push(`${file}: GET not paged`);
  }
  for (const file of [ownedFiles[5], ownedFiles[6]]) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'fetch') {
        const url = node.arguments[0]?.getText(source) || '', options = node.arguments[1]?.getText(source) || '';
        if (/\/api\/(reference-album-folders|admin\/reference-album-submissions)|\/shares[`'"]/.test(url) && !/method:\s*['"](?:POST|PATCH|DELETE)['"]/.test(options)) errors.push(`${file}: raw governance GET bypasses page loader`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const projection = read(ownedFiles[7]);
  if (projection.includes('take: 20,\n    include:') || projection.includes('skip, take:')) errors.push('project albums: page selected before authorization');
  return errors;
}
module.exports = { ownedFiles, checkGovernancePagination };
if (require.main === module) { const errors = checkGovernancePagination(); console.log(JSON.stringify({ scope: 'three governance GETs/consumers and project projection only', errors })); if (errors.length) process.exitCode = 1; }
