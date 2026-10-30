import base64
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from lib.app import create_app
from lib.config import Settings
from lib.db import Database

PASSWORD = 'test-password-long-enough'
TOKEN = 'test-device-token-' + 'x' * 32
BASE = '/a1b2c3d4/api'
HELLO = {'type': 'hello', 'id': 'device-1', 'name': 'Test Linux', 'platform': 'linux', 'arch': 'x86_64', 'version': '0.1.0'}


@pytest.fixture
def client(tmp_path):
    app = create_app(Settings(tmp_path, PASSWORD, TOKEN, 'a1b2c3d4', command_timeout=0.3))
    with TestClient(app) as client:
        yield client


def login(client):
    response = client.post(BASE + '/login', json={'password': PASSWORD})
    assert response.status_code == 200
    client.headers['X-CSRF-Token'] = response.json()['csrf_token']
    return response


def test_entrance_session_csrf_and_logout(client):
    assert client.get('/healthz').status_code == 200
    assert client.get('/api/devices').status_code == 404
    assert client.get('/deadbeef/api/devices').status_code == 404
    assert client.get(BASE + '/devices').status_code == 401
    response = login(client)
    assert 'HttpOnly' in response.headers['set-cookie']
    assert 'SameSite=strict' in response.headers['set-cookie']
    assert client.get(BASE + '/session').status_code == 200
    csrf = client.headers.pop('X-CSRF-Token')
    assert client.post(BASE + '/logout').status_code == 403
    client.headers['X-CSRF-Token'] = csrf
    assert client.post(BASE + '/logout').status_code == 200
    assert client.get(BASE + '/devices').status_code == 401


def test_login_rate_limit_and_origin(client):
    assert client.post(BASE + '/login', json={'password': PASSWORD}, headers={'origin': 'https://evil.invalid'}).status_code == 403
    for _ in range(5):
        assert client.post(BASE + '/login', json={'password': 'wrong'}).status_code == 401
    assert client.post(BASE + '/login', json={'password': PASSWORD}).status_code == 429


def test_agent_authentication(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/agent/ws'):
            pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
            ws.send_json({'type': 'hello', 'id': '../invalid'})
            ws.receive_json()


def test_command_round_trip_audit_and_heartbeat(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO)
        assert ws.receive_json()['type'] == 'welcome'
        devices = client.get(BASE + '/devices').json()
        assert devices[0]['online'] is True
        history = client.get(BASE + '/devices/device-1/connections').json()['items']
        assert len(history) == 1
        assert history[0]['disconnected_at'] is None
        ws.send_json({'type': 'heartbeat'})
        assert ws.receive_json()['type'] == 'heartbeat_ack'
        with ThreadPoolExecutor() as pool:
            response = pool.submit(client.post, BASE + '/devices/device-1/command', json={'action': 'system.info'}, headers={'X-Request-ID': 'test-trace-1234'})
            request = ws.receive_json()
            assert request['trace_id'] == 'test-trace-1234'
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': True, 'result': {'hostname': 'test'}})
            actual = response.result()
            assert actual.status_code == 200
            assert actual.json()['result']['hostname'] == 'test'
            assert actual.headers['X-Request-ID'] == 'test-trace-1234'
        rows = client.get(BASE + '/audit').json()
        assert rows[0]['status'] == 'success'
        assert rows[0]['trace_id'] == 'test-trace-1234'
    assert client.get(BASE + '/devices').json()[0]['online'] is False
    history = client.get(BASE + '/devices/device-1/connections').json()['items']
    assert len(history) == 1
    assert history[0]['disconnected_at'] >= history[0]['connected_at']
    assert history[0]['reason'] == 'disconnected'


def test_device_order_stays_stable_across_heartbeats_and_reconnects(client):
    login(client)
    # Duplicate names (including case variants) must have a stable ID tie-breaker.
    devices = [dict(HELLO, id='device-b', name='Alpha'),
               dict(HELLO, id='device-a', name='alpha'),
               dict(HELLO, id='device-c', name='Beta')]
    expected = ['device-a', 'device-b', 'device-c']

    def listing():
        response = client.get(BASE + '/devices')
        assert response.status_code == 200
        rows = response.json()
        assert [row['id'] for row in rows] == expected
        return {row['id']: row for row in rows}

    with ExitStack() as stack:
        connections = []
        for device in devices:
            ws = stack.enter_context(client.websocket_connect(
                '/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}))
            ws.send_json(device)
            assert ws.receive_json()['type'] == 'welcome'
            connections.append(ws)
        before = listing()
        assert all(row['online'] for row in before.values())
        for index in (2, 0, 1, 0):
            connections[index].send_json({'type': 'heartbeat'})
            assert connections[index].receive_json()['type'] == 'heartbeat_ack'
            after = listing()
            device_id = devices[index]['id']
            assert after[device_id]['last_seen'] > before[device_id]['last_seen']
            before = after

    assert not any(row['online'] for row in listing().values())
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(dict(devices[0], version='0.3.5'))
        assert ws.receive_json()['type'] == 'welcome'
        rows = listing()
        assert rows['device-b']['online'] and rows['device-b']['version'] == '0.3.5'


def test_timeout_offline_and_validation(client):
    login(client)
    assert client.post(BASE + '/devices/missing/command', json={'action': 'system.info'}).status_code == 409
    for body in [{'action': 'bogus'}, {'action': 'fs.delete', 'params': {}}, {'action': 'shell.exec', 'params': {'command': 'a', 'timeout': True}}, {'action': 'fs.list', 'params': {'path': '.', 'unexpected': 1}}]:
        assert client.post(BASE + '/devices/missing/command', json=body).status_code == 400
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO); ws.receive_json()
        result = client.post(BASE + '/devices/device-1/command', json={'action': 'system.info'})
        assert result.status_code == 504
        assert client.app.state.hub.connections['device-1'].pending == {}


def test_delete_only_offline_devices_and_clear_controller_state(client):
    login(client)
    db = client.app.state.db
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO)
        assert ws.receive_json()['type'] == 'welcome'
        assert client.delete(BASE + '/devices/device-1').status_code == 409
        assert client.get(BASE + '/devices').json()[0]['id'] == 'device-1'

    connection_id = db.start_connection('device-1')
    db.end_connection(connection_id, 'disconnected')
    db.update_networks('device-1', {'local_addresses': [{'interface': 'eth0', 'address': '10.0.0.2'}]})
    db.update_system('device-1', {'os': 'Linux'})
    with db.connect() as connection:
        connection.execute('INSERT INTO device_upgrades VALUES (?,?,?,?,?,?,?,?,?)',
                           ('upgrade-1', 'device-1', '1.0.0', 'success', 100, 'done', 1, 1, 0))

    response = client.delete(BASE + '/devices/device-1')
    assert response.status_code == 200
    assert response.json() == {'ok': True}
    assert client.get(BASE + '/devices').json() == []
    with db.connect() as connection:
        assert connection.execute('SELECT COUNT(*) FROM devices WHERE id=?', ('device-1',)).fetchone()[0] == 0
        for table in ('device_networks', 'device_systems', 'device_connections', 'device_upgrades'):
            assert connection.execute(f'SELECT COUNT(*) FROM {table} WHERE device_id=?', ('device-1',)).fetchone()[0] == 0
    audit = client.get(BASE + '/audit').json()
    assert any(row['action'] == 'device.delete' and row['device_id'] == 'device-1' for row in audit)


def test_device_system_details_survive_disconnect_and_legacy_reconnect(client):
    login(client)
    system = {'os': 'Debian GNU/Linux 12 (bookworm)', 'distribution_id': 'debian',
              'kernel_version': '6.1.0-28-amd64'}
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(dict(HELLO, **system))
        assert ws.receive_json()['type'] == 'welcome'
        device = client.get(BASE + '/devices').json()[0]
        assert all(device[key] == value for key, value in system.items())
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO)
        assert ws.receive_json()['type'] == 'welcome'
    device = client.get(BASE + '/devices').json()[0]
    assert device['online'] is False
    assert all(device[key] == value for key, value in system.items())


def test_legacy_system_info_populates_device_list(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO)
        assert ws.receive_json()['type'] == 'welcome'
        assert client.get(BASE + '/devices').json()[0]['os'] is None
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(client.post, BASE + '/devices/device-1/command', json={'action': 'system.info'})
            request = ws.receive_json()
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': True,
                          'result': {'os': 'Ubuntu 24.04.1 LTS'}})
            assert pending.result().status_code == 200
        assert client.get(BASE + '/devices').json()[0]['os'] == 'Ubuntu 24.04.1 LTS'


def test_device_system_details_ignore_invalid_optional_values(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(dict(HELLO, os={'name': 'invalid'}, distribution_id='x' * 257, kernel_version=['invalid']))
        assert ws.receive_json()['type'] == 'welcome'
        device = client.get(BASE + '/devices').json()[0]
        assert all(device[key] is None for key in ('os', 'distribution_id', 'kernel_version'))


def test_remote_error_and_file_transfer(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO); ws.receive_json()
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(client.post, BASE + '/devices/device-1/upload?path=hello.txt', files={'file': ('hello.txt', b'hello')})
            request = ws.receive_json()
            assert request['action'] == 'fs.write'
            assert base64.b64decode(request['params']['data']) == b'hello'
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': True, 'result': {'bytes': 5}})
            assert pending.result().status_code == 200
            pending = pool.submit(client.get, BASE + '/devices/device-1/download?path=hello.txt')
            request = ws.receive_json()
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': True, 'result': {'data': base64.b64encode(b'hello').decode()}})
            assert pending.result().content == b'hello'
            pending = pool.submit(client.post, BASE + '/devices/device-1/command', json={'action': 'screen.capture'})
            request = ws.receive_json()
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': False, 'error': 'No display'})
            assert pending.result().status_code == 502
    assert client.post(BASE + '/devices/device-1/upload?path=large.bin', files={'file': ('large.bin', b'x' * (8 * 1024 * 1024 + 1))}).status_code == 413


def test_disconnect_fails_pending_request(client):
    login(client)
    with ThreadPoolExecutor() as pool:
        with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
            ws.send_json(HELLO); ws.receive_json()
            pending = pool.submit(client.post, BASE + '/devices/device-1/command', json={'action': 'system.info'})
            ws.receive_json()
        assert pending.result().status_code == 409


def test_password_rotation_revokes_sessions(tmp_path):
    settings = Settings(tmp_path, PASSWORD, TOKEN, 'a1b2c3d4')
    with TestClient(create_app(settings)) as first:
        login(first)
        cookies = first.cookies
    with TestClient(create_app(Settings(tmp_path, PASSWORD + '-new', TOKEN, 'a1b2c3d4'))) as second:
        second.cookies = cookies
        assert second.get(BASE + '/session').status_code == 401
        assert second.post(BASE + '/login', json={'password': PASSWORD}).status_code == 401
        assert second.post(BASE + '/login', json={'password': PASSWORD + '-new'}).status_code == 200


def test_device_replacement_preserves_new_connection(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as old:
        old.send_json(HELLO); old.receive_json()
        with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as new:
            new.send_json(HELLO); new.receive_json()
            with pytest.raises(WebSocketDisconnect):
                old.receive_json()
            assert client.get(BASE + '/devices').json()[0]['online'] is True
            new.send_json({'type': 'heartbeat'})
            assert new.receive_json()['type'] == 'heartbeat_ack'
            history = client.get(BASE + '/devices/device-1/connections').json()['items']
            assert len(history) == 2
            assert history[0]['disconnected_at'] is None
            assert history[1]['reason'] == 'reconnected'
            assert history[1]['disconnected_at'] == history[0]['connected_at']


def test_connection_history_auth_pagination_and_isolation(client):
    endpoint = BASE + '/devices/device-1/connections'
    assert client.get(endpoint).status_code == 401
    assert client.get(BASE + '/connections').status_code == 401
    login(client)
    assert client.get(endpoint).status_code == 404
    db = client.app.state.db
    db.upsert_device(HELLO)
    assert client.get(endpoint).json() == {'items': [], 'next_before': None}
    for _ in range(53):
        connection_id = db.start_connection('device-1')
        db.end_connection(connection_id, 'disconnected')
    db.upsert_device({**HELLO, 'id': 'device-2'})
    db.start_connection('device-2')
    page = client.get(endpoint).json()
    assert len(page['items']) == 50
    assert all(row['device_id'] == 'device-1' for row in page['items'])
    older = client.get(endpoint, params={'before': page['next_before']}).json()
    assert len(older['items']) == 3
    assert older['next_before'] is None
    assert set(row['id'] for row in page['items']).isdisjoint(row['id'] for row in older['items'])
    assert client.get(endpoint, params={'before': 0}).status_code == 422
    all_page = client.get(BASE + '/connections').json()
    assert len(all_page['items']) == 50
    assert all_page['items'][0]['device_id'] == 'device-2'
    assert all_page['items'][0]['device_name'] == HELLO['name']
    assert all_page['items'][0]['disconnected_at'] is None
    all_older = client.get(BASE + '/connections', params={'before': all_page['next_before']}).json()
    assert len(all_older['items']) == 4
    assert all_older['next_before'] is None


def test_connection_history_recovers_restart_and_preserves_shutdown(tmp_path):
    path = tmp_path / 'remote.sqlite3'
    db = Database(path, PASSWORD)
    db.upsert_device(HELLO)
    first = db.start_connection('device-1')
    db.touch_connection(first)
    db = Database(path, PASSWORD)
    with db.connect() as connection:
        row = connection.execute('SELECT * FROM device_connections WHERE id=?', (first,)).fetchone()
        assert row['reason'] == 'controller_restart'
        assert row['disconnected_at'] == row['last_seen']
    second = db.start_connection('device-1')
    db.close_connections()
    db.end_connection(second, 'disconnected')
    db = Database(path, PASSWORD)
    with db.connect() as connection:
        rows = connection.execute('SELECT * FROM device_connections ORDER BY id').fetchall()
        assert len(rows) == 2
        assert rows[1]['reason'] == 'controller_shutdown'


def test_connection_history_records_heartbeat_timeout(client, monkeypatch):
    import asyncio
    wait_for = asyncio.wait_for

    async def short_timeout(awaitable, timeout):
        return await wait_for(awaitable, timeout=0.05 if timeout == 65 else timeout)

    monkeypatch.setattr(asyncio, 'wait_for', short_timeout)
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        with pytest.raises(WebSocketDisconnect):
            ws.receive_json()
    row = client.get(BASE + '/devices/device-1/connections').json()['items'][0]
    assert row['reason'] == 'heartbeat_timeout'
    assert row['disconnected_at'] is not None


def test_text_edit_validation_and_empty_content(client):
    login(client)
    for content in (None, 123, 'x' * (256 * 1024 + 1)):
        result = client.post(BASE + '/devices/missing/command', json={'action': 'fs.edit', 'params': {'path': 'a.txt', 'content': content}})
        assert result.status_code == 400
    assert client.post(BASE + '/devices/missing/command', json={'action': 'fs.edit', 'params': {'path': 'a.txt', 'content': ''}}).status_code == 409


def test_device_networks_report_and_persist(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN, 'X-Forwarded-For': '8.8.8.8'}) as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        assert client.get(BASE + '/devices').json()[0]['source_ip'] is None
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(client.post, BASE + '/devices/device-1/command', json={'action': 'system.info'})
            request = ws.receive_json()
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': True, 'result': {
                'local_addresses': [{'interface': 'Ethernet', 'address': '10.0.0.15'},
                                    {'interface': 'bad', 'address': 'invalid'}, {'interface': 'bad', 'address': 123}],
                'public_ip': '8.8.8.8',
            }})
            assert pending.result().status_code == 200
    device = client.get(BASE + '/devices').json()[0]
    assert device['online'] is False
    assert device['local_addresses'] == [{'interface': 'Ethernet', 'address': '10.0.0.15'}]
    assert device['public_ip'] == '8.8.8.8'
    assert device['public_ip_source'] == 'ipinfo.io'
    assert device['reported_at'] is not None
    db = Database(client.app.state.db.path, PASSWORD)
    with db.connect() as connection:
        assert connection.execute('SELECT public_ip FROM device_networks').fetchone()[0] == '8.8.8.8'


def test_network_addresses_distinguish_private_and_public_sources(client):
    login(client)
    db = client.app.state.db
    db.upsert_device(HELLO, '::ffff:10.0.0.15')
    device = client.get(BASE + '/devices').json()[0]
    assert device['source_ip'] == '10.0.0.15'
    assert device['public_ip'] is None
    assert device['local_addresses'] == []
    db.upsert_device(HELLO, '::ffff:8.8.4.4')
    db.update_networks(HELLO['id'], {'local_addresses': [], 'public_ip': '192.168.1.10'})
    device = client.get(BASE + '/devices').json()[0]
    assert device['public_ip'] == '8.8.4.4'
    assert device['public_ip_source'] == 'connection'
    db.update_networks(HELLO['id'], {'hostname': 'old-client'})
    assert client.get(BASE + '/devices').json()[0]['source_ip'] == '8.8.4.4'


def test_audit_operation_lifecycle_and_sensitive_content(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO); ws.receive_json()
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(client.post, BASE + '/devices/device-1/command', json={
                'action': 'fs.edit', 'params': {'path': 'notes.txt', 'content': 'private-file-body'}},
                headers={'X-Request-ID': 'audit-lifecycle-123'})
            request = ws.receive_json()
            running = client.get(BASE + '/audit/records', params={'status': 'started'}).json()
            assert running['summary']['pending'] == 1
            row = running['items'][0]
            assert row['target'] == 'notes.txt'
            assert row['source_ip'] == 'testclient'
            assert row['device_name'] == HELLO['name']
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': True, 'result': {'bytes': 17}})
            assert pending.result().status_code == 200
    records = client.get(BASE + '/audit/records', params={'search': 'audit-lifecycle-123'}).json()
    assert records['summary'] == {'total': 1, 'success': 1, 'errors': 0, 'pending': 0}
    finished = records['items'][0]
    assert finished['id'] == row['id']
    assert finished['action_label'] == '保存文本'
    assert finished['detail'] == '文本已保存。'
    assert finished['duration_ms'] >= 0
    raw = client.get(BASE + '/audit').text
    for secret in ('private-file-body', PASSWORD, TOKEN):
        assert secret not in raw


@pytest.mark.parametrize('exit_code,expected', [(0, 'success'), (7, 'failed'), (None, 'failed')])
def test_audit_shell_exit_status(client, exit_code, expected):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO); ws.receive_json()
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(client.post, BASE + '/devices/device-1/command', json={
                'action': 'shell.exec', 'params': {'command': 'echo private-command'}})
            request = ws.receive_json()
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': True, 'result': {
                'exit_code': exit_code, 'stdout': 'private-output', 'stderr': 'private-stderr', 'truncated': True}})
            assert pending.result().status_code == 200
    records = client.get(BASE + '/audit/records', params={'category': 'shell'}).json()
    assert records['summary']['total'] == 1
    assert records['items'][0]['status'] == expected
    assert '截断' in records['items'][0]['detail']
    for secret in ('private-command', 'private-output', 'private-stderr'):
        assert secret not in str(records)


def test_audit_filters_pagination_legacy_and_auth(client):
    endpoint = BASE + '/audit/records'
    assert client.get(endpoint).status_code == 401
    login(client)
    db = client.app.state.db
    db.upsert_device(HELLO)
    db.audit('legacy-request', 'device-1', 'fs.list', 'interrupted')
    done_id = db.audit('legacy-request', 'device-1', 'fs.list', 'success')
    db.audit('independent-request', 'device-1', 'fs.delete', 'failed', 'Access denied', target='report.txt')
    db.audit('pending-request', 'device-1', 'system.info', 'started')
    page = client.get(endpoint, params={'page_size': 2}).json()
    assert page['summary'] == {'total': 4, 'success': 2, 'errors': 1, 'pending': 1}
    older = client.get(endpoint, params={'page': 2, 'page_size': 2}).json()
    assert len(page['items']) == len(older['items']) == 2
    assert set(row['id'] for row in page['items']).isdisjoint(row['id'] for row in older['items'])
    files = client.get(endpoint, params={'category': 'files', 'search': HELLO['name']}).json()
    assert files['summary']['total'] == 2
    legacy = next(row for row in files['items'] if row['id'] == done_id)
    assert '历史记录' in legacy['detail']
    assert legacy['target'] == '' and legacy['duration_ms'] is None
    filtered = client.get(endpoint, params={'status': 'failed', 'search': 'report.txt'}).json()
    assert filtered['summary']['total'] == 1
    assert filtered['items'][0]['action_label'] == '删除文件或目录'
    assert client.get(endpoint, params={'category': 'auth'}).json()['summary']['total'] == 1
    assert client.get(endpoint, params={'search': "' OR 1=1 --"}).json()['summary']['total'] == 0
    for params in ({'page': 0}, {'page_size': 101}, {'status': 'invalid'}, {'category': 'invalid'}):
        assert client.get(endpoint, params=params).status_code == 422


def test_audit_failure_timeout_and_invalid_download(client):
    login(client)
    assert client.post(BASE + '/devices/missing/command', json={'action': 'system.info'}).status_code == 409
    assert client.get(BASE + '/audit/records').json()['items'][0]['status'] == 'failed'
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO); ws.receive_json()
        assert client.post(BASE + '/devices/device-1/command', json={'action': 'system.info'}).status_code == 504
        ws.receive_json()
        row = client.get(BASE + '/audit/records').json()['items'][0]
        assert row['status'] == 'timeout'
        assert '可能已经执行' in row['detail']
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(client.get, BASE + '/devices/device-1/download?path=report.txt')
            request = ws.receive_json()
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': True, 'result': {'data': '!invalid!'}})
            assert pending.result().status_code == 502
            row = client.get(BASE + '/audit/records').json()['items'][0]
            assert row['status'] == 'failed' and '下载失败' in row['detail']
            pending = pool.submit(client.post, BASE + '/devices/device-1/command', json={'action': 'screen.capture'})
            request = ws.receive_json()
            ws.send_json({'type': 'response', 'id': request['id'], 'ok': False, 'error': 'No display'})
            assert pending.result().status_code == 502
            row = client.get(BASE + '/audit/records').json()['items'][0]
            assert row['status'] == 'failed' and 'No display' in row['detail']


def test_audit_old_schema_migration_and_restart(tmp_path):
    path = tmp_path / 'old.sqlite3'
    with sqlite3.connect(path) as db:
        db.executescript("""CREATE TABLE audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT, time REAL NOT NULL, trace_id TEXT NOT NULL,
            device_id TEXT, action TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL);
            INSERT INTO audit VALUES (1, 1, 'legacy', 'device-1', 'system.info', 'started', '');
            INSERT INTO audit VALUES (2, 2, 'complete', 'device-1', 'system.info', 'success', '');""")
    database = Database(path, PASSWORD)
    database = Database(path, PASSWORD)
    with database.connect() as db:
        rows = db.execute('SELECT * FROM audit ORDER BY id').fetchall()
    assert [row['status'] for row in rows] == ['interrupted', 'success']
    assert rows[0]['target'] == ''
    assert rows[0]['duration_ms'] is None and rows[0]['source_ip'] is None
