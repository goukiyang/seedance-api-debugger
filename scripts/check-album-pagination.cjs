'use strict';
const fs = require('node:fs');
const ts = require('typescript');

function checkAlbumPagination(root = process.cwd()) {
  const failures = [];
  const read = file => fs.readFileSync(`${root}/${file}`, 'utf8');
  const routes = ['src/app/api/reference-albums/route.ts', 'src/app/api/reference-albums/[id]/route.ts', 'src/app/api/reference-albums/[id]/images/route.ts'];
  for (const file of routes) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'GET');
    const wrapped = source.statements.filter(ts.isVariableStatement).flatMap(statement => Array.from(statement.declarationList.declarations))
      .find(node => node.name.getText(source) === 'GET')?.initializer;
    const get = declaration || wrapped;
    const text = get?.getText(source) || '';
    if (!text.includes('authorizedPage(') && !text.includes('readAlbumImagePage(')) failures.push(`${file}: GET must use the authorized cursor page`);
    if (!text.includes('assertPageOwner(')) failures.push(`${file}: account boundary missing`);
    function boundedCoverLookup(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source).endsWith('referenceImage.findMany')) {
        const options = node.arguments[0];
        const take = options && ts.isObjectLiteralExpression(options) && options.properties.find(property => property.name?.getText(source) === 'take');
        if (!take || !ts.isPropertyAssignment(take) || !ts.isNumericLiteral(take.initializer) || Number(take.initializer.text) > 100) failures.push(`${file}: unpaged image lookup in GET`);
      }
      ts.forEachChild(node, boundedCoverLookup);
    }
    if (get) boundedCoverLookup(get);
  }
  const consumers = ['src/app/collections/ReferenceAlbumsClient.tsx', 'src/app/collections/[id]/ReferenceAlbumDetailClient.tsx',
    'src/components/ReferenceAlbumPicker.tsx', 'src/components/UploadedImagePickerAlbums.tsx', 'src/components/GenerationComposer.tsx', 'src/app/assets/page.tsx'];
  for (const file of consumers) {
    const text = read(file);
    if (!text.includes('fetchAlbumPage') && !text.includes('loadAllAlbumPages')) failures.push(`${file}: pagination consumer missing`);
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'fetch' && node.arguments[0]?.getText(source).includes('/api/reference-albums')) {
        const address = node.arguments[0].getText(source), options = node.arguments[1]?.getText(source) || '';
        if (!/shares|public-submissions/.test(address) && !/method:\s*['"](?:POST|PATCH|DELETE)['"]/.test(options)) failures.push(`${file}: raw GET bypasses page loader`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const workspace = read('src/lib/hooks/useWorkspace.ts');
  if (!workspace.includes('detail.pagination.total > maxImages') || !workspace.includes('detail.pagination.hasMore')) failures.push('useWorkspace: full-album replacement must reject partial pages');
  return failures;
}
module.exports = { checkAlbumPagination, ownedFiles: [
  'src/lib/pagination/cursor.ts', 'src/lib/reference-albums/image-page.ts', 'src/lib/reference-albums/client-pages.ts', 'src/lib/hooks/usePageSentinel.ts',
  'src/lib/hooks/useWorkspace.ts', 'src/app/api/reference-albums/route.ts', 'src/app/api/reference-albums/[id]/route.ts', 'src/app/api/reference-albums/[id]/images/route.ts',
  'src/app/collections/ReferenceAlbumsClient.tsx', 'src/app/collections/[id]/ReferenceAlbumDetailClient.tsx',
  'src/components/ReferenceAlbumPicker.tsx', 'src/components/UploadedImagePickerAlbums.tsx', 'src/components/GenerationComposer.tsx', 'src/app/assets/page.tsx',
] };
if (require.main === module) {
  const failures = checkAlbumPagination(); console.log(JSON.stringify({ scope: 'album routes and enumerated consumers only; not global collection acceptance', failures })); if (failures.length) process.exitCode = 1;
}
