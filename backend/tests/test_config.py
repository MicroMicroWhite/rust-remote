import json
import stat

import pytest
from fastapi.testclient import TestClient

from lib.app import create_app
from lib.config import Settings
from test_app import PASSWORD, TOKEN


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    for name in ('ADMIN_PASSWORD', 'AGENT_TOKEN', 'ENTRANCE_CODE'):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def test_first_start_generates_credentials_and_restart_keeps_login(deployment):
    first = Settings.from_env()
    path = deployment / 'credentials.json'
    saved = path.read_bytes()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert len(first.agent_token) >= 32
    base = f'/{first.entrance_code}/api'
    with TestClient(create_app(first)) as client:
        assert client.post(base + '/login', json={'password': first.admin_password}).status_code == 200
        cookies = client.cookies
    second = Settings.from_env()
    assert first == second and path.read_bytes() == saved
    with TestClient(create_app(second)) as client:
        client.cookies = cookies
        assert client.get(base + '/session').status_code == 200
        assert client.get('/deadbeef/').status_code == (200 if first.entrance_code == 'deadbeef' else 404)
        assert client.get(f'/{first.entrance_code}/').headers['x-accel-redirect'] == '/_console/index.html'
        assert client.get('/_console/index.html').status_code == 404


def test_existing_env_is_imported_and_password_override_persists(deployment, monkeypatch):
    supplied = dict(ADMIN_PASSWORD=PASSWORD, AGENT_TOKEN=TOKEN, ENTRANCE_CODE='a1b2c3d4')
    for name, value in supplied.items():
        monkeypatch.setenv(name, value)
    first = Settings.from_env()
    assert json.loads((deployment / 'credentials.json').read_text()) == supplied
    monkeypatch.setenv('ADMIN_PASSWORD', PASSWORD + '-rotated')
    second = Settings.from_env()
    for name in supplied:
        monkeypatch.delenv(name)
    assert Settings.from_env() == second
    assert second.agent_token == first.agent_token and second.entrance_code == first.entrance_code


def test_invalid_override_does_not_overwrite_saved_credentials(deployment, monkeypatch):
    Settings.from_env()
    path = deployment / 'credentials.json'
    saved = path.read_bytes()
    monkeypatch.setenv('ENTRANCE_CODE', '../invalid')
    with pytest.raises(ValueError, match='ENTRANCE_CODE'):
        Settings.from_env()
    assert path.read_bytes() == saved


def test_existing_database_requires_original_credentials_for_migration(deployment, monkeypatch):
    (deployment / 'remote.sqlite3').touch()
    with pytest.raises(ValueError, match='Existing deployment'):
        Settings.from_env()
    assert not (deployment / 'credentials.json').exists()
    for name, value in dict(ADMIN_PASSWORD=PASSWORD, AGENT_TOKEN=TOKEN, ENTRANCE_CODE='a1b2c3d4').items():
        monkeypatch.setenv(name, value)
    assert Settings.from_env().agent_token == TOKEN
