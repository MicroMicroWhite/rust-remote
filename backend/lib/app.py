import asyncio
import base64
import binascii
import hmac
import ipaddress
import json
import os
import re
import secrets
import sys
import time
import urllib.request
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings
from .builds import Builds, BuildRequest, ClientConfig
from .audit import describe_record, operation_result, operation_target
from .db import Database, token_hash
from .hub import DeviceUnavailable, Hub, RemoteError
from .upgrades import Upgrades
from .screen import observe_screen, validate_input
from .terminal import terminal_socket

logger.remove()
logger.add(sys.stderr, serialize=True, enqueue=True, backtrace=False, diagnose=False)


class Login(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


class Command(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str
    params: dict = Field(default_factory=dict)


class UpgradeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    reinstall: bool = False


ACTIONS = {"system.info", "system.environment", "screen.capture", "screen.input", "fs.list", "fs.mkdir", "fs.delete", "fs.rename", "fs.text", "fs.edit", "process.list", "process.kill", "ports.list", "shell.exec"}


def validate_command(command):
    action, params = command.action, command.params
    if action not in ACTIONS:
        raise HTTPException(400, "Unsupported action")
    if action == 'screen.input':
        validate_input(params)
        return
    if action == 'process.kill':
        if set(params) != {'pid', 'start_time'} or type(params.get('pid')) is not int or not 1 < params['pid'] <= 2**32-1 or type(params.get('start_time')) is not int or params['start_time'] < 0:
            raise HTTPException(400, 'Invalid process identity; refresh the process list')
        return
    required = {"fs.list": ["path"], "fs.mkdir": ["path"], "fs.delete": ["path"],
                "fs.rename": ["path", "destination"], "fs.text": ["path"], "fs.edit": ["path"], "shell.exec": ["command"]}.get(action, [])
    allowed = set(required) | ({"timeout"} if action == "shell.exec" else {"content"} if action == "fs.edit" else set())
    if set(params) - allowed:
        raise HTTPException(400, "Unknown command parameters")
    for name in required:
        if not isinstance(params.get(name), str) or not params[name] or len(params[name]) > 8192 or "\x00" in params[name]:
            raise HTTPException(400, f"Invalid {name}")
    if action == "fs.edit" and (not isinstance(params.get("content"), str) or len(params["content"].encode()) > 256 * 1024):
        raise HTTPException(400, "Text content must be UTF-8 and at most 256 KiB")
    if action == "shell.exec" and (type(params.get("timeout", 30)) is not int or not 1 <= params.get("timeout", 30) <= 30):
        raise HTTPException(400, "Shell timeout must be an integer between 1 and 30 seconds")


def create_app(settings: Settings | None = None):
    settings = settings or Settings.from_env()
    hub = Hub()
    attempts = defaultdict(deque)
    screen_sessions = defaultdict(int)

    @asynccontextmanager
    async def lifespan(app):
        settings.validate()
        app.state.db = Database(settings.data_dir / "remote.sqlite3", settings.admin_password)
        app.state.upgrades = Upgrades(settings, app.state.db, hub)
        app.state.builds = Builds(settings, app.state.db)
        logger.info("Controller started; login URL: http://<server>:{}/{}/",
                    os.getenv('HTTP_PORT', '8080'), settings.entrance_code)
        yield
        await app.state.builds.close()
        await app.state.upgrades.close()
        app.state.db.close_connections()
        await hub.close()

    app = FastAPI(title="Rust Remote", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.hub = hub
    prefix = f"/{settings.entrance_code}/api"

    @app.middleware("http")
    async def trace_request(request, call_next):
        supplied = request.headers.get("x-request-id", "")
        trace_id = supplied if re.fullmatch(r"[a-zA-Z0-9-]{8,64}", supplied) else str(uuid4())
        request.state.trace_id = trace_id
        start = time.monotonic()
        with logger.contextualize(trace_id=trace_id):
            try:
                response = await call_next(request)
            except Exception:
                logger.exception("Unhandled request error")
                response = JSONResponse({"detail": "Internal server error", "trace_id": trace_id}, status_code=500)
            logger.info("{} {} status={} duration_ms={:.1f}", request.method, request.url.path, response.status_code, (time.monotonic() - start) * 1000)
        response.headers["X-Request-ID"] = trace_id
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    def authenticated(request: Request):
        token = request.cookies.get("remote_session", "")
        with app.state.db.connect() as db:
            session = db.execute("SELECT * FROM sessions WHERE token=? AND expires>?", (token_hash(token), time.time())).fetchone()
        if not session:
            raise HTTPException(401, "Please log in")
        if request.method not in {"GET", "HEAD"} and not hmac.compare_digest(request.headers.get("x-csrf-token", ""), session["csrf"]):
            raise HTTPException(403, "Invalid CSRF token")
        return session

    @app.get("/healthz")
    def health():
        return {"status": "ok"}

    @app.get(f'/{settings.entrance_code}')
    def console_redirect():
        return RedirectResponse(f'/{settings.entrance_code}/', status_code=302)

    @app.get(f'/{settings.entrance_code}/')
    def console_index():
        return Response(headers={'X-Accel-Redirect': '/_console/index.html'})

    @app.get(f'/{settings.entrance_code}/assets/{{filename}}')
    def console_asset(filename: str):
        if not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9_.-]*', filename):
            raise HTTPException(404)
        return Response(headers={'X-Accel-Redirect': '/_console/assets/' + filename})

    @app.post(prefix + "/login")
    async def login(body: Login, request: Request, response: Response):
        origin = request.headers.get("origin")
        if origin and origin.rstrip("/") != str(request.base_url).rstrip("/"):
            raise HTTPException(403, "Invalid origin")
        now = time.monotonic()
        # Bound password work across IPs.
        for key in list(attempts):
            while attempts[key] and now - attempts[key][0] > 300:
                attempts[key].popleft()
            if not attempts[key]:
                del attempts[key]
        ip = request.client.host if request.client else "unknown"
        keys = ("global", "ip:" + ip)
        if len(attempts[keys[0]]) >= 100 or len(attempts[keys[1]]) >= 5:
            raise HTTPException(429, "Too many login attempts; retry in five minutes", headers={"Retry-After": "300"})
        for key in keys:
            attempts[key].append(now)
        valid = await asyncio.to_thread(app.state.db.verify_password, body.password)
        app.state.db.audit(request.state.trace_id, None, "login", "success" if valid else "denied",
                           '管理员登录成功。' if valid else '登录密码不正确，已拒绝访问。', target='管理控制台', source_ip=ip)
        if not valid:
            raise HTTPException(401, "Incorrect password")
        attempts.pop(keys[1], None)
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        with app.state.db.connect() as db:
            db.execute("DELETE FROM sessions WHERE expires<=? OR token=?", (time.time(), token_hash(request.cookies.get("remote_session", ""))))
            db.execute("INSERT INTO sessions VALUES (?,?,?)", (token_hash(token), csrf, time.time() + settings.session_hours * 3600))
        response.set_cookie("remote_session", token, max_age=settings.session_hours * 3600, httponly=True,
                            secure=settings.cookie_secure, samesite="strict", path=f"/{settings.entrance_code}")
        return {"csrf_token": csrf}

    @app.get(prefix + "/session")
    def session(current=Depends(authenticated)):
        return {"csrf_token": current["csrf"]}

    @app.post(prefix + "/logout")
    def logout(response: Response, request: Request, current=Depends(authenticated)):
        with app.state.db.connect() as db:
            db.execute("DELETE FROM sessions WHERE token=?", (current["token"],))
        response.delete_cookie("remote_session", path=f"/{settings.entrance_code}")
        app.state.db.audit(request.state.trace_id, None, 'logout', 'success', '管理会话已注销。',
                           target='管理控制台', source_ip=request.client.host if request.client else None)
        return {"ok": True}

    @app.get(prefix + "/devices", dependencies=[Depends(authenticated)])
    def devices():
        with app.state.db.connect() as db:
            # Heartbeats update last_seen continuously; keep polling from
            # reshuffling rows, including devices that share the same name.
            rows = db.execute("""SELECT d.*, n.source_ip, n.local_addresses, n.public_ip, n.reported_at,
                s.os, s.distribution_id, s.kernel_version
                FROM devices d LEFT JOIN device_networks n ON n.device_id=d.id
                LEFT JOIN device_systems s ON s.device_id=d.id
                ORDER BY d.name COLLATE NOCASE, d.id""").fetchall()
        result = []
        for row in rows:
            device = dict(row)
            device['local_addresses'] = json.loads(device['local_addresses'] or '[]')
            device['public_ip_source'] = 'ipinfo.io' if device['public_ip'] else None
            if not device['public_ip'] and device['source_ip'] and ipaddress.ip_address(device['source_ip']).is_global:
                device['public_ip'] = device['source_ip']
                device['public_ip_source'] = 'connection'
            device['online'] = device['id'] in hub.connections
            device['capabilities'] = hub.connections[device['id']].metadata.get('capabilities', []) if device['online'] else []
            device['upgrade'] = app.state.upgrades.describe(device)
            result.append(device)
        return result

    @app.get(prefix + '/client-config', dependencies=[Depends(authenticated)])
    async def client_config():
        return {'config': app.state.builds.config(), 'builder': await app.state.builds.availability()}

    @app.get(prefix + '/tunnel-status', dependencies=[Depends(authenticated)])
    async def tunnel_status():
        hostname = os.getenv('TUNNEL_HOSTNAME', '')
        try:
            metrics = await asyncio.to_thread(
                lambda: urllib.request.build_opener(urllib.request.ProxyHandler({})).open(
                    'http://cloudflared:20241/metrics', timeout=2
                ).read().decode()
            )
            match = re.search(r'^cloudflared_tunnel_ha_connections\s+(\d+(?:\.\d+)?)$', metrics, re.MULTILINE)
            connections = int(float(match.group(1))) if match else 0
            return {'status': 'connected' if connections else 'disconnected',
                    'hostname': hostname, 'connections': connections,
                    'protocol': os.getenv('TUNNEL_TRANSPORT_PROTOCOL', 'auto')}
        except (OSError, ValueError, TimeoutError):
            return {'status': 'unavailable', 'hostname': hostname, 'connections': 0,
                    'protocol': os.getenv('TUNNEL_TRANSPORT_PROTOCOL', 'auto')}

    @app.put(prefix + '/client-config', dependencies=[Depends(authenticated)])
    def save_client_config(body: ClientConfig, request: Request):
        config = app.state.builds.save(body)
        app.state.db.audit(request.state.trace_id, None, 'client.config', 'success',
                           '已保存被控端编译连接配置。', target='被控端配置',
                           source_ip=request.client.host if request.client else None)
        return config

    @app.get(prefix + '/client-builds', dependencies=[Depends(authenticated)])
    def client_builds():
        return app.state.builds.list()

    @app.post(prefix + '/client-builds', dependencies=[Depends(authenticated)], status_code=202)
    async def start_client_build(body: BuildRequest, request: Request):
        return await app.state.builds.start(body, request)

    @app.get(prefix + '/client-builds/{job_id}', dependencies=[Depends(authenticated)])
    def client_build(job_id: str):
        return app.state.builds.get(job_id)

    @app.delete(prefix + '/client-builds/{job_id}', dependencies=[Depends(authenticated)])
    async def delete_client_build(job_id: str, request: Request):
        job, ids = app.state.builds.delete(job_id)
        app.state.db.audit(request.state.trace_id, None, 'client.delete', 'success',
                           f'已删除编译记录和产物，共 {len(ids)} 条；关联发布已取消。',
                           target=f"{job['platform']} amd64 · {job['version']}",
                           source_ip=request.client.host if request.client else None)
        return {'ok': True, 'deleted_ids': ids}

    @app.get(prefix + '/client-builds/{job_id}/download', dependencies=[Depends(authenticated)])
    def download_client_build(job_id: str, request: Request):
        binary, job = app.state.builds.download(job_id)
        app.state.db.audit(request.state.trace_id, None, 'client.download', 'success',
                           '下载已编译的被控端。', target=f"{job['platform']} amd64 · {job['version']}",
                           source_ip=request.client.host if request.client else None)
        return FileResponse(binary, media_type='application/octet-stream', filename=job['filename'])

    @app.post(prefix + '/client-builds/{job_id}/publish', dependencies=[Depends(authenticated)])
    async def publish_client_build(job_id: str, request: Request):
        job = app.state.builds.publish(job_id)
        app.state.db.audit(request.state.trace_id, None, 'client.publish', 'success',
                           '已发布为该系统的在线升级版本。', target=f"{job['platform']} amd64 · {job['version']}",
                           source_ip=request.client.host if request.client else None)
        return job

    @app.post(prefix + '/devices/{device_id}/upgrade', dependencies=[Depends(authenticated)], status_code=202)
    async def upgrade(device_id: str, request: Request, body: UpgradeRequest | None = None):
        return await app.state.upgrades.start(device_id, request, reinstall=body.reinstall if body else False)

    @app.delete(prefix + '/devices/{device_id}', dependencies=[Depends(authenticated)])
    def delete_device(device_id: str, request: Request):
        # Deleting an online device would allow a live client to immediately
        # recreate the record and could discard state during an operation.
        if device_id in hub.connections:
            raise HTTPException(409, '在线设备不能删除，请先等待设备离线。')
        if device_id in app.state.upgrades.tasks:
            raise HTTPException(409, '设备正在升级，请等待升级完成。')
        device = app.state.db.delete_device(device_id)
        if not device:
            raise HTTPException(404, '设备不存在')
        app.state.db.audit(request.state.trace_id, device_id, 'device.delete', 'success',
                           '已删除离线设备及其主控缓存。', target=device['name'],
                           source_ip=request.client.host if request.client else None)
        return {'ok': True}

    @app.get(prefix + "/audit", dependencies=[Depends(authenticated)])
    def audit():
        with app.state.db.connect() as db:
            return [dict(row) for row in db.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 200")]

    @app.get(prefix + '/audit/records', dependencies=[Depends(authenticated)])
    def audit_records(page: int = Query(default=1, ge=1), page_size: int = Query(default=20, ge=1, le=100),
                      status: str = Query(default='', pattern='^(|success|failed|timeout|denied|started|interrupted)$'),
                      category: str = Query(default='', pattern='^(|auth|files|shell|system)$'),
                      search: str = Query(default='', max_length=128)):
        conditions = ["""NOT (a.status IN ('started','interrupted') AND EXISTS (
            SELECT 1 FROM audit done WHERE done.trace_id=a.trace_id AND done.action=a.action
            AND done.device_id IS a.device_id AND done.id>a.id AND done.time<=a.time+120
            AND done.status NOT IN ('started','interrupted')))"""]
        values = []
        if status:
            conditions.append('a.status=?')
            values.append(status)
        if category:
            conditions.append({'auth': "a.action IN ('login','logout')", 'files': "a.action LIKE 'fs.%'",
                               'shell': "a.action IN ('shell.exec','terminal.session')", 'system': "a.action IN ('system.info','system.environment','screen.capture','screen.observe','screen.input','ports.list','process.list','process.kill','agent.update','agent.reinstall','client.build','client.config','client.download','client.publish','client.delete','device.delete')"}[category])
        if search:
            conditions.append("(COALESCE(d.name,'') || ' ' || COALESCE(a.device_id,'') || ' ' || a.target || ' ' || a.trace_id || ' ' || a.detail) LIKE ?")
            values.append('%' + search + '%')
        where = ' AND '.join(conditions)
        with app.state.db.connect() as db:
            counts = db.execute(f"""SELECT COUNT(*) AS total,
                COALESCE(SUM(a.status='success'),0) AS success,
                COALESCE(SUM(a.status IN ('failed','timeout','denied','interrupted')),0) AS errors,
                COALESCE(SUM(a.status='started'),0) AS pending
                FROM audit a LEFT JOIN devices d ON d.id=a.device_id WHERE {where}""", values).fetchone()
            rows = db.execute(f"""SELECT a.*, d.name AS device_name FROM audit a
                LEFT JOIN devices d ON d.id=a.device_id WHERE {where}
                ORDER BY a.id DESC LIMIT ? OFFSET ?""", [*values, page_size, (page-1)*page_size]).fetchall()
        return {'items': [describe_record(row) for row in rows], 'summary': dict(counts)}

    def connection_history(device_id, before):
        with app.state.db.connect() as db:
            if device_id is not None and not db.execute("SELECT 1 FROM devices WHERE id=?", (device_id,)).fetchone():
                raise HTTPException(404, "Device not found")
            rows = db.execute("""SELECT c.*, d.name AS device_name, d.platform AS device_platform
                FROM device_connections c JOIN devices d ON d.id=c.device_id
                WHERE (? IS NULL OR c.device_id=?) AND (? IS NULL OR c.id<?)
                ORDER BY c.id DESC LIMIT 51""", (device_id, device_id, before, before)).fetchall()
        return {"items": [dict(row) for row in rows[:50]], "next_before": rows[49]["id"] if len(rows) > 50 else None}

    @app.get(prefix + "/connections", dependencies=[Depends(authenticated)])
    def all_connections(before: int | None = Query(default=None, ge=1)):
        return connection_history(None, before)

    @app.get(prefix + "/devices/{device_id}/connections", dependencies=[Depends(authenticated)])
    def connections(device_id: str, before: int | None = Query(default=None, ge=1)):
        return connection_history(device_id, before)

    async def dispatch(device_id, action, params, request):
        trace_id = request.state.trace_id
        started = time.monotonic()
        audit_id = app.state.db.audit(trace_id, device_id, action, "started", '请求已发出，等待设备响应。',
                                     target=operation_target(action, params), source_ip=request.client.host if request.client else None)
        def finish(status, detail):
            app.state.db.finish_audit(audit_id, status, detail, (time.monotonic()-started)*1000)
        logger.bind(trace_id=trace_id, device_id=device_id, action=action).info("Dispatch device operation")
        try:
            result = await hub.request(device_id, action, params, trace_id, settings.command_timeout)
        except DeviceUnavailable as exc:
            finish('failed', f'设备离线或连接已断开，未能完成操作。{exc}')
            raise HTTPException(409, str(exc)) from exc
        except TimeoutError as exc:
            finish('timeout', '等待设备响应超时；操作可能已经执行，请核实设备状态后再决定是否重试。')
            raise HTTPException(504, "Device response timed out; operation may still have executed") from exc
        except RemoteError as exc:
            finish('failed', f'设备执行失败：{exc}')
            raise HTTPException(502, str(exc)) from exc
        except asyncio.CancelledError:
            finish('interrupted', '请求处理被中断，无法确认设备上的最终执行结果。')
            raise
        except Exception:
            finish('failed', '主控处理请求时发生异常，请通过请求编号排查。')
            raise
        if action == 'fs.read':
            try:
                if len(base64.b64decode(result['data'], validate=True)) > settings.max_file_bytes:
                    raise ValueError('File too large')
            except (KeyError, TypeError, ValueError, binascii.Error) as exc:
                finish('failed', '设备返回的文件数据无效，下载失败。')
                raise HTTPException(502, 'Invalid file response') from exc
        finish(*operation_result(action, result))
        if action == 'system.info':
            app.state.db.update_networks(device_id, result)
            app.state.db.update_system(device_id, result)
        return result

    @app.post(prefix + "/devices/{device_id}/command", dependencies=[Depends(authenticated)])
    async def command(device_id: str, body: Command, request: Request):
        validate_command(body)
        required_capability = {'process.kill': 'process-kill-v1', 'screen.input': 'screen-input-v1'}.get(body.action)
        connection = hub.connections.get(device_id)
        if required_capability and connection and required_capability not in connection.metadata.get('capabilities', []):
            raise HTTPException(409, '请先升级被控端，以使用此功能。')
        return {"result": await dispatch(device_id, body.action, body.params, request), "trace_id": request.state.trace_id}

    @app.websocket(prefix + '/devices/{device_id}/terminal')
    async def terminal(socket: WebSocket, device_id: str):
        await terminal_socket(socket, device_id, app.state.db, hub)

    @app.websocket(prefix + '/devices/{device_id}/screen')
    async def screen(socket: WebSocket, device_id: str):
        await observe_screen(socket, device_id, app.state.db, hub, settings, screen_sessions)

    @app.post(prefix + "/devices/{device_id}/upload", dependencies=[Depends(authenticated)])
    async def upload(device_id: str, path: str, file: UploadFile, request: Request):
        if not path or len(path) > 8192 or "\x00" in path:
            raise HTTPException(400, "Invalid destination path")
        data = await file.read(settings.max_file_bytes + 1)
        if len(data) > settings.max_file_bytes:
            raise HTTPException(413, "File exceeds the 8 MiB limit")
        result = await dispatch(device_id, "fs.write", {"path": path, "data": base64.b64encode(data).decode()}, request)
        return {"result": result}

    @app.get(prefix + "/devices/{device_id}/download", dependencies=[Depends(authenticated)])
    async def download(device_id: str, path: str, request: Request):
        if not path or len(path) > 8192 or "\x00" in path:
            raise HTTPException(400, "Invalid source path")
        result = await dispatch(device_id, "fs.read", {"path": path}, request)
        try:
            data = base64.b64decode(result["data"], validate=True)
            if len(data) > settings.max_file_bytes:
                raise ValueError("File too large")
        except (KeyError, TypeError, ValueError, binascii.Error) as exc:
            raise HTTPException(502, "Invalid file response") from exc
        return Response(data, media_type="application/octet-stream", headers={"Content-Disposition": "attachment"})

    @app.websocket("/agent/ws")
    async def agent(socket: WebSocket):
        if not hmac.compare_digest(socket.headers.get("authorization", ""), "Bearer " + settings.agent_token):
            await socket.close(code=1008)
            return
        await socket.accept()
        connection = None
        device_id = None
        connection_id = None
        disconnect_reason = "disconnected"
        try:
            hello = await asyncio.wait_for(socket.receive_json(), timeout=10)
            if hello.get("type") != "hello":
                raise ValueError("Expected hello")
            info = {key: hello[key] for key in ("id", "name", "platform", "arch", "version")}
            if any(not isinstance(value, str) or not 1 <= len(value) <= 128 for value in info.values()):
                raise ValueError("Invalid device metadata")
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", info["id"]):
                raise ValueError("Invalid device ID")
            device_id = info["id"]
            app.state.db.upsert_device(info, socket.client.host if socket.client else None)
            app.state.db.update_system(device_id, hello)
            connection_id = app.state.db.start_connection(device_id)
            connection = await hub.attach(device_id, socket)
            connection.metadata = {
                **info, 'capabilities': hello.get('capabilities') if isinstance(hello.get('capabilities'), list) else [],
                'binary_sha256': hello.get('binary_sha256') if isinstance(hello.get('binary_sha256'), str)
                and re.fullmatch('[a-f0-9]{64}', hello['binary_sha256']) else None,
            }
            logger.bind(device_id=device_id).info("Device connected")
            await socket.send_json({"type": "welcome", "heartbeat_seconds": 20})
            terminal_touched_at = 0.0
            while True:
                message = await asyncio.wait_for(socket.receive_json(), timeout=65)
                if not isinstance(message, dict):
                    raise ValueError("Expected object")
                # Streaming PTY output must not commit SQLite on every chunk.
                if message.get('type') != 'terminal' or time.monotonic() - terminal_touched_at >= 5:
                    app.state.db.touch_connection(connection_id)
                    terminal_touched_at = time.monotonic()
                if message.get("type") == "response":
                    hub.resolve(connection, message)
                elif message.get("type") == "terminal":
                    hub.terminal_receive(connection, message)
                elif message.get("type") == "heartbeat":
                    async with connection.send_lock:
                        await socket.send_json({"type": "heartbeat_ack"})
        except TimeoutError:
            disconnect_reason = "heartbeat_timeout"
            logger.bind(device_id=device_id).info("Device heartbeat expired")
        except WebSocketDisconnect as exc:
            if exc.code == 1012:
                disconnect_reason = "controller_shutdown"
            logger.bind(device_id=device_id).info("Device disconnected")
        except (ValueError, KeyError, TypeError, AttributeError):
            disconnect_reason = "invalid_message"
            logger.bind(device_id=device_id).warning("Invalid agent message")
            await socket.close(code=1008)
        finally:
            if connection:
                hub.detach(device_id, connection)
            if connection_id is not None:
                app.state.db.end_connection(connection_id, disconnect_reason)
            try:
                await socket.close()
            except (RuntimeError, WebSocketDisconnect):
                pass

    return app
