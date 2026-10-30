"""Controller-owned release bundles and durable per-device upgrade jobs."""
import asyncio
import base64
import hashlib
import json
import re
import time
from uuid import uuid4

from fastapi import HTTPException
from loguru import logger

from .hub import DeviceUnavailable, RemoteError

MAX_RELEASE = 128 * 1024 * 1024
CHUNK_SIZE = 256 * 1024


def version(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)', value):
        raise ValueError('版本号须为 major.minor.patch')
    return tuple(map(int, value.split('.')))


class Upgrades:
    def __init__(self, settings, database, hub):
        self.settings, self.db, self.hub = settings, database, hub
        self.tasks = {}
        with self.db.connect() as db:
            db.execute('''CREATE TABLE IF NOT EXISTS device_upgrades (
                id TEXT PRIMARY KEY, device_id TEXT NOT NULL, target_version TEXT NOT NULL,
                status TEXT NOT NULL, progress INTEGER NOT NULL, detail TEXT NOT NULL,
                created_at REAL NOT NULL, updated_at REAL NOT NULL, audit_id INTEGER NOT NULL)''')
            db.execute('CREATE INDEX IF NOT EXISTS upgrade_device ON device_upgrades(device_id, created_at DESC)')
            db.execute("""UPDATE device_upgrades SET status='interrupted', detail='主控已重启，请核实设备版本后重试。',
                updated_at=? WHERE status IN ('transferring','restarting')""", (time.time(),))

    def release(self, device, read=False):
        platform = device['platform']
        arch = 'x86_64' if device['arch'] == 'amd64' else device['arch']
        if platform not in ('linux', 'windows') or arch not in ('x86_64', 'aarch64'):
            raise ValueError('当前系统或架构没有升级包')
        with self.db.connect() as db:
            published = db.execute('''SELECT b.id FROM client_builds b
                JOIN settings s ON s.value=b.id
                WHERE s.key=? AND b.platform=? AND b.arch=? AND b.status='success' ''',
                ('client_release_' + platform + '_' + arch, platform, arch)).fetchone()
            if not published and arch == 'x86_64':
                published = db.execute('''SELECT b.id FROM client_builds b
                    JOIN settings s ON s.value=b.id
                    WHERE s.key=? AND b.platform=? AND b.status='success' ''',
                    ('client_release_' + platform, platform)).fetchone()
        if published:
            directory = self.settings.data_dir / 'client-builds' / published['id']
        else:
            directory = self.settings.releases_dir / f'{platform}-{arch}'
            if arch == 'x86_64' and not directory.exists():
                directory = self.settings.releases_dir / f'{platform}-amd64'
        manifest = json.loads((directory / 'release.json').read_text())
        version(manifest['version'])
        if manifest['platform'] != platform or manifest['arch'] != arch or manifest.get('update_protocol') != 1:
            raise ValueError('升级包平台、架构或协议不匹配')
        if type(manifest['size']) is not int or not 0 < manifest['size'] <= MAX_RELEASE:
            raise ValueError('升级包大小无效')
        if not re.fullmatch('[a-f0-9]{64}', manifest['sha256']):
            raise ValueError('升级包校验信息无效')
        executable = directory / ('rust-remote-client.exe' if platform == 'windows' else 'rust-remote-client')
        if executable.stat().st_size != manifest['size']:
            raise ValueError('升级包大小与清单不符，请重新构建')
        data = None
        if read:
            with executable.open('rb') as stream:
                data = stream.read(MAX_RELEASE + 1)
            if len(data) != manifest['size'] or hashlib.sha256(data).hexdigest() != manifest['sha256']:
                raise ValueError('升级包 SHA-256 校验失败，请重新构建')
        return manifest, data

    def latest(self, device_id):
        with self.db.connect() as db:
            row = db.execute('SELECT * FROM device_upgrades WHERE device_id=? ORDER BY created_at DESC LIMIT 1', (device_id,)).fetchone()
        if row:
            return {k: row[k] for k in ('id', 'target_version', 'status', 'progress', 'detail', 'updated_at')}
        return None

    def describe(self, device):
        result = {'available': False, 'reinstall_available': False, 'reinstall_reason': '',
                  'target_version': None, 'reason': '', 'job': self.latest(device['id'])}
        try:
            manifest, _ = self.release(device)
            result['target_version'] = manifest['version']
            current, target = version(device['version']), version(manifest['version'])
            if current == target:
                if not device['online']:
                    result['reinstall_reason'] = '设备上线后可重新下发'
                elif 'self-reinstall-v1' not in self.hub.connections[device['id']].metadata.get('capabilities', []):
                    result['reinstall_reason'] = '此被控端暂不支持同版本重新下发，请先升级至支持此功能的版本'
                elif 'self-update-v1' not in self.hub.connections[device['id']].metadata.get('capabilities', []):
                    result['reinstall_reason'] = '此运行模式不支持在线下发，请手动替换程序'
                elif device['id'] in self.tasks:
                    result['reinstall_reason'] = '程序正在下发，请等待完成'
                else:
                    result['reinstall_available'] = True
            if current >= target:
                result['reason'] = '已是控制端携带版本' if current == target else '设备版本高于控制端携带版本，无需降级'
            elif not device['online']:
                result['reason'] = '发现新版本，设备上线后可升级'
            elif 'self-update-v1' not in self.hub.connections[device['id']].metadata.get('capabilities', []):
                result['reason'] = '此客户端不支持在线升级，请手动替换一次新版程序并保留身份文件'
            elif device['id'] in self.tasks:
                result['reason'] = '升级正在进行'
            else:
                result.update(available=True, reason='发现可升级版本')
        except FileNotFoundError:
            result['reason'] = '尚未发布此系统的升级版本，请在被控端配置中编译并发布'
        except (OSError, ValueError, KeyError, TypeError) as exc:
            result['reason'] = f'升级包或版本信息无效：{exc}'
        return result

    def set_job(self, job_id, status, progress, detail):
        with self.db.connect() as db:
            db.execute('UPDATE device_upgrades SET status=?, progress=?, detail=?, updated_at=? WHERE id=?',
                       (status, progress, detail, time.time(), job_id))

    async def start(self, device_id, request, reinstall=False):
        with self.db.connect() as db:
            row = db.execute('SELECT * FROM devices WHERE id=?', (device_id,)).fetchone()
        if not row:
            raise HTTPException(404, '设备不存在')
        device = dict(row, online=device_id in self.hub.connections)
        description = self.describe(device)
        if reinstall:
            if not description['reinstall_available']:
                raise HTTPException(409, description['reinstall_reason'] or description['reason'])
        elif not description['available']:
            raise HTTPException(409, description['reason'])
        # No awaits until the task is registered: concurrent clicks cannot start two jobs.
        try:
            manifest, data = self.release(device, read=True)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise HTTPException(409, f'无法读取升级包：{exc}') from exc
        job_id, now = str(uuid4()), time.time()
        trace_id = request.state.trace_id
        audit_id = self.db.audit(trace_id, device_id, 'agent.reinstall' if reinstall else 'agent.update', 'started',
                                 '正在重新下发被控端。' if reinstall else '正在传输升级包。',
                                 target=f"{device['version']} → {manifest['version']}",
                                 source_ip=request.client.host if request.client else None)
        with self.db.connect() as db:
            db.execute('INSERT INTO device_upgrades VALUES (?,?,?,?,?,?,?,?,?)',
                       (job_id, device_id, manifest['version'], 'transferring', 0, '正在传输升级包。', now, now, audit_id))
        connection = self.hub.connections[device_id]
        if reinstall:
            manifest = dict(manifest, reinstall=True)
        self.tasks[device_id] = asyncio.create_task(self.run(device_id, job_id, manifest, data, connection, trace_id, audit_id))
        return self.latest(device_id)

    async def run(self, device_id, job_id, manifest, data, connection, trace_id, audit_id):
        started = time.monotonic()
        progress, committed = 0, False
        async def send(action, params):
            if self.hub.connections.get(device_id) is not connection:
                raise DeviceUnavailable('升级传输期间设备连接已变更')
            return await self.hub.request(device_id, action, {'id': job_id, **params}, trace_id, self.settings.command_timeout)
        try:
            async with asyncio.timeout(600):
                await send('agent.update.begin', manifest)
                for offset in range(0, len(data), CHUNK_SIZE):
                    chunk = data[offset:offset + CHUNK_SIZE]
                    await send('agent.update.chunk', {'offset': offset, 'data': base64.b64encode(chunk).decode()})
                    progress = (offset + len(chunk)) * 100 // len(data)
                    self.set_job(job_id, 'transferring', progress, '正在传输并校验升级包。')
                self.set_job(job_id, 'restarting', 100, '等待新版本重启并重新连接；失败时被控端将尝试回滚。')
                committed = True
                try:
                    await send('agent.update.commit', {})
                except RemoteError:
                    committed = False
                    raise
                except (DeviceUnavailable, TimeoutError):
                    # The response can be lost when the old process exits. Confirm through hello.
                    pass
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    current = self.hub.connections.get(device_id)
                    if (current and current is not connection and current.metadata.get('version') == manifest['version']
                            and (not manifest.get('reinstall') or current.metadata.get('binary_sha256') == manifest['sha256'])):
                        self.set_job(job_id, 'success', 100, '升级成功，新版本已重新连接。')
                        self.db.finish_audit(audit_id, 'success', '升级成功，新版本已重新连接。', (time.monotonic()-started)*1000)
                        return
                    await asyncio.sleep(1)
                raise TimeoutError('未在两分钟内确认新版本上线；请检查设备状态，可能已回滚')
        except asyncio.CancelledError:
            self.set_job(job_id, 'interrupted', progress, '主控停止，升级结果尚未确认，请核实设备版本。')
            self.db.finish_audit(audit_id, 'interrupted', '主控停止，升级结果尚未确认。', (time.monotonic()-started)*1000)
            raise
        except Exception as exc:
            status = 'timeout' if isinstance(exc, TimeoutError) else 'failed'
            detail = str(exc) or '升级超时，请核实设备版本后重试。'
            self.set_job(job_id, status, progress, detail)
            self.db.finish_audit(audit_id, status, detail, (time.monotonic()-started)*1000)
            logger.bind(trace_id=trace_id, device_id=device_id).warning('Upgrade failed: {}', detail)
            if not committed:
                try:
                    await send('agent.update.abort', {})
                except Exception:
                    pass
        finally:
            self.tasks.pop(device_id, None)

    async def close(self):
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
