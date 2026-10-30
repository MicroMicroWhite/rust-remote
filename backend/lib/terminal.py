"""Authenticated, connection-bound PTY relay with end-to-end output acknowledgements."""
import asyncio
import base64
import binascii
import hmac
import time
from uuid import uuid4

from fastapi import WebSocketDisconnect

from .db import token_hash
from .hub import DeviceUnavailable


def dimensions(value):
    cols, rows = value.get('cols'), value.get('rows')
    if type(cols) is not int or type(rows) is not int or not 2 <= cols <= 500 or not 1 <= rows <= 300:
        raise ValueError('终端尺寸无效。')
    return {'cols': cols, 'rows': rows}


async def terminal_socket(socket, device_id, db, hub):
    proto = socket.headers.get('x-forwarded-proto', 'https' if socket.url.scheme == 'wss' else 'http')
    if socket.headers.get('origin', '') != f"{proto}://{socket.headers.get('host', '')}":
        await socket.close(code=1008)
        return
    token = token_hash(socket.cookies.get('remote_session', ''))

    def account():
        with db.connect() as conn:
            return conn.execute('SELECT * FROM sessions WHERE token=? AND expires>?', (token, time.time())).fetchone()

    user = account()
    if not user:
        await socket.close(code=1008)
        return
    await socket.accept()
    session_id, trace_id = str(uuid4()), str(uuid4())
    device = None
    audit_id = None
    registered = False
    tasks = []
    started = time.monotonic()
    status, detail = 'success', '终端会话已结束。'
    try:
        hello = await asyncio.wait_for(socket.receive_json(), 5)
        if not isinstance(hello, dict) or not isinstance(hello.get('csrf_token'), str) or not hmac.compare_digest(hello['csrf_token'], user['csrf']):
            await socket.close(code=1008)
            return
        size = dimensions(hello)
        if not account():
            raise ValueError('登录会话已过期，请重新登录。')
        device = hub.connections.get(device_id)
        if not device:
            raise DeviceUnavailable('设备已离线。')
        if 'terminal-v1' not in device.metadata.get('capabilities', []):
            raise ValueError('请先升级被控端，以使用交互式终端。')
        if len(device.terminals) >= 2:
            raise ValueError('此设备已有两个终端会话，请先关闭其中一个。')
        queue = asyncio.Queue(maxsize=8)
        device.terminals[session_id] = queue
        registered = True
        audit_id = db.audit(trace_id, device_id, 'terminal.session', 'started', '正在连接交互式终端。',
                            target='交互式终端（不保存输入和输出）', source_ip=socket.client.host if socket.client else None)
        await hub.terminal_send(device, session_id, 'open', **size)
        pending_ack = None
        ready = False
        ready_event = asyncio.Event()

        async def receive():
            nonlocal pending_ack
            while True:
                value = await socket.receive_json()
                if not isinstance(value, dict):
                    raise ValueError('无效的终端消息。')
                event = value.get('type')
                if event == 'close':
                    return
                if not ready:
                    raise ValueError('终端尚未就绪。')
                if event == 'input':
                    data = value.get('data')
                    if not isinstance(data, str) or not 1 <= len(data.encode('utf-8')) <= 4096:
                        raise ValueError('终端输入超过限制。')
                    await hub.terminal_send(device, session_id, 'input', data=data)
                elif event == 'resize':
                    await hub.terminal_send(device, session_id, 'resize', **dimensions(value))
                elif event == 'ack':
                    sequence = value.get('sequence')
                    if type(sequence) is not int or sequence != pending_ack:
                        raise ValueError('无效的终端输出确认。')
                    pending_ack = None
                    await hub.terminal_send(device, session_id, 'ack', sequence=sequence)
                else:
                    raise ValueError('无效的终端消息。')

        async def forward():
            nonlocal pending_ack, ready, detail, status
            sequence = 0
            while True:
                value = await queue.get()
                event = value.get('event')
                if event == 'ready' and not ready:
                    ready = True
                    ready_event.set()
                    await socket.send_json({'type': 'ready'})
                elif event == 'output' and ready:
                    data, seq = value.get('data'), value.get('sequence')
                    if not isinstance(data, str) or len(data) > 21848 or type(seq) is not int or seq != sequence + 1 or pending_ack is not None:
                        raise ValueError('设备返回的终端数据无效。')
                    try:
                        decoded = base64.b64decode(data, validate=True)
                    except (ValueError, binascii.Error) as exc:
                        raise ValueError('设备返回的终端数据无效。') from exc
                    if not 1 <= len(decoded) <= 16384:
                        raise ValueError('设备返回的终端数据无效。')
                    sequence = pending_ack = seq
                    await socket.send_json({'type': 'output', 'data': data, 'sequence': seq})
                elif event == 'exit' and ready:
                    code = value.get('exit_code')
                    if code is not None and (type(code) is not int or not 0 <= code <= 2**32 - 1):
                        raise ValueError('无效的终端退出码。')
                    detail = f'终端进程已退出，退出码 {code}。'
                    status = 'success' if code == 0 else 'failed'
                    await socket.send_json({'type': 'exit', 'exit_code': code})
                    return
                elif event == 'error':
                    message = value.get('detail')
                    raise ValueError(message[:512] if isinstance(message, str) else '终端连接失败。')
                else:
                    raise ValueError('设备返回了无效的终端消息。')

        async def monitor():
            try:
                await asyncio.wait_for(ready_event.wait(), 15)
            except TimeoutError as exc:
                raise ValueError('启动终端超时。') from exc
            while True:
                if not account():
                    raise ValueError('登录会话已过期，请重新登录。')
                if hub.connections.get(device_id) is not device:
                    raise DeviceUnavailable('设备连接已变化，请重新连接终端。')
                # Keep an idle terminal alive through reverse-proxy read timeouts.
                await socket.send_json({'type': 'ping'})
                await asyncio.sleep(2)

        tasks = [asyncio.create_task(receive()), asyncio.create_task(forward()), asyncio.create_task(monitor())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        status, detail = 'interrupted', '终端会话被中断。'
        raise
    except (ValueError, DeviceUnavailable, TimeoutError, RuntimeError, OSError) as exc:
        status, detail = 'failed', str(exc) or '终端连接超时。'
        try:
            await socket.send_json({'type': 'error', 'detail': detail})
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if registered:
            device.terminals.pop(session_id, None)
            # Never address a replacement connection with an old session ID.
            if hub.connections.get(device_id) is device:
                try:
                    await hub.terminal_send(device, session_id, 'close')
                except (RuntimeError, OSError, TimeoutError, WebSocketDisconnect):
                    pass
        if audit_id is not None:
            db.finish_audit(audit_id, status, detail, (time.monotonic() - started) * 1000)
        try:
            await socket.close()
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass
