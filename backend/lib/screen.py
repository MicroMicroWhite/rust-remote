import asyncio
import hmac
import math
import time
from uuid import uuid4

from fastapi import HTTPException, WebSocketDisconnect

from .db import token_hash
from .hub import DeviceUnavailable, RemoteError

KEYS = {'Enter', 'Escape', 'Backspace', 'Tab', 'Delete', 'Insert', 'Home', 'End',
        'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'CapsLock'} | {f'F{i}' for i in range(1, 13)}


def validate_input(params):
    kind = params.get('kind')
    fields = {'click': {'x', 'y', 'button'}, 'scroll': {'x', 'y', 'amount'}, 'key': {'key'}, 'text': {'text'}}
    if not isinstance(kind, str) or kind not in fields or set(params) - (fields[kind] | {'kind', 'modifiers'}):
        raise HTTPException(400, 'Invalid desktop input')
    modifiers = params.get('modifiers', [])
    if not isinstance(modifiers, list) or len(modifiers) > 4 or any(m not in ('Control', 'Alt', 'Shift', 'Meta') for m in modifiers):
        raise HTTPException(400, 'Invalid keyboard modifiers')
    if kind in {'click', 'scroll'}:
        for name in ('x', 'y'):
            value = params.get(name)
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
                raise HTTPException(400, 'Invalid screen coordinates')
    if kind == 'click' and params.get('button') not in ('left', 'right', 'middle'):
        raise HTTPException(400, 'Invalid mouse button')
    if kind == 'scroll' and (type(params.get('amount')) is not int or not -20 <= params['amount'] <= 20):
        raise HTTPException(400, 'Invalid scroll amount')
    if kind == 'key':
        key = params.get('key')
        if not isinstance(key, str) or not (key in KEYS or len(key) == 1 and key.isprintable()):
            raise HTTPException(400, 'Unsupported keyboard key')
    if kind == 'text':
        text = params.get('text')
        if not isinstance(text, str) or not text or len(text.encode()) > 4096 or '\0' in text:
            raise HTTPException(400, 'Text must contain 1–4096 UTF-8 bytes')


def frame_rate(value):
    if type(value) is not int or not 1 <= value <= 30:
        raise ValueError('帧率需在 1–30 FPS 之间。')
    return value


async def observe_screen(socket, device_id, db, hub, settings, sessions):
    # A browser session cookie plus a first-message CSRF token protects this
    # channel. Credentials never appear in the URL, access log or frame data.
    proto = socket.headers.get('x-forwarded-proto', 'https' if socket.url.scheme == 'wss' else 'http')
    origin = socket.headers.get('origin', '')
    if origin != f"{proto}://{socket.headers.get('host', '')}":
        await socket.close(code=1008)
        return
    session_token = token_hash(socket.cookies.get('remote_session', ''))

    def session():
        with db.connect() as connection:
            return connection.execute('SELECT * FROM sessions WHERE token=? AND expires>?', (session_token, time.time())).fetchone()

    account = session()
    if not account:
        await socket.close(code=1008)
        return
    await socket.accept()
    trace_id = str(uuid4())
    audit_id = None
    tasks = []
    frames = 0
    counted = False
    started = time.monotonic()
    status, detail = 'success', ''
    try:
        hello = await asyncio.wait_for(socket.receive_json(), 5)
        if not isinstance(hello, dict) or not isinstance(hello.get('csrf_token'), str) or not hmac.compare_digest(hello['csrf_token'], account['csrf']):
            await socket.close(code=1008)
            return
        fps = frame_rate(hello.get('fps', 15))
        if sessions.get(device_id, 0) >= 2:
            raise ValueError('此设备已有两个观察窗口，请关闭其中一个再试。')
        device = hub.connections.get(device_id)
        if not device:
            raise DeviceUnavailable('设备已离线。')
        sessions[device_id] += 1
        counted = True
        audit_id = db.audit(trace_id, device_id, 'screen.observe', 'started', '正在观察主屏幕。',
                            target='主屏幕', source_ip=socket.client.host if socket.client else None)
        changed = asyncio.Event()

        async def receive():
            nonlocal fps
            while True:
                value = await socket.receive_json()
                if not isinstance(value, dict) or value.get('type') != 'configure':
                    raise ValueError('无效的屏幕观察消息。')
                fps = frame_rate(value.get('fps'))
                changed.set()

        async def capture():
            nonlocal frames
            checked_at = 0
            while True:
                tick = time.monotonic()
                if tick - checked_at >= 2:
                    checked_at = tick
                    if not session():
                        raise ValueError('登录会话已过期，请重新登录。')
                if hub.connections.get(device_id) is not device:
                    raise DeviceUnavailable('设备连接已变化，请重新开始观察。')
                image = await hub.request(device_id, 'screen.capture', {'max_width': 1280, 'quality': 65}, trace_id, settings.command_timeout)
                if not isinstance(image, dict) or not isinstance(image.get('data'), str):
                    raise ValueError('设备返回的屏幕数据无效。')
                await socket.send_json({**image, 'type': 'frame'})
                frames += 1
                # One outstanding capture per observer, paced after completion;
                # slow devices never accumulate a queue of stale frames.
                changed.clear()
                try:
                    await asyncio.wait_for(changed.wait(), max(0.001, 1 / fps - (time.monotonic() - tick)))
                except TimeoutError:
                    pass

        tasks = [asyncio.create_task(receive()), asyncio.create_task(capture())]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        status, detail = 'interrupted', '屏幕观察被中断。'
        raise
    except (ValueError, DeviceUnavailable, RemoteError, TimeoutError) as exc:
        status, detail = 'failed', str(exc) or '获取屏幕超时。'
        try:
            await socket.send_json({'type': 'error', 'detail': detail})
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if counted:
            sessions[device_id] -= 1
            if not sessions[device_id]:
                del sessions[device_id]
        if audit_id is not None:
            db.finish_audit(audit_id, status, detail or f'屏幕观察结束，共传输 {frames} 帧。', (time.monotonic() - started) * 1000)
        try:
            await socket.close()
        except (RuntimeError, WebSocketDisconnect, OSError):
            pass
