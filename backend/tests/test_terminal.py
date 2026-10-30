import asyncio
import base64

import pytest
from starlette.websockets import WebSocketDisconnect

from lib.hub import Connection, Hub
from test_app import BASE, HELLO, TOKEN, client, login

PATH = BASE + '/devices/device-1/terminal'
ORIGIN = {'Origin': 'http://testserver'}


def receive(socket):
    while True:
        value = socket.receive_json()
        if value['type'] != 'ping':
            return value


def start(browser, agent, client):
    browser.send_json({'csrf_token': client.headers['X-CSRF-Token'], 'cols': 80, 'rows': 24})
    opened = agent.receive_json()
    assert opened['type'] == 'terminal' and opened['event'] == 'open'
    agent.send_json({'type': 'terminal', 'session': opened['session'], 'event': 'ready'})
    assert receive(browser) == {'type': 'ready'}
    return opened['session']


def test_terminal_authentication(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(PATH, headers=ORIGIN):
            pass
    login(client)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(PATH, headers={'Origin': 'https://evil.invalid'}):
            pass
    with client.websocket_connect(PATH, headers=ORIGIN) as browser:
        browser.send_json({'csrf_token': 'wrong', 'cols': 80, 'rows': 24})
        with pytest.raises(WebSocketDisconnect):
            browser.receive_json()


@pytest.mark.parametrize('size', [{'cols': True, 'rows': 24}, {'cols': 0, 'rows': 24}, {'cols': 501, 'rows': 24}, {'cols': 80, 'rows': -1}])
def test_terminal_size_validation(client, size):
    login(client)
    with client.websocket_connect(PATH, headers=ORIGIN) as browser:
        browser.send_json({'csrf_token': client.headers['X-CSRF-Token'], **size})
        assert receive(browser)['type'] == 'error'


def test_terminal_old_agent(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as agent:
        agent.send_json(HELLO)
        agent.receive_json()
        with client.websocket_connect(PATH, headers=ORIGIN) as browser:
            browser.send_json({'csrf_token': client.headers['X-CSRF-Token'], 'cols': 80, 'rows': 24})
            assert '升级' in receive(browser)['detail']
        assert not client.app.state.hub.connections['device-1'].terminals


def test_terminal_input_output_resize_exit_and_private_audit(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as agent:
        agent.send_json({**HELLO, 'capabilities': ['terminal-v1']})
        agent.receive_json()
        with client.websocket_connect(PATH, headers=ORIGIN) as browser:
            sid = start(browser, agent, client)
            browser.send_json({'type': 'input', 'data': 'echo private-terminal-secret\r'})
            assert agent.receive_json() == {'type': 'terminal', 'session': sid, 'event': 'input', 'data': 'echo private-terminal-secret\r'}
            browser.send_json({'type': 'resize', 'cols': 120, 'rows': 42})
            assert agent.receive_json()['cols'] == 120
            data = base64.b64encode('测试\x1b[31m'.encode()).decode()
            agent.send_json({'type': 'terminal', 'session': sid, 'event': 'output', 'sequence': 1, 'data': data})
            assert receive(browser) == {'type': 'output', 'sequence': 1, 'data': data}
            browser.send_json({'type': 'ack', 'sequence': 1})
            assert agent.receive_json() == {'type': 'terminal', 'session': sid, 'event': 'ack', 'sequence': 1}
            agent.send_json({'type': 'terminal', 'session': sid, 'event': 'exit', 'exit_code': 0})
            assert receive(browser) == {'type': 'exit', 'exit_code': 0}
            assert agent.receive_json()['event'] == 'close'
        assert not client.app.state.hub.connections['device-1'].terminals
        records = client.get(BASE + '/audit/records', params={'category': 'shell'}).json()['items']
        assert len(records) == 1 and records[0]['action'] == 'terminal.session'
        assert records[0]['status'] == 'success'
        assert 'private-terminal-secret' not in client.get(BASE + '/audit').text


def test_terminal_session_limit_isolation_and_close(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as agent:
        agent.send_json({**HELLO, 'capabilities': ['terminal-v1']})
        agent.receive_json()
        with client.websocket_connect(PATH, headers=ORIGIN) as first, client.websocket_connect(PATH, headers=ORIGIN) as second:
            one = start(first, agent, client)
            two = start(second, agent, client)
            assert one != two
            with client.websocket_connect(PATH, headers=ORIGIN) as third:
                third.send_json({'csrf_token': client.headers['X-CSRF-Token'], 'cols': 80, 'rows': 24})
                assert '两个' in receive(third)['detail']
            first.send_json({'type': 'input', 'data': 'one'})
            assert agent.receive_json()['session'] == one
            second.send_json({'type': 'input', 'data': 'two'})
            assert agent.receive_json()['session'] == two
            first.send_json({'type': 'close'})
            assert agent.receive_json() == {'type': 'terminal', 'session': one, 'event': 'close'}
            second.send_json({'type': 'close'})
            assert agent.receive_json() == {'type': 'terminal', 'session': two, 'event': 'close'}
        assert not client.app.state.hub.connections['device-1'].terminals


@pytest.mark.parametrize('message', [{'type': 'ack', 'sequence': 1}, {'type': 'input', 'data': 'a' * 4097}, {'type': 'resize', 'cols': 80, 'rows': True}])
def test_terminal_invalid_input_closes_session(client, message):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as agent:
        agent.send_json({**HELLO, 'capabilities': ['terminal-v1']})
        agent.receive_json()
        with client.websocket_connect(PATH, headers=ORIGIN) as browser:
            start(browser, agent, client)
            browser.send_json(message)
            assert receive(browser)['type'] == 'error'
            assert agent.receive_json()['event'] == 'close'


def test_terminal_logout_ends_shell(client):
    login(client)
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as agent:
        agent.send_json({**HELLO, 'capabilities': ['terminal-v1']})
        agent.receive_json()
        with client.websocket_connect(PATH, headers=ORIGIN) as browser:
            sid = start(browser, agent, client)
            client.post(BASE + '/logout')
            assert '过期' in receive(browser)['detail']
            assert agent.receive_json() == {'type': 'terminal', 'session': sid, 'event': 'close'}


def test_terminal_device_disconnect(client):
    login(client)
    with client.websocket_connect(PATH, headers=ORIGIN) as browser:
        with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as agent:
            agent.send_json({**HELLO, 'capabilities': ['terminal-v1']})
            agent.receive_json()
            start(browser, agent, client)
        assert receive(browser)['type'] == 'error'


def test_terminal_queue_is_bounded():
    connection = Connection(None)
    queue = asyncio.Queue(maxsize=2)
    connection.terminals['test'] = queue
    hub = Hub()
    for _ in range(3):
        hub.terminal_receive(connection, {'session': 'test', 'event': 'output'})
    assert queue.qsize() == 1 and queue.get_nowait()['event'] == 'error'
