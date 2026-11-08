import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlencode

spec = importlib.util.spec_from_file_location('public_assets_proof', Path(__file__).with_name('sd2-public-assets-proof.py'))
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status, headers, body = self.server.responses.get(self.path, (404, {}, b'missing'))
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class PublicAssetsProofTest(unittest.TestCase):
    def test_real_http_public_bytes_and_protected_login_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = {'.deployed-commit': 'a' * 40, 'package.json': json.dumps({'version': '0.135.10'}),
                     '.next-prod/BUILD_ID': 'fixture-build',
                     '.next-prod/app-build-manifest.json': json.dumps({'pages': {'/image-studio/page': ['static/image-studio.js']}}),
                     '.next-prod/static/image-studio.js': 'image-client',
                     'public/tools/ultimate-canvas/index.html': '<html>protected canvas</html>',
                     'public/tools/ultimate-canvas/app.js': 'protected-canvas-client'}
            for name, text in files.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text)
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            origin = 'http://127.0.0.1:' + str(server.server_port)
            chunk = '/_next/static/image-studio.js'
            protected = '/tools/ultimate-canvas/app.js'
            baseline = {chunk: (200, {}, b'image-client')}
            for route in ['/tools/ultimate-canvas/index.html', protected]:
                baseline[route] = (307, {'Location': '/login?' + urlencode({'next': route})}, b'login redirect')
            server.responses = baseline.copy()
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = proof.verify_assets(root, origin, ['/image-studio/page'])
                self.assertEqual(len(result['assets']), 1)
                self.assertEqual(len(result['protectedAssets']), 2)
                self.assertFalse(result['protectedAssets'][1]['authenticatedBytesVerified'])
                failures = [(chunk, (200, {}, b'wrong compiled bytes')),
                            (chunk, (307, {'Location': '/login'}, b'login HTML')),
                            (protected, (200, {}, b'protected-canvas-client')),
                            (protected, (307, {'Location': 'https://elsewhere.invalid/login'}, b'')),
                            (protected, (307, {'Location': '/login?next=/other'}, b''))]
                for route, response in failures:
                    with self.subTest(response=response):
                        server.responses = {**baseline, route: response}
                        with self.assertRaises(AssertionError):
                            proof.verify_assets(root, origin, ['/image-studio/page'])
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == '__main__':
    unittest.main()
