#!/usr/bin/env python3
"""Explicitly authorized, potentially billable API client. No key is persisted."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--file', type=Path)
    parser.add_argument('--mime', default='image/png')
    parser.add_argument('--prompt', required=True)
    parser.add_argument('--duration', required=True, type=int)
    parser.add_argument('--resolution', required=True)
    parser.add_argument('--max-cost-points', required=True, type=float)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    base = os.environ['SD2_API_BASE'].rstrip('/')
    key = os.environ['SD2_API_KEY']
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise SystemExit('SD2_API_BASE must be an HTTPS origin.')

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None  # Never forward credentials to another address.

    opener = urllib.request.build_opener(NoRedirect)

    def call(method, route, body=None, extra=None, stream=False):
        if not route.startswith('/api/v1/') or route.startswith('//'):
            raise ValueError('Invalid API route')
        headers = {'Authorization': 'Bearer ' + key, **(extra or {})}
        if isinstance(body, dict):
            body = json.dumps(body, ensure_ascii=False).encode()
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(base + route, data=body, method=method, headers=headers)
        response = opener.open(request, timeout=180)
        if stream:
            return response
        with response:
            return json.load(response)

    def save():
        temporary = args.state.with_suffix(args.state.suffix + '.tmp')
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, args.state)

    def sha256(file):
        result = hashlib.sha256()
        with file.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                result.update(chunk)
        return result.hexdigest()

    intent = {'prompt': args.prompt, 'duration': args.duration, 'resolution': args.resolution,
              'max_cost_points': args.max_cost_points, 'file_sha256': sha256(args.file) if args.file else None,
              'mime': args.mime if args.file else None}
    state = json.loads(args.state.read_text()) if args.state.exists() else {
        'base': base, 'intent': intent, 'request_id': str(uuid.uuid4()), 'upload_request_id': str(uuid.uuid4())}
    if state['base'] != base or state['intent'] != intent:
        raise SystemExit('State belongs to a different request. Keep the original state and inputs.')
    save()
    if not state.get('submission_started'):
        if args.file and not state.get('asset_id'):
            if not state.get('upload_id'):
                upload = call('POST', '/api/v1/assets/uploads', {
                    'request_id': state['upload_request_id'], 'sha256': intent['file_sha256'],
                    'size_bytes': args.file.stat().st_size, 'mime_type': args.mime, 'file_name': args.file.name})
                state['upload_id'] = upload['id']
                save()
            route = '/api/v1/assets/uploads/' + state['upload_id']
            upload = call('POST', route + '/recover')
            if upload['status'] == 'prepared':
                with args.file.open('rb') as handle:
                    call('PUT', route + '/transfer', handle, {
                        'Content-Type': args.mime, 'Content-Length': str(args.file.stat().st_size),
                        'Upload-Nonce': upload['transfer_nonce']})
                upload = call('POST', route + '/complete')
            if upload['status'] != 'completed':
                raise SystemExit('Original upload is unresolved. Keep this state; no bytes were resent.')
            state['asset_id'] = upload['asset']['id']
            save()
        if not state.get('quote_id'):
            video_input = {'model': 'seedance-2.5-ip', 'prompt': args.prompt, 'duration': args.duration,
                           'resolution': args.resolution, 'image_assets': [state['asset_id']] if state.get('asset_id') else []}
            quote = call('POST', '/api/v1/video/quotes', {'input': video_input, 'max_cost_points': args.max_cost_points})
            state.update(quote_id=quote['id'], input=quote['input'], quoted_points=quote['points'])
            save()
        state['submission_started'] = True  # Durable before the potentially billable POST.
        save()
        try:
            call('POST', '/api/v1/video/tasks', {'quote_id': state['quote_id'], 'input': state['input']},
                 {'Idempotency-Key': state['request_id'],
                  'X-Paid-Generation-Intent': 'user_authorized_real_provider',
                  'X-Paid-Generation-Reason': 'customer_authorized_video_generation'})
        except (urllib.error.URLError, TimeoutError):
            print('Submission response unavailable; querying the original request only.', file=sys.stderr)

    route = '/api/v1/video/requests/' + urllib.parse.quote(state['request_id'], safe='')
    deadline = time.monotonic() + 30 * 60
    while time.monotonic() < deadline:
        try:
            task = call('GET', route)
        except urllib.error.HTTPError as error:
            if error.code == 429:
                time.sleep(max(10, int(error.headers.get('Retry-After', '60'))))
                continue
            if error.code == 404:
                raise SystemExit('Original request not found yet. Do not change ID or submit again; keep this state for recovery.')
            raise
        state['task_id'] = task['id']
        save()
        if task['delivery_status'] == 'ready':
            partial = args.output.with_suffix(args.output.suffix + '.part')
            if args.output.exists():
                raise SystemExit('Output already exists; choose another path. Original request remains saved.')
            with call('GET', task['content_url'], stream=True) as response:
                fd = os.open(partial, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'wb') as output:
                    while chunk := response.read(1024 * 1024):
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
            if partial.stat().st_size != task['content_bytes'] or sha256(partial) != task['content_sha256']:
                raise SystemExit('Downloaded file failed integrity check. Original task remains saved; no new generation.')
            os.link(partial, args.output)
            partial.unlink()
            print('Downloaded:', args.output)
            return
        if task['status'] in ('failed', 'cancelled'):
            raise SystemExit('Task ended: ' + task['status'] + '; fee status: ' + task['fee_status'])
        time.sleep(max(10, task.get('retry_after_seconds') or 10))
    raise SystemExit('Polling stopped after 30 minutes; request and fees are not cancelled. Run with the same state to query again.')


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        # Deliberately do not print request headers, URLs, or upstream exception details.
        raise SystemExit('API request failed with HTTP ' + str(error.code) + '. Keep the original state for recovery.')
