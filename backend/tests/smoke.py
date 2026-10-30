#!/usr/bin/env python3
"""Run smoke checks against a connected device."""
import argparse
import http.cookiejar
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--url', default='http://localhost:8080')
parser.add_argument('--device-id')
parser.add_argument('--require-screen', action='store_true')
args = parser.parse_args()
base = args.url.rstrip('/') + '/' + os.environ['ENTRANCE_CODE'] + '/api'
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
csrf = ''


def request(path, body=None, raw=None, content_type='application/json'):
    data = json.dumps(body).encode() if body is not None else raw
    headers = {'Content-Type': content_type, 'X-CSRF-Token': csrf}
    req = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        with opener.open(req, timeout=50) as response:
            payload = response.read()
            return json.loads(payload) if 'application/json' in response.headers.get('Content-Type', '') else payload
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'HTTP {error.code}: {error.read().decode()}') from error


csrf = request('/login', {'password': os.environ['ADMIN_PASSWORD']})['csrf_token']
devices = [device for device in request('/devices') if device['online']]
if args.device_id:
    devices = [device for device in devices if device['id'] == args.device_id]
if len(devices) != 1:
    raise SystemExit('Select exactly one online device using --device-id.')
device_id = devices[0]['id']
endpoint = '/devices/' + device_id


def command(action, params=None):
    return request(endpoint + '/command', {'action': action, 'params': params or {}})['result']


info = command('system.info')
print('PASS system.info:', info['hostname'])
separator = '\\' if '\\' in info['default_path'] else '/'
root = info['default_path'].rstrip('/\\') + separator + '.remote-smoke-' + uuid.uuid4().hex
source = root + separator + 'hello.txt'
destination = root + separator + 'renamed.txt'
created = False
try:
    command('fs.mkdir', {'path': root})
    created = True
    boundary = 'remote-' + uuid.uuid4().hex
    payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="hello.txt"\r\n'
               f'Content-Type: application/octet-stream\r\n\r\nhello remote\r\n--{boundary}--\r\n').encode()
    request(endpoint + '/upload?path=' + urllib.parse.quote(source), raw=payload, content_type='multipart/form-data; boundary=' + boundary)
    assert request(endpoint + '/download?path=' + urllib.parse.quote(source)) == b'hello remote'
    assert command('fs.text', {'path': source})['content'] == 'hello remote'
    command('fs.edit', {'path': source, 'content': 'updated remote'})
    assert command('fs.text', {'path': source})['content'] == 'updated remote'
    command('fs.rename', {'path': source, 'destination': destination})
    assert command('fs.list', {'path': root})['entries'][0]['name'] == 'renamed.txt'
    command('fs.delete', {'path': destination})
    print('PASS file upload/download/text edit/rename/delete')
    assert command('process.list')['processes']
    print('PASS process.list')
    ports = command('ports.list')
    assert ports['exit_code'] == 0, ports['stderr']
    print('PASS ports.list')
    if info['shell_enabled']:
        output = command('shell.exec', {'command': 'echo remote-smoke-ok', 'timeout': 5})
        assert 'remote-smoke-ok' in output['stdout'] and output['exit_code'] == 0
        print('PASS shell.exec')
    if args.require_screen:
        shot = command('screen.capture')
        assert shot['mime'] == 'image/jpeg' and shot['width'] > 0 and len(shot['data']) > 100
        print('PASS screen.capture')
    assert any(row['action'] == 'fs.edit' and row['status'] == 'success' for row in request('/audit'))
    print('PASS audit')
finally:
    if created:
        for entry in command('fs.list', {'path': root})['entries']:
            command('fs.delete', {'path': entry['path']})
        command('fs.delete', {'path': root})
    request('/logout', {})
