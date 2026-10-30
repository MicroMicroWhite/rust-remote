import base64
import hashlib
import json
import time

import pytest
from fastapi.testclient import TestClient

from lib.app import create_app
from lib.config import Settings
from lib.hub import Hub
from lib.upgrades import Upgrades, version
from test_app import BASE, HELLO, PASSWORD, TOKEN, login


def release(root, version='0.3.0', payload=b'test executable' * 30000):
    directory = root / 'linux-amd64'
    directory.mkdir(exist_ok=True, parents=True)
    manifest = dict(version=version, platform='linux', arch='x86_64', update_protocol=1,
                    size=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    (directory / 'release.json').write_text(json.dumps(manifest))
    (directory / 'rust-remote-client').write_bytes(payload)
    return manifest, payload


@pytest.fixture
def console(tmp_path):
    settings = Settings(tmp_path / 'data', PASSWORD, TOKEN, 'a1b2c3d4',
                        command_timeout=0.3, releases_dir=tmp_path / 'releases')
    release(settings.releases_dir)
    with TestClient(create_app(settings)) as client:
        yield client, settings


def test_release_versions_and_invalid_bundles(console):
    client, settings = console
    assert version('0.10.0') > version('0.2.9')
    for value in ('1.0', '01.0.0', '1.0.0-beta', '../1.0.0', None):
        with pytest.raises(ValueError):
            version(value)
    manager = client.app.state.upgrades
    device = dict(HELLO, online=False)
    assert '上线' in manager.describe(device)['reason']
    assert manager.describe(dict(device, version='0.3.0'))['available'] is False
    assert '无需降级' in manager.describe(dict(device, version='0.4.0'))['reason']
    assert '尚未发布' in manager.describe(dict(device, arch='aarch64'))['reason']
    manifest, payload = release(settings.releases_dir)
    binary = settings.releases_dir / 'linux-amd64/rust-remote-client'
    binary.write_bytes(b'x' * len(payload))
    with pytest.raises(ValueError, match='SHA-256'):
        manager.release(device, read=True)
    binary.unlink()
    assert not manager.describe(device)['available']


def test_upgrade_auth_legacy_offline_and_csrf(console):
    client, _ = console
    endpoint = BASE + '/devices/device-1/upgrade'
    assert client.post(endpoint).status_code == 401
    login(client)
    assert client.post(BASE + '/devices/missing/upgrade').status_code == 404
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO); ws.receive_json()
        assert '手动替换' in client.get(BASE + '/devices').json()[0]['upgrade']['reason']
        assert client.post(endpoint).status_code == 409
        csrf = client.headers.pop('X-CSRF-Token')
        assert client.post(endpoint).status_code == 403
        client.headers['X-CSRF-Token'] = csrf
    assert client.post(endpoint).status_code == 409
    assert client.post(BASE + '/devices/device-1/command', json={'action': 'agent.update.commit'}).status_code == 400


def wait_job(client, status):
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        job = client.get(BASE + '/devices').json()[0]['upgrade']['job']
        if job and job['status'] == status:
            return job
        time.sleep(0.02)
    raise AssertionError(f'Expected {status}, got {job}')


def test_upgrade_chunk_transfer_restart_confirmation_and_audit(console):
    client, settings = console
    manifest, payload = release(settings.releases_dir)
    login(client)
    hello = dict(HELLO, version='0.2.0', capabilities=['self-update-v1'])
    endpoint = BASE + '/devices/device-1/upgrade'
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(hello); ws.receive_json()
        assert client.get(BASE + '/devices').json()[0]['upgrade']['available']
        assert client.post(endpoint).status_code == 202
        assert client.post(endpoint).status_code == 409
        received = bytearray()
        while True:
            message = ws.receive_json()
            if message['action'] == 'agent.update.begin':
                assert message['params']['sha256'] == manifest['sha256']
            elif message['action'] == 'agent.update.chunk':
                assert message['params']['offset'] == len(received)
                received.extend(base64.b64decode(message['params']['data']))
            else:
                assert message['action'] == 'agent.update.commit'
                break
            ws.send_json({'type': 'response', 'id': message['id'], 'ok': True, 'result': {}})
        assert bytes(received) == payload
        assert wait_job(client, 'restarting')['progress'] == 100
        # Commit response alone must never mark the upgrade successful.
        ws.send_json({'type': 'response', 'id': message['id'], 'ok': True, 'result': {'restarting': True}})
        assert wait_job(client, 'restarting')['status'] == 'restarting'
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as new:
        new.send_json(dict(hello, version='0.3.0')); new.receive_json()
        assert wait_job(client, 'success')['progress'] == 100
        assert not client.get(BASE + '/devices').json()[0]['upgrade']['available']
    rows = client.get(BASE + '/audit/records', params={'category': 'system'}).json()['items']
    assert rows[0]['action'] == 'agent.update' and rows[0]['status'] == 'success'


def test_upgrade_corruption_and_remote_failure(console):
    client, settings = console
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(dict(HELLO, capabilities=['self-update-v1'])); ws.receive_json()
        binary = settings.releases_dir / 'linux-amd64/rust-remote-client'
        binary.write_bytes(b'x' * binary.stat().st_size)
        result = client.post(BASE + '/devices/device-1/upgrade')
        assert result.status_code == 409 and 'SHA-256' in result.json()['detail']
        release(settings.releases_dir)
        assert client.post(BASE + '/devices/device-1/upgrade').status_code == 202
        message = ws.receive_json()
        ws.send_json({'type': 'response', 'id': message['id'], 'ok': False, 'error': 'Executable directory is read-only'})
        assert 'read-only' in wait_job(client, 'failed')['detail']
        message = ws.receive_json()
        assert message['action'] == 'agent.update.abort'
        ws.send_json({'type': 'response', 'id': message['id'], 'ok': True, 'result': {}})


def test_upgrade_job_restart_migration(console):
    client, settings = console
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(dict(HELLO, capabilities=['self-update-v1'])); ws.receive_json()
        assert client.post(BASE + '/devices/device-1/upgrade').status_code == 202
        # Emulate an interrupted controller with a persisted active record.
        restarted = Upgrades(settings, client.app.state.db, Hub())
        assert restarted.latest('device-1')['status'] == 'interrupted'


def test_reinstall_same_version_transfer_and_new_connection_confirmation(console):
    client, settings = console
    manifest, payload = release(settings.releases_dir)
    login(client)
    hello = dict(HELLO, version=manifest['version'], capabilities=['self-update-v1', 'self-reinstall-v1'],
                 binary_sha256=manifest['sha256'])
    endpoint = BASE + '/devices/device-1/upgrade'
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(hello); ws.receive_json()
        state = client.get(BASE + '/devices').json()[0]['upgrade']
        assert not state['available'] and state['reinstall_available']
        assert client.post(endpoint).status_code == 409
        assert client.post(endpoint, json={'reinstall': 'true'}).status_code == 422
        csrf = client.headers.pop('X-CSRF-Token')
        assert client.post(endpoint, json={'reinstall': True}).status_code == 403
        client.headers['X-CSRF-Token'] = csrf
        assert client.post(endpoint, json={'reinstall': True}).status_code == 202
        assert client.post(endpoint, json={'reinstall': True}).status_code == 409
        received = bytearray()
        while True:
            message = ws.receive_json()
            if message['action'] == 'agent.update.begin':
                assert message['params']['reinstall'] is True
                assert message['params']['version'] == hello['version']
            elif message['action'] == 'agent.update.chunk':
                assert message['params']['offset'] == len(received)
                received.extend(base64.b64decode(message['params']['data']))
            else:
                assert message['action'] == 'agent.update.commit'
                break
            ws.send_json({'type': 'response', 'id': message['id'], 'ok': True, 'result': {}})
        assert bytes(received) == payload
        assert wait_job(client, 'restarting')['progress'] == 100
        ws.send_json({'type': 'response', 'id': message['id'], 'ok': True, 'result': {'restarting': True}})
        assert wait_job(client, 'restarting')['status'] == 'restarting'
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as rollback:
        rollback.send_json(dict(hello, binary_sha256='0' * 64)); rollback.receive_json()
        assert wait_job(client, 'restarting')['status'] == 'restarting'
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as new:
        new.send_json(hello); new.receive_json()
        assert wait_job(client, 'success')['progress'] == 100
    rows = client.get(BASE + '/audit/records', params={'category': 'system'}).json()['items']
    assert any(row['action'] == 'agent.reinstall' and row['status'] == 'success' for row in rows)
    assert client.post(endpoint, json={'reinstall': True}).status_code == 409


@pytest.mark.parametrize('current,capabilities', [
    ('0.3.0', ['self-update-v1']),
    ('0.3.0', ['self-reinstall-v1']),
    ('0.4.0', ['self-update-v1', 'self-reinstall-v1']),
])
def test_reinstall_rejects_legacy_service_and_downgrade(console, current, capabilities):
    client, _ = console
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(dict(HELLO, version=current, capabilities=capabilities)); ws.receive_json()
        state = client.get(BASE + '/devices').json()[0]['upgrade']
        assert not state['reinstall_available']
        assert client.post(BASE + '/devices/device-1/upgrade', json={'reinstall': True}).status_code == 409
