from concurrent.futures import ThreadPoolExecutor

import pytest
from starlette.websockets import WebSocketDisconnect

from test_app import BASE, HELLO, TOKEN, client, login


@pytest.mark.parametrize('action,params', [
    ('process.kill', {'pid': 1, 'start_time': 1}),
    ('process.kill', {'pid': True, 'start_time': 1}),
    ('process.kill', {'pid': 10}),
    ('process.kill', {'pid': 10, 'start_time': -1}),
    ('screen.input', {'kind': []}),
    ('screen.input', {'kind': 'click', 'x': -0.01, 'y': 0.5, 'button': 'left'}),
    ('screen.input', {'kind': 'click', 'x': True, 'y': 0.5, 'button': 'left'}),
    ('screen.input', {'kind': 'key', 'key': 'Unidentified'}),
    ('screen.input', {'kind': 'key', 'key': 'a', 'modifiers': ['invalid']}),
    ('screen.input', {'kind': 'text', 'text': '\0'}),
    ('screen.input', {'kind': 'scroll', 'x': 0.2, 'y': 0.5, 'amount': 100}),
])
def test_desktop_parameters_are_validated(client, action, params):
    login(client)
    assert client.post(BASE + '/devices/device-1/command', json={'action': action, 'params': params}).status_code == 400


def test_process_identity_forwarding_and_private_input_audit(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json({**HELLO, 'capabilities': ['process-kill-v1', 'screen-input-v1']})
        ws.receive_json()
        assert 'screen-input-v1' in client.get(BASE + '/devices').json()[0]['capabilities']
        for action, params in [('process.kill', {'pid': 1234, 'start_time': 1700000000}),
                               ('screen.input', {'kind': 'text', 'text': 'private desktop text'})]:
            with ThreadPoolExecutor() as pool:
                pending = pool.submit(client.post, BASE + '/devices/device-1/command', json={'action': action, 'params': params})
                request = ws.receive_json()
                assert request['action'] == action and request['params'] == params
                ws.send_json({'type': 'response', 'id': request['id'], 'ok': True, 'result': {'sent': True}})
                assert pending.result().status_code == 200
        records = client.get(BASE + '/audit/records', params={'category': 'system'}).json()['items']
        assert {row['action'] for row in records} >= {'process.kill', 'screen.input'}
        assert any(row['target'] == 'PID 1234' for row in records)
        assert 'private desktop text' not in client.get(BASE + '/audit').text


def test_old_device_rejects_new_input_operations(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(HELLO)
        ws.receive_json()
        response = client.post(BASE + '/devices/device-1/command', json={'action': 'process.kill', 'params': {'pid': 100, 'start_time': 1}})
        assert response.status_code == 409 and '升级' in response.json()['detail']


def test_screen_requires_session_origin_and_csrf(client):
    path = BASE + '/devices/device-1/screen'
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path, headers={'Origin': 'http://testserver'}):
            pass
    login(client)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(path, headers={'Origin': 'https://evil.invalid'}):
            pass
    with client.websocket_connect(path, headers={'Origin': 'http://testserver'}) as screen:
        screen.send_json({'csrf_token': 'wrong', 'fps': 15})
        with pytest.raises(WebSocketDisconnect):
            screen.receive_json()


def test_screen_frames_configure_and_session_audit(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as agent:
        agent.send_json(HELLO)
        agent.receive_json()
        with client.websocket_connect(BASE + '/devices/device-1/screen', headers={'Origin': 'http://testserver'}) as screen:
            screen.send_json({'csrf_token': client.headers['X-CSRF-Token']})
            for _ in range(2):
                request = agent.receive_json()
                assert request['action'] == 'screen.capture'
                assert request['params'] == {'max_width': 1280, 'quality': 65}
                agent.send_json({'type': 'response', 'id': request['id'], 'ok': True,
                                 'result': {'data': 'fake-jpeg', 'mime': 'image/jpeg', 'width': 1280, 'height': 720}})
                assert screen.receive_json()['type'] == 'frame'
                screen.send_json({'type': 'configure', 'fps': 5})
            screen.send_json({'type': 'configure', 'fps': 31})
            assert screen.receive_json()['type'] == 'error'
        rows = client.get(BASE + '/audit/records', params={'category': 'system'}).json()['items']
        assert len(rows) == 1
        assert rows[0]['action'] == 'screen.observe'
        assert rows[0]['status'] == 'failed'


def test_screen_rechecks_revoked_session_and_cleans_pending(client):
    login(client)
    csrf = client.headers['X-CSRF-Token']
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as agent:
        agent.send_json(HELLO)
        agent.receive_json()
        with client.websocket_connect(BASE + '/devices/device-1/screen', headers={'Origin': 'http://testserver'}) as screen:
            assert client.post(BASE + '/logout').status_code == 200
            screen.send_json({'csrf_token': csrf, 'fps': 15})
            response = screen.receive_json()
            assert response['type'] == 'error' and '过期' in response['detail']
        assert client.app.state.hub.connections['device-1'].pending == {}
