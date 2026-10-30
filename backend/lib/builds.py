"""Authenticated, persistent Docker builds of clients with embedded connection settings."""
import asyncio
import hashlib
import json
import os
import re
import shutil
import signal
import time
import tomllib
from tempfile import NamedTemporaryFile
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import HTTPException
from loguru import logger
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .upgrades import version

ACTIVE = ('queued', 'running')
MAX_LOG = 64 * 1024
MAX_BINARY = 128 * 1024 * 1024
STAGES = ('preparing', 'compiling', 'testing', 'exporting', 'complete')
BUILD_SELECT = """SELECT *, id = COALESCE(
    (SELECT value FROM settings WHERE key='client_release_' || platform || '_' || arch),
    (SELECT value FROM settings WHERE key='client_release_' || platform), '') AS published FROM client_builds"""


class ClientConfig(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    server: str = Field(min_length=1, max_length=2048)
    allow_insecure: bool = False

    @model_validator(mode='after')
    def validate_connection(self):
        try:
            url = urlsplit(self.server)
            valid = (url.scheme in ('ws', 'wss') and url.hostname and url.port != 0
                     and not url.username and not url.password and url.path == '/agent/ws'
                     and not url.query and not url.fragment
                     and not re.search(r'[\s\x00-\x1f\x7f\\]', self.server))
        except ValueError:
            valid = False
        if not valid:
            raise ValueError('连接地址必须为 ws://或 wss://主机[:端口]/agent/ws，不能含凭据、查询参数或空格')
        if url.scheme == 'ws' and not self.allow_insecure:
            raise ValueError('使用 ws:// 时必须开启“允许内网明文连接”')
        return self


class BuildRequest(ClientConfig):
    platform: Literal['linux', 'windows']
    arch: Literal['x86_64', 'aarch64'] = 'x86_64'


class Builds:
    def __init__(self, settings, db):
        self.settings, self.db = settings, db
        self.root = settings.data_dir / 'client-builds'
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.tasks = set()
        self.lock = asyncio.Lock()
        with db.connect() as connection:
            connection.execute('''CREATE TABLE IF NOT EXISTS client_builds (
                id TEXT PRIMARY KEY, platform TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'x86_64', version TEXT NOT NULL,
                server TEXT NOT NULL, allow_insecure INTEGER NOT NULL,
                status TEXT NOT NULL, stage TEXT NOT NULL, detail TEXT NOT NULL,
                log TEXT NOT NULL DEFAULT '', size INTEGER, sha256 TEXT,
                created_at REAL NOT NULL, updated_at REAL NOT NULL
            )''')
            columns = {row['name'] for row in connection.execute('PRAGMA table_info(client_builds)')}
            if 'arch' not in columns:
                connection.execute("ALTER TABLE client_builds ADD COLUMN arch TEXT NOT NULL DEFAULT 'x86_64'")
            for platform in ('linux', 'windows'):
                connection.execute("UPDATE settings SET key=? WHERE key=? AND NOT EXISTS (SELECT 1 FROM settings WHERE key=?)",
                                   (f'client_release_{platform}_x86_64', f'client_release_{platform}', f'client_release_{platform}_x86_64'))
            connection.execute("""UPDATE client_builds SET status='interrupted',
                detail='主控已重启，编译中断，请重新编译。', updated_at=?
                WHERE status IN ('queued','running')""", (time.time(),))
        self.prune_history()

    def config(self):
        with self.db.connect() as connection:
            row = connection.execute("SELECT value FROM settings WHERE key='client_config'").fetchone()
        return json.loads(row['value']) if row else None

    def save(self, config):
        # The controller's token is supplied at build time and never returned to the browser.
        value = {'server': config.server, 'allow_insecure': config.allow_insecure}
        with self.db.connect() as connection:
            connection.execute("INSERT OR REPLACE INTO settings VALUES ('client_config', ?)", (json.dumps(value),))
        return value

    def version(self):
        return tomllib.loads((self.settings.client_source_dir / 'Cargo.toml').read_text())['package']['version']

    async def availability(self):
        if not shutil.which('docker'):
            return {'available': False, 'reason': '后端缺少 Docker CLI，请使用更新后的 Compose 配置重建服务。'}
        if not all((self.settings.client_source_dir / name).exists()
                   for name in ('Cargo.toml', 'Cargo.lock', 'src', 'Dockerfile', 'Dockerfile.windows')):
            return {'available': False, 'reason': '后端缺少被控端源码，请检查 CLIENT_SOURCE_DIR 或重建后端镜像。'}
        try:
            for args in (('version', '--format', '{{.Server.Version}}'), ('buildx', 'version')):
                process = await asyncio.create_subprocess_exec(
                    'docker', *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                if process.returncode:
                    return {'available': False, 'reason': 'Docker / Buildx 不可用，请检查 Docker 服务、socket 挂载及 DOCKER_GID 权限。'}
        except (OSError, TimeoutError):
            return {'available': False, 'reason': '无法连接 Docker，请检查 Docker 服务和 socket 权限。'}
        return {'available': True, 'reason': ''}

    @staticmethod
    def describe(row, logs=False):
        job = dict(row)
        job.pop('duplicate_rank', None)
        job['allow_insecure'] = bool(job['allow_insecure'])
        job['published'] = bool(job.get('published', False))
        job['arch'] = job.get('arch') or 'x86_64'
        job['filename'] = 'rust-remote-client.exe' if job['platform'] == 'windows' else 'rust-remote-client'
        if not logs:
            job.pop('log', None)
        return job

    def list(self):
        with self.db.connect() as connection:
            # Keep the published entry visible when identical binaries were built
            # more than once. Unfinished and failed tasks have no usable digest.
            rows = connection.execute('''WITH builds AS (''' + BUILD_SELECT + '''), ranked AS (
                SELECT *, ROW_NUMBER() OVER (
                    PARTITION BY platform, arch, CASE WHEN status='success' AND sha256 IS NOT NULL
                        THEN sha256 ELSE id END
                    ORDER BY published DESC, created_at DESC, id DESC
                ) AS duplicate_rank FROM builds
            ) SELECT * FROM ranked WHERE duplicate_rank=1
                ORDER BY created_at DESC, id DESC LIMIT 30''')
            return [self.describe(row) for row in rows]

    def get(self, job_id):
        with self.db.connect() as connection:
            row = connection.execute(BUILD_SELECT + ' WHERE id=?', (job_id,)).fetchone()
        if not row:
            raise HTTPException(404, '编译任务不存在')
        return self.describe(row, logs=True)

    def update(self, job_id, **fields):
        fields['updated_at'] = time.time()
        with self.db.connect() as connection:
            connection.execute('UPDATE client_builds SET ' + ','.join(f'{key}=?' for key in fields) + ' WHERE id=?',
                               [*fields.values(), job_id])

    def _job_arch(self, job_id):
        with self.db.connect() as connection:
            row = connection.execute('SELECT arch FROM client_builds WHERE id=?', (job_id,)).fetchone()
        return (row['arch'] if row else None) or 'x86_64'

    def prune_older_builds(self, platform, keep_id):
        """Keep the newest successful bundle for a platform and remove older records."""
        with self.db.connect() as connection:
            rows = connection.execute(
                'SELECT id FROM client_builds WHERE platform=? AND arch=? AND id<>?',
                (platform, self._job_arch(keep_id), keep_id)
            ).fetchall()
            ids = [row['id'] for row in rows]
            for job_id in ids:
                connection.execute('DELETE FROM settings WHERE value=?', (job_id,))
                connection.execute('DELETE FROM client_builds WHERE id=?', (job_id,))
        root = self.root.resolve()
        for job_id in ids:
            directory = self.root / job_id
            try:
                if directory.is_symlink() or directory.resolve().parent != root:
                    raise OSError('编译产物目录无效')
                if directory.exists():
                    shutil.rmtree(directory)
            except OSError as exc:
                logger.warning('Unable to remove old client build {}: {}', job_id, exc)
        return ids

    def prune_history(self):
        for platform in ('linux', 'windows'):
            for arch in ('x86_64', 'aarch64'):
                with self.db.connect() as connection:
                    row = connection.execute(
                        '''SELECT id FROM client_builds WHERE platform=? AND arch=? AND status='success'
                           ORDER BY created_at DESC, id DESC LIMIT 1''', (platform, arch)
                    ).fetchone()
                if row:
                    self.prune_older_builds(platform, row['id'])

    def delete(self, job_id):
        job = self.get(job_id)
        if job['status'] in ACTIVE:
            raise HTTPException(409, '编译任务正在运行，请等待结束后再删除。')
        with self.db.connect() as connection:
            connection.execute('BEGIN IMMEDIATE')
            # History merges identical binaries; deleting the visible entry must
            # also remove its hidden copies, rather than make one reappear.
            if job['status'] == 'success' and job['sha256']:
                rows = connection.execute('''SELECT id FROM client_builds
                    WHERE platform=? AND arch=? AND status='success' AND sha256=?''',
                    (job['platform'], job['arch'], job['sha256'])).fetchall()
                ids = [row['id'] for row in rows]
            else:
                ids = [job['id']]
            for item in ids:
                directory = self.root / item
                if directory.is_symlink() or directory.resolve().parent != self.root.resolve():
                    raise HTTPException(409, '编译产物目录无效，无法删除。')
                try:
                    if directory.exists():
                        shutil.rmtree(directory)
                except OSError as exc:
                    raise HTTPException(409, '无法删除编译产物，请检查目录权限后重试。') from exc
            for item in ids:
                connection.execute("DELETE FROM settings WHERE key LIKE 'client_release_%' AND value=?", (item,))
                connection.execute('DELETE FROM client_builds WHERE id=?', (item,))
        return job, ids

    async def start(self, body, request):
        async with self.lock:
            with self.db.connect() as connection:
                active = connection.execute("SELECT 1 FROM client_builds WHERE status IN ('queued','running')").fetchone()
            if active:
                raise HTTPException(409, '已有编译任务正在运行，请等待完成后重试。')
            available = await self.availability()
            if not available['available']:
                raise HTTPException(503, available['reason'])
            job_id, now = str(uuid4()), time.time()
            with self.db.connect() as connection:
                connection.execute('''INSERT INTO client_builds
                    (id,platform,arch,version,server,allow_insecure,status,stage,detail,created_at,updated_at)
                    VALUES (?,?,?,?,?,?,'queued','preparing','正在准备 Docker 编译环境。',?,?)''',
                    (job_id, body.platform, body.arch, self.version(), body.server, body.allow_insecure, now, now))
            self.save(body)
            audit_id = self.db.audit(request.state.trace_id, None, 'client.build', 'started',
                                     '开始编译被控端。', target=f'{body.platform} {body.arch}',
                                     source_ip=request.client.host if request.client else None)
            task = asyncio.create_task(self.run(job_id, audit_id, request.state.trace_id))
            self.tasks.add(task)
            task.add_done_callback(self.tasks.discard)
            return self.get(job_id)

    def command(self, job, directory):
        source = self.settings.client_source_dir.resolve()
        command = ['docker', 'buildx', 'build', '--platform', 'linux/amd64', '--progress', 'plain',
                   '--file', str(source / ('Dockerfile.windows' if job['platform'] == 'windows' else 'Dockerfile')),
                   '--secret', 'id=client_server,env=REMOTE_DEFAULT_SERVER',
                   '--secret', 'id=client_token,env=REMOTE_DEFAULT_TOKEN',
                   '--build-arg', 'REMOTE_DEFAULT_ALLOW_INSECURE=' + str(job['allow_insecure']).lower(),
                   '--build-arg', 'TARGET_ARCH=' + job['arch'],
                   '--build-arg', 'CLIENT_CONFIG_HASH=' + hashlib.sha256(
                       (job['server'] + '\0' + self.settings.agent_token).encode()).hexdigest()]
        for name in ('RUST_IMAGE', 'APT_MIRROR', 'CARGO_MIRROR', 'RUSTUP_MIRROR',
                     'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'):
            if os.getenv(name):
                command.extend(['--build-arg', f'{name}={os.environ[name]}'])
        command.extend(['--output', f'type=local,dest={directory}', str(source)])
        return command

    async def stop_process(self, process):
        if process and process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await process.wait()

    async def run(self, job_id, audit_id, trace_id):
        started, process = time.monotonic(), None
        log, stage = '', 'preparing'
        try:
            job = self.get(job_id)
            directory = self.root / job_id
            directory.mkdir(mode=0o700)
            self.update(job_id, status='running')
            env = dict(os.environ, REMOTE_DEFAULT_SERVER=job['server'], REMOTE_DEFAULT_TOKEN=self.settings.agent_token)
            with logger.contextualize(trace_id=trace_id, build_id=job_id):
                logger.info('Client Docker build started platform={}', job['platform'])
                process = await asyncio.create_subprocess_exec(
                    *self.command(job, directory.resolve()), env=env,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                    start_new_session=True, limit=1024 * 1024)
                async with asyncio.timeout(3600):
                    while line := await process.stdout.readline():
                        text = line.decode('utf-8', errors='replace').replace(self.settings.agent_token, '[REDACTED]')
                        text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
                        log = (log + text[:8192])[-MAX_LOG:]
                        candidate = stage
                        if re.search(r'cargo (?:xwin )?build|Compiling ', text):
                            candidate = 'compiling'
                        if re.search(r'running \d+ tests|test result:', text):
                            candidate = 'testing'
                        if re.search(r'exporting to client|copying files|sending tarball', text):
                            candidate = 'exporting'
                        if STAGES.index(candidate) > STAGES.index(stage):
                            stage = candidate
                        self.update(job_id, log=log, stage=stage, detail='Docker 正在编译，具体进度见日志。')
                    code = await process.wait()
                if code:
                    raise RuntimeError(f'Docker 编译失败（退出码 {code}），请查看编译日志。')
                self.update(job_id, stage='exporting', detail='正在校验编译产物。')
                binary = directory / job['filename']
                if not binary.is_file() or binary.is_symlink() or not 0 < binary.stat().st_size <= MAX_BINARY:
                    raise RuntimeError('编译产物缺失或大小无效。')
                data = await asyncio.to_thread(binary.read_bytes)
                if not 0 < len(data) <= MAX_BINARY:
                    raise RuntimeError('编译产物缺失或大小无效。')
                version(job['version'])
                digest = hashlib.sha256(data).hexdigest()
                manifest = dict(version=job['version'], platform=job['platform'], arch=job['arch'],
                                update_protocol=1, size=len(data), sha256=digest)
                (directory / 'release.json').write_text(json.dumps(manifest, indent=2) + '\n')
                binary.chmod(0o600)
                # A successful job and its platform's release pointer become
                # visible together. A publication failure rolls both back and
                # leaves the previous release available to devices.
                detail = '编译完成，已自动发布为该系统的最新版本，可以下载或前往设备列表升级。'
                with self.db.connect() as connection:
                    connection.execute('''UPDATE client_builds SET status='success', stage='complete',
                        size=?, sha256=?, detail=?, updated_at=? WHERE id=?''',
                        (len(data), digest, detail, time.time(), job_id))
                    connection.execute('INSERT OR REPLACE INTO settings VALUES (?, ?)',
                                       ('client_release_' + job['platform'] + '_' + job['arch'], job_id))
                    connection.execute('UPDATE audit SET status=?, detail=?, duration_ms=? WHERE id=?',
                                       ('success', detail, round((time.monotonic()-started)*1000, 1), audit_id))
                    connection.execute('''INSERT INTO audit(time,trace_id,device_id,action,status,detail,target,source_ip)
                        SELECT ?,trace_id,NULL,'client.publish','success',?,?,source_ip FROM audit WHERE id=?''',
                        (time.time(), '编译成功，已自动发布为该系统的最新版本。',
                         f"{job['platform']} {job['arch']} · {job['version']}", audit_id))
                self.prune_older_builds(job['platform'], job_id)
                logger.bind(trace_id=trace_id, build_id=job_id).info('Client Docker build completed and published')
        except asyncio.CancelledError:
            await self.stop_process(process)
            self.update(job_id, status='interrupted', detail='主控停止，编译中断，请重新编译。')
            self.db.finish_audit(audit_id, 'interrupted', '主控停止，编译中断。', (time.monotonic()-started)*1000)
            raise
        except Exception as exc:
            await self.stop_process(process)
            detail = '编译超过一小时，已停止，请检查日志后重试。' if isinstance(exc, TimeoutError) else str(exc)
            detail = detail.replace(self.settings.agent_token, '[REDACTED]')[:1000]
            self.update(job_id, status='failed', detail=detail)
            self.db.finish_audit(audit_id, 'failed', detail, (time.monotonic()-started)*1000)
            logger.bind(trace_id=trace_id, build_id=job_id).warning('Client Docker build failed: {}', detail)

    def download(self, job_id):
        job = self.get(job_id)
        if job['status'] != 'success':
            raise HTTPException(409, '该任务尚未成功完成，不能下载。')
        # The ID comes from the database, never from a user-supplied filesystem path.
        binary = self.root / job['id'] / job['filename']
        if not binary.is_file() or binary.is_symlink():
            raise HTTPException(410, '编译产物已被移除，请重新编译。')
        if binary.stat().st_size != job['size'] or hashlib.sha256(binary.read_bytes()).hexdigest() != job['sha256']:
            raise HTTPException(409, '编译产物校验失败，请重新编译。')
        return binary, job

    async def close(self):
        for task in list(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)

    def publish(self, job_id):
        binary, job = self.download(job_id)
        # Recreate the manifest from verified build metadata. The release pointer
        # switches atomically; in-flight upgrades keep their original bundle.
        try:
            version(job['version'])
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        manifest = dict(version=job['version'], platform=job['platform'], arch=job['arch'],
                        update_protocol=1, size=job['size'], sha256=job['sha256'])
        path = binary.parent / 'release.json'
        with NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
            file.write(json.dumps(manifest, indent=2) + '\n')
        Path(file.name).replace(path)
        with self.db.connect() as connection:
            connection.execute('INSERT OR REPLACE INTO settings VALUES (?, ?)',
                               ('client_release_' + job['platform'] + '_' + job['arch'], job['id']))
        return self.get(job_id)
