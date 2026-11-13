"""Check the real fallback snippet with an isolated loopback nginx, never production."""
import http.server
import json
import pathlib
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request


class Application(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith('/timeout'):
            time.sleep(.2)
            return
        status = int(self.path.removeprefix('/app-')) if self.path.startswith('/app-') else 200
        body = json.dumps({'error': 'original application response', 'status': status}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


source = pathlib.Path(__file__).resolve().parent
nginx = shutil.which('nginx') or '/usr/sbin/nginx'
application = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Application)
threading.Thread(target=application.serve_forever, daemon=True).start()
try:
    with tempfile.TemporaryDirectory(prefix='sd2-status-check-') as directory:
        root = pathlib.Path(directory)
        shutil.copyfile(source / 'updating.html', root / 'updating.html')
        snippet = (source / 'sd2-updating.conf').read_text().replace(
            'root /data/video-api-debugger/site-status;', f'root {root};')
        (root / 'fallback.conf').write_text(snippet)
        port, unavailable = free_port(), free_port()
        app_port = application.server_address[1]
        (root / 'nginx.conf').write_text(f'''
daemon off;
master_process off;
pid {root}/nginx.pid;
error_log {root}/error.log;
events {{ worker_connections 64; }}
http {{
  access_log off;
  client_body_temp_path {root}/client_body_temp;
  proxy_temp_path {root}/proxy_temp;
  fastcgi_temp_path {root}/fastcgi_temp;
  uwsgi_temp_path {root}/uwsgi_temp;
  scgi_temp_path {root}/scgi_temp;
  types {{ text/html html; }}
  server {{
    listen 127.0.0.1:{port};
    include {root}/fallback.conf;
    location / {{ proxy_pass http://127.0.0.1:{app_port}; }}
    location /down/ {{ proxy_pass http://127.0.0.1:{unavailable}; }}
    location = /api/down {{ proxy_pass http://127.0.0.1:{unavailable}; }}
    location = /_next/down.js {{ proxy_pass http://127.0.0.1:{unavailable}; }}
    location = /planned {{ return 503; }}
    location = /api/planned {{ return 503; }}
    location = /api/timeout {{ proxy_read_timeout 50ms; proxy_pass http://127.0.0.1:{app_port}; }}
    location = /timeout {{ proxy_read_timeout 50ms; proxy_pass http://127.0.0.1:{app_port}; }}
  }}
}}
''')
        command = [nginx, '-p', str(root), '-e', str(root / 'error.log'), '-c', str(root / 'nginx.conf')]
        subprocess.run(command + ['-t'], check=True, capture_output=True)
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for attempt in range(40):
                try:
                    with socket.create_connection(('127.0.0.1', port), timeout=.1):
                        break
                except OSError:
                    if attempt == 39:
                        raise
                    time.sleep(.05)

            cases = [
                ('/down/page?original=1', 'GET', 'text/html', 502, 'text/html'),
                ('/down/page', 'HEAD', 'text/html', 502, 'text/html'),
                ('/api/down', 'GET', 'text/html', 502, 'application/json'),
                ('/api/down', 'POST', 'text/html', 502, 'application/json'),
                ('/down/page', 'POST', 'text/html', 502, 'application/json'),
                ('/_next/down.js', 'GET', 'text/html', 502, 'application/json'),
                ('/down/page', 'GET', '*/*', 502, 'application/json'),
                ('/planned', 'GET', 'text/html', 503, 'text/html'),
                ('/api/planned', 'GET', 'text/html', 503, 'application/json'),
                ('/api/timeout', 'GET', 'text/html', 504, 'application/json'),
                ('/timeout', 'GET', 'text/html', 504, 'text/html'),
                *[(f'/app-{status}', 'GET', 'text/html', status, 'application/json')
                  for status in (401, 403, 404, 500, 502, 503)],
                ('/ok', 'GET', 'text/html', 200, 'application/json'),
            ]
            for path, method, accept, expected_status, expected_type in cases:
                url = f'http://127.0.0.1:{port}{path}'
                request = urllib.request.Request(url, method=method, headers={'Accept': accept})
                try:
                    response = urllib.request.urlopen(request, timeout=3)
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    body = response.read()
                    assert response.status == expected_status, (method, path, response.status)
                    assert response.headers.get_content_type() == expected_type, (path, response.headers)
                    assert response.url == url, 'Fallback must not redirect away from the original URL'
                    if path.startswith('/app-') or path == '/ok':
                        assert json.loads(body)['status'] == expected_status
                        assert response.headers.get('X-SD2-Status') is None
                    else:
                        assert response.headers['Cache-Control'] == 'no-store'
                        assert response.headers['Retry-After'] == '10'
                        assert response.headers['X-SD2-Origin'] == 'server-42-193'
                        if method == 'HEAD':
                            assert body == b''
                        elif expected_type == 'text/html':
                            assert body == (source / 'updating.html').read_bytes()
                        else:
                            assert json.loads(body)['code'] == 'SERVICE_TEMPORARILY_UNAVAILABLE'
            print(json.dumps({'passed': True, 'cases': len(cases), 'productionRequests': 0}))
        finally:
            process.terminate()
            process.wait(timeout=5)
finally:
    application.shutdown()
    application.server_close()
