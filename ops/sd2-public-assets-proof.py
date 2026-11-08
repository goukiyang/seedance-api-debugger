#!/usr/bin/env python3
"""Read-only manual release check; never follows login redirects or calls models."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from urllib.error import HTTPError
from urllib.parse import parse_qs, urljoin, urlsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verify_assets(root, origin, pages):
    root = Path(root).resolve()
    parsed = urlsplit(origin)
    assert parsed.scheme in ('http', 'https') and parsed.netloc and not parsed.username and not parsed.password
    assert parsed.path in ('', '/') and not parsed.query and not parsed.fragment
    origin = origin.rstrip('/')
    build_root = (root / '.next-prod').resolve()

    def identity():
        return ((root / '.deployed-commit').read_text().strip(),
                json.loads((root / 'package.json').read_text())['version'],
                (build_root / 'BUILD_ID').read_text().strip())

    source, version, build = identity()
    assert re.fullmatch('[a-f0-9]{40}', source) and build
    opener = build_opener(NoRedirect())

    def read(route):
        request = Request(origin + route, headers={'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'})
        try:
            response = opener.open(request, timeout=20)
        except HTTPError as error:
            response = error
        with response:
            body = response.read(64 * 1024 * 1024 + 1)
            assert len(body) <= 64 * 1024 * 1024, 'Resource exceeds read budget'
            return response.code, response.headers, body

    manifest_bytes = (build_root / 'app-build-manifest.json').read_bytes()
    manifest = json.loads(manifest_bytes)
    files = set()
    for page in pages:
        assert manifest.get('pages', {}).get(page), 'Missing compiled page: ' + page
        files.update(manifest['pages'][page])
    assets = []
    for file in sorted(files):
        assert file.startswith('static/') and str(PurePosixPath(file)) == file
        assert '..' not in PurePosixPath(file).parts and not any(c in file for c in '\\?#\0\r\n')
        local = (build_root / file).resolve()
        assert local.is_relative_to(build_root)
        expected = local.read_bytes()
        status, _, body = read('/_next/' + file)
        assert status == 200, 'Public compiled resource must return 200: ' + file
        assert body == expected, 'Public compiled bytes differ: ' + file
        assets.append({'file': file, 'status': status, 'sha256': hashlib.sha256(body).hexdigest()})
    protected = []
    for file in ['tools/ultimate-canvas/index.html', 'tools/ultimate-canvas/app.js']:
        route = '/' + file
        local = (root / 'public' / file).read_bytes()
        status, headers, _ = read(route)
        assert status == 307, 'Protected resource must require login: ' + route
        target = urlsplit(urljoin(origin, headers.get('Location', '')))
        assert (target.scheme, target.netloc) == (parsed.scheme, parsed.netloc), 'Login redirect must stay on this origin'
        assert target.path == '/login' and parse_qs(target.query).get('next') == [route], 'Login must preserve the original resource'
        protected.append({'route': route, 'status': status, 'destination': '/login',
                          'localFileSha256': hashlib.sha256(local).hexdigest(), 'authenticatedBytesVerified': False})
    assert identity() == (source, version, build), 'Candidate changed during capture'
    assert (build_root / 'app-build-manifest.json').read_bytes() == manifest_bytes
    return {'root': str(root), 'source': source, 'version': version, 'build': build,
            'assets': assets, 'protectedAssets': protected, 'generationCalls': 0, 'authenticatedBrowserAcceptance': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--page', action='append')
    args = parser.parse_args()
    print(json.dumps(verify_assets(args.root, args.origin, args.page or ['/image-studio/page']), ensure_ascii=False))
