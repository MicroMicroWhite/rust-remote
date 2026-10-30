import asyncio
from dataclasses import dataclass, field
from uuid import uuid4

from fastapi import WebSocket
from loguru import logger


class DeviceUnavailable(Exception):
    pass


class RemoteError(Exception):
    pass


@dataclass
class Connection:
    socket: WebSocket
    metadata: dict = field(default_factory=dict)
    pending: dict = field(default_factory=dict)
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    terminals: dict = field(default_factory=dict)


class Hub:
    def __init__(self):
        self.connections: dict[str, Connection] = {}

    async def attach(self, device_id, socket):
        previous = self.connections.get(device_id)
        connection = Connection(socket)
        self.connections[device_id] = connection
        if previous:
            self.fail_pending(previous)
            await previous.socket.close(code=4001, reason="Device reconnected")
        return connection

    def detach(self, device_id, connection):
        if self.connections.get(device_id) is connection:
            del self.connections[device_id]
        self.fail_pending(connection)

    @staticmethod
    def fail_pending(connection):
        for queue in connection.terminals.values():
            while not queue.empty():
                queue.get_nowait()
            queue.put_nowait({'event': 'error', 'detail': '设备连接已断开。'})
        for future in connection.pending.values():
            if not future.done():
                future.set_exception(DeviceUnavailable("Device disconnected"))
        connection.pending.clear()

    async def terminal_send(self, connection, session_id, event, **params):
        async with asyncio.timeout(5):
            async with connection.send_lock:
                await connection.socket.send_json({'type': 'terminal', 'session': session_id,
                                                   'event': event, **params})

    def terminal_receive(self, connection, message):
        session_id = message.get('session')
        if not isinstance(session_id, str):
            return
        queue = connection.terminals.get(session_id)
        if queue is not None:
            if queue.full():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait({'event': 'error', 'detail': '终端输出超过缓冲限制，会话已结束。'})
            else:
                queue.put_nowait(message)

    async def request(self, device_id, action, params, trace_id, timeout):
        connection = self.connections.get(device_id)
        if not connection:
            raise DeviceUnavailable("Device is offline")
        if len(connection.pending) >= 8:
            raise RemoteError("Device has too many pending requests")
        request_id = str(uuid4())
        future = asyncio.get_running_loop().create_future()
        connection.pending[request_id] = future
        try:
            async with asyncio.timeout(timeout):
                async with connection.send_lock:
                    await connection.socket.send_json({"type": "request", "id": request_id,
                        "trace_id": trace_id, "action": action, "params": params})
                message = await future
            if not message.get("ok"):
                raise RemoteError(str(message.get("error", "Remote operation failed")))
            return message.get("result")
        except TimeoutError:
            raise
        except (RuntimeError, OSError) as exc:
            raise DeviceUnavailable("Device connection is closed") from exc
        finally:
            connection.pending.pop(request_id, None)
            if not future.done():
                future.cancel()

    def resolve(self, connection, message):
        future = connection.pending.get(message.get("id"))
        if future and not future.done():
            future.set_result(message)
        else:
            logger.debug("Ignoring late or unknown device response")

    async def close(self):
        for connection in list(self.connections.values()):
            self.fail_pending(connection)
            await connection.socket.close(code=1001)
        self.connections.clear()
