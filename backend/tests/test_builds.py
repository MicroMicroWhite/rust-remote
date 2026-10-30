import hashlib
import os
import sys
import time

import pytest
from fastapi.testclient import TestClient

from lib.app import create_app
from lib.builds import Builds
from lib.config import Settings
from test_app import BASE, HELLO, PASSWORD, TOKEN, login

CONNECTION = {'server': 'wss://remote.example.test:8443/agent/ws', 'allow_insecure': False}


@pytest.fixture
def console(tmp_path, monkeypatch):
    """Exercise the real async subprocess path without downloading Rust toolchains."""
    executable = tmp_path / 'bin/docker'
    executable.parent.mkdir()
    executable.write_text(f'#!{sys.executable}\n' + '''
import os, sys, time
from pathlib import Path
args = sys.argv[1:]
if args[0] == 'version' or args == ['buildx', 'version']:
    sys.exit(0)
assert args[:2] == ['buildx', 'build']
token = os.environ['REMOTE_DEFAULT_TOKEN']
assert token not in ' '.join(args), 'Token leaked to argv'
assert 'id=client_token,env=REMOTE_DEFAULT_TOKEN' in args
print('Compiling rust-remote-client', flush=True)
print('Secret redaction check: ' + token, flush=True)
if os.getenv('TEST_BUILD_GATE'):
    gate = Path(os.environ['TEST_BUILD_GATE'])
    while not gate.exists():
        time.sleep(0.01)
if os.getenv('TEST_BUILD_FAILURE'):
    print('toolchain failed', flush=True)
    sys.exit(3)
directory = Path(args[args.index('--output') + 1].split('dest=', 1)[1])
name = 'rust-remote-client.exe' if any(arg.endswith('Dockerfile.windows') for arg in args) else 'rust-remote-client'
if not os.getenv('TEST_BUILD_MISSING_OUTPUT'):
    (directory / name).write_bytes(b'compiled for ' + os.environ['REMOTE_DEFAULT_SERVER'].encode())
print('exporting to client directory', flush=True)
''')
    executable.chmod(0o700)
    monkeypatch.setenv('PATH', str(executable.parent) + os.pathsep + os.environ['PATH'])
    settings = Settings(tmp_path / 'data', PASSWORD, TOKEN, 'a1b2c3d4')
    with TestClient(create_app(settings)) as client:
        yield client, settings


def wait_job(client, job_id, statuses=('success', 'failed')):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        response = client.get(BASE + '/client-builds/' + job_id)
        assert response.status_code == 200
        job = response.json()
        if job['status'] in statuses:
            return job
        time.sleep(0.02)
    raise AssertionError(f'Build did not finish: {job}')


def test_build_endpoints_require_login_and_csrf(console):
    client, _ = console
    for path in ('/client-config', '/client-builds', '/client-builds/missing', '/client-builds/missing/download'):
        assert client.get(BASE + path).status_code == 401
    assert client.put(BASE + '/client-config', json=CONNECTION).status_code == 401
    assert client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='linux')).status_code == 401
    assert client.post(BASE + '/client-builds/missing/publish').status_code == 401
    assert client.delete(BASE + '/client-builds/missing').status_code == 401
    login(client)
    client.headers.pop('X-CSRF-Token')
    assert client.put(BASE + '/client-config', json=CONNECTION).status_code == 403
    assert client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='linux')).status_code == 403
    assert client.post(BASE + '/client-builds/missing/publish').status_code == 403
    assert client.delete(BASE + '/client-builds/missing').status_code == 403


def test_config_validation_and_persistence(console):
    client, settings = console
    login(client)
    assert client.get(BASE + '/client-config').json()['config'] is None
    for body in (
        dict(CONNECTION, server='https://host/agent/ws'),
        dict(CONNECTION, server='ws://host/agent/ws'),
        dict(CONNECTION, server='wss://user:password@host/agent/ws'),
        dict(CONNECTION, server='wss://host/agent/ws?token=secret'),
        dict(CONNECTION, server='wss://host/other'),
        dict(CONNECTION, server='wss://host:0/agent/ws'),
        dict(CONNECTION, server='wss://host:99999/agent/ws'),
        dict(CONNECTION, server='wss://host/agent/ws\n'),
        dict(CONNECTION, server='wss://host\\evil/agent/ws'),
        dict(CONNECTION, allow_insecure='false'),
        dict(CONNECTION, token='must-not-be-stored'),
    ):
        assert client.put(BASE + '/client-config', json=body).status_code == 422
    body = {'server': 'ws://[::1]:8080/agent/ws', 'allow_insecure': True}
    assert client.put(BASE + '/client-config', json=body).json() == body
    assert Builds(settings, client.app.state.db).config() == body
    assert TOKEN not in client.get(BASE + '/client-config').text
    assert client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='macos')).status_code == 422
    assert client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='linux', arch='arm64')).status_code == 422
    response = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='linux', arch='aarch64'))
    assert response.status_code == 202
    assert wait_job(client, response.json()['id'])['arch'] == 'aarch64'


@pytest.mark.parametrize('platform', ['linux', 'windows'])
def test_successful_build_snapshot_log_redaction_download_and_audit(console, platform):
    client, settings = console
    login(client)
    response = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform=platform))
    assert response.status_code == 202
    job = wait_job(client, response.json()['id'])
    assert job['status'] == 'success' and job['stage'] == 'complete'
    assert job['published'] and '自动发布' in job['detail']
    assert job['platform'] == platform and job['arch'] == 'x86_64'
    assert '[REDACTED]' in job['log'] and TOKEN not in str(job)
    assert job['filename'].endswith('.exe') == (platform == 'windows')
    changed = dict(CONNECTION, server='wss://new.example.test/agent/ws')
    assert client.put(BASE + '/client-config', json=changed).status_code == 200
    assert client.get(BASE + '/client-builds/' + job['id']).json()['server'] == CONNECTION['server']
    listing = client.get(BASE + '/client-builds').json()
    assert listing[0]['id'] == job['id'] and 'log' not in listing[0]
    download = client.get(BASE + '/client-builds/' + job['id'] + '/download')
    assert download.status_code == 200
    assert download.content == b'compiled for ' + CONNECTION['server'].encode()
    assert len(download.content) == job['size']
    assert hashlib.sha256(download.content).hexdigest() == job['sha256']
    assert job['filename'] in download.headers['content-disposition']
    assert download.headers['cache-control'] == 'no-store'
    records = client.get(BASE + '/audit/records', params={'category': 'system'}).json()['items']
    assert {'client.config', 'client.build', 'client.download', 'client.publish'} <= {row['action'] for row in records}
    assert next(row for row in records if row['action'] == 'client.build')['status'] == 'success'
    publication = next(row for row in records if row['action'] == 'client.publish')
    assert publication['status'] == 'success' and '自动发布' in publication['detail']
    binary = settings.data_dir / 'client-builds' / job['id'] / job['filename']
    binary.write_bytes(b'corrupted')
    assert client.get(BASE + '/client-builds/' + job['id'] + '/download').status_code == 409
    assert client.post(BASE + '/client-builds/' + job['id'] + '/publish').status_code == 409
    binary.unlink()
    assert client.get(BASE + '/client-builds/' + job['id'] + '/download').status_code == 410
    assert client.get(BASE + '/client-builds/missing/download').status_code == 404


def test_active_build_conflict_and_early_download(console, tmp_path, monkeypatch):
    client, _ = console
    gate = tmp_path / 'gate'
    monkeypatch.setenv('TEST_BUILD_GATE', str(gate))
    login(client)
    job = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='linux')).json()
    assert client.delete(BASE + '/client-builds/' + job['id']).status_code == 409
    assert client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='windows')).status_code == 409
    assert client.get(BASE + '/client-builds/' + job['id'] + '/download').status_code == 409
    gate.touch()
    assert wait_job(client, job['id'])['status'] == 'success'


def test_failure_and_missing_docker(console, monkeypatch):
    client, _ = console
    login(client)
    monkeypatch.setenv('TEST_BUILD_FAILURE', '1')
    job = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='windows')).json()
    failed = wait_job(client, job['id'])
    assert failed['status'] == 'failed' and 'toolchain failed' in failed['log']
    assert '退出码 3' in failed['detail']
    assert client.get(BASE + '/client-builds/' + job['id'] + '/download').status_code == 409
    monkeypatch.setenv('PATH', '')
    assert not client.get(BASE + '/client-config').json()['builder']['available']
    assert client.put(BASE + '/client-config', json=CONNECTION).status_code == 200
    assert client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='linux')).status_code == 503


def test_restart_marks_unfinished_builds_interrupted(console):
    client, settings = console
    login(client)
    manager = client.app.state.builds
    with manager.db.connect() as db:
        db.execute('''INSERT INTO client_builds
            (id, platform, version, server, allow_insecure, status, stage, detail, created_at, updated_at)
            VALUES ('unfinished', 'linux', '0.3.2', ?, 0, 'running', 'compiling', '', 1, 1)''', (CONNECTION['server'],))
    restarted = Builds(settings, manager.db)
    job = restarted.get('unfinished')
    assert job['status'] == 'interrupted' and '重启' in job['detail']


def test_shutdown_stops_running_subprocess_and_persists_interruption(console, tmp_path, monkeypatch):
    client, _ = console
    monkeypatch.setenv('TEST_BUILD_GATE', str(tmp_path / 'never-opened'))
    login(client)
    job = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='linux')).json()
    wait_job(client, job['id'], statuses=('running',))
    client.portal.call(client.app.state.builds.close)
    interrupted = client.get(BASE + '/client-builds/' + job['id']).json()
    assert interrupted['status'] == 'interrupted'
    assert client.get(BASE + '/client-builds/' + job['id'] + '/download').status_code == 409


def test_successful_build_auto_publishes_for_each_platform_and_survives_restart(console):
    client, settings = console
    login(client)
    with pytest.raises(FileNotFoundError):
        client.app.state.upgrades.release(HELLO)
    jobs = []
    for platform in ('linux', 'windows', 'linux'):
        job = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform=platform)).json()
        job = wait_job(client, job['id'])
        assert job['published']
        jobs.append(job)
        manifest, binary = client.app.state.upgrades.release(dict(HELLO, platform=platform), read=True)
        assert manifest['version'] == job['version']
        assert binary == b'compiled for ' + CONNECTION['server'].encode()
    listing = {job['id']: job for job in client.get(BASE + '/client-builds').json()}
    assert jobs[0]['id'] not in listing
    assert client.get(BASE + '/client-builds/' + jobs[0]['id']).status_code == 404
    assert not (settings.data_dir / 'client-builds' / jobs[0]['id']).exists()
    assert jobs[1]['id'] in listing and jobs[2]['id'] in listing
    assert all(listing[job['id']]['published'] for job in jobs[1:])
    assert Builds(settings, client.app.state.db).get(jobs[-1]['id'])['published']
    with client.websocket_connect('/agent/ws', headers={'Authorization': 'Bearer ' + TOKEN}) as ws:
        ws.send_json(dict(HELLO, capabilities=['self-update-v1']))
        ws.receive_json()
        upgrade = client.get(BASE + '/devices').json()[0]['upgrade']
        assert upgrade['available'] and upgrade['job'] is None
    records = client.get(BASE + '/audit/records', params={'category': 'system'}).json()['items']
    assert any(row['action'] == 'client.publish' for row in records)
    binary = settings.data_dir / 'client-builds' / jobs[-1]['id'] / jobs[-1]['filename']
    binary.write_bytes(b'corrupted')
    assert client.post(BASE + '/client-builds/' + jobs[-1]['id'] + '/publish').status_code == 409


@pytest.mark.parametrize('platform', ['linux', 'windows'])
@pytest.mark.parametrize('failure', ['build', 'missing_output', 'invalid_version', 'publication'])
def test_failed_build_or_publication_preserves_previous_release(console, monkeypatch, platform, failure):
    client, _ = console
    login(client)
    previous = {}
    for target in ('linux', 'windows'):
        response = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform=target))
        previous[target] = wait_job(client, response.json()['id'])
        assert previous[target]['published']
    manager = client.app.state.builds
    if failure == 'build':
        monkeypatch.setenv('TEST_BUILD_FAILURE', '1')
    elif failure == 'missing_output':
        monkeypatch.setenv('TEST_BUILD_MISSING_OUTPUT', '1')
    elif failure == 'invalid_version':
        monkeypatch.setattr(manager, 'version', lambda: '0.3.5-beta')
    else:
        # Fail after the release pointer is written, proving the entire
        # completion transaction rolls back rather than exposing a partial job.
        with manager.db.connect() as db:
            db.execute('''CREATE TRIGGER reject_publication BEFORE INSERT ON audit
                WHEN NEW.action='client.publish'
                BEGIN SELECT RAISE(ABORT, 'publication unavailable'); END''')
    response = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform=platform))
    failed = wait_job(client, response.json()['id'])
    assert failed['status'] == 'failed' and not failed['published']
    assert failed['size'] is None and failed['sha256'] is None
    for target, job in previous.items():
        assert client.get(BASE + '/client-builds/' + job['id']).json()['published']
        manifest, data = client.app.state.upgrades.release(dict(HELLO, platform=target), read=True)
        assert manifest['sha256'] == job['sha256']
        assert data == b'compiled for ' + CONNECTION['server'].encode()
    with manager.db.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM audit WHERE action='client.publish'").fetchone()[0] == 2
        assert db.execute('SELECT COUNT(*) FROM device_upgrades').fetchone()[0] == 0


def test_same_version_rebuild_automatically_replaces_connection_bundle(console):
    client, _ = console
    login(client)
    response = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='windows'))
    first = wait_job(client, response.json()['id'])
    changed = dict(CONNECTION, server='wss://replacement.example.test/agent/ws', platform='windows')
    response = client.post(BASE + '/client-builds', json=changed)
    latest = wait_job(client, response.json()['id'])
    assert latest['version'] == first['version'] and latest['sha256'] != first['sha256']
    assert latest['published'] and client.get(BASE + '/client-builds/' + first['id']).status_code == 404
    manifest, data = client.app.state.upgrades.release(dict(HELLO, platform='windows'), read=True)
    assert manifest['sha256'] == latest['sha256']
    assert data == b'compiled for ' + changed['server'].encode()


def test_build_history_deduplicates_before_limit_and_preserves_published_and_failed_jobs(console):
    client, _ = console
    login(client)
    manager = client.app.state.builds
    digest = hashlib.sha256(b'identical program').hexdigest()
    other = hashlib.sha256(b'older different program').hexdigest()
    with manager.db.connect() as db:
        rows = [('old-unique', 'linux', 'success', other, 1)]
        rows += [(f'duplicate-{i}', 'linux', 'success', digest, 10 + i) for i in range(40)]
        rows += [('same-hash-windows', 'windows', 'success', digest, 51),
                 ('failed-1', 'linux', 'failed', None, 52), ('failed-2', 'linux', 'failed', None, 53),
                 ('running', 'linux', 'running', None, 54)]
        for job_id, platform, status, sha256, created in rows:
            db.execute('''INSERT INTO client_builds
                (id,platform,version,server,allow_insecure,status,stage,detail,size,sha256,created_at,updated_at)
                VALUES (?,?, '0.3.2', ?, 0, ?, 'complete', '', ?, ?, ?, ?)''',
                (job_id, platform, CONNECTION['server'], status, 1234 if sha256 else None, sha256, created, created))
    listing = client.get(BASE + '/client-builds').json()
    assert [job['id'] for job in listing] == [
        'running', 'failed-2', 'failed-1', 'same-hash-windows', 'duplicate-39', 'old-unique']
    assert next(job for job in listing if job['id'] == 'duplicate-39')['size'] == 1234
    assert all('duplicate_rank' not in job and 'log' not in job for job in listing)
    # Published artifacts must remain visible even if a newer build is identical.
    with manager.db.connect() as db:
        db.execute("INSERT INTO settings VALUES ('client_release_linux', 'duplicate-0')")
    listing = client.get(BASE + '/client-builds').json()
    linux = [job for job in listing if job['platform'] == 'linux' and job['sha256'] == digest]
    assert len(linux) == 1 and linux[0]['id'] == 'duplicate-0' and linux[0]['published']
    # Hiding duplicates must not remove their details or historical references.
    assert client.get(BASE + '/client-builds/duplicate-39').json()['sha256'] == digest


def test_delete_latest_build_unpublishes_only_its_platform(console):
    client, settings = console
    login(client)
    jobs = []
    for platform in ('linux', 'linux', 'windows'):
        response = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform=platform))
        jobs.append(wait_job(client, response.json()['id']))
    assert client.get(BASE + '/client-builds/' + jobs[0]['id']).status_code == 404
    assert client.get(BASE + '/client-builds/' + jobs[1]['id']).json()['published']
    assert jobs[2]['published']
    response = client.delete(BASE + '/client-builds/' + jobs[1]['id'])
    assert response.status_code == 200
    assert set(response.json()['deleted_ids']) == {jobs[1]['id']}
    for job in jobs[:2]:
        if job is jobs[0]:
            continue
        assert client.get(BASE + '/client-builds/' + job['id']).status_code == 404
        assert client.get(BASE + '/client-builds/' + job['id'] + '/download').status_code == 404
        assert not (settings.data_dir / 'client-builds' / job['id']).exists()
    assert client.get(BASE + '/client-builds').json()[0]['id'] == jobs[2]['id']
    assert client.get(BASE + '/client-builds/' + jobs[2]['id']).json()['published']
    with client.app.state.db.connect() as db:
        assert not db.execute("SELECT 1 FROM settings WHERE key='client_release_linux'").fetchone()
    assert client.delete(BASE + '/client-builds/missing').status_code == 404
    records = client.get(BASE + '/audit/records', params={'category': 'system'}).json()['items']
    assert any(row['action'] == 'client.delete' and row['status'] == 'success' for row in records)


def test_delete_failed_job_with_missing_files(console, monkeypatch):
    client, settings = console
    login(client)
    monkeypatch.setenv('TEST_BUILD_FAILURE', '1')
    response = client.post(BASE + '/client-builds', json=dict(CONNECTION, platform='linux'))
    job = wait_job(client, response.json()['id'])
    assert job['status'] == 'failed'
    import shutil
    shutil.rmtree(settings.data_dir / 'client-builds' / job['id'])
    assert client.delete(BASE + '/client-builds/' + job['id']).status_code == 200
    assert client.get(BASE + '/client-builds').json() == []
