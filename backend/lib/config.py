import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from loguru import logger


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    admin_password: str
    agent_token: str
    entrance_code: str
    cookie_secure: bool = False
    session_hours: int = 12
    command_timeout: float = 45
    max_file_bytes: int = 8 * 1024 * 1024
    releases_dir: Path | None = None
    client_source_dir: Path = Path(__file__).resolve().parents[2] / 'client'

    def __post_init__(self):
        if self.releases_dir is None:
            object.__setattr__(self, 'releases_dir', self.data_dir / 'releases')

    @classmethod
    def from_env(cls):
        data_dir = Path(os.getenv('DATA_DIR', 'data'))
        path = data_dir / 'credentials.json'
        saved = json.loads(path.read_text()) if path.exists() else {}
        credentials = {name: os.getenv(name) or saved.get(name, '')
                       for name in ('ADMIN_PASSWORD', 'AGENT_TOKEN', 'ENTRANCE_CODE')}
        # Never silently replace an existing deployment's missing device token.
        if not saved and (data_dir / 'remote.sqlite3').exists() and not all(credentials.values()):
            raise ValueError('Existing deployment: provide ADMIN_PASSWORD, AGENT_TOKEN and ENTRANCE_CODE once to preserve credentials')
        generated_password = not credentials['ADMIN_PASSWORD']
        credentials['ADMIN_PASSWORD'] = credentials['ADMIN_PASSWORD'] or secrets.token_urlsafe(24)
        credentials['AGENT_TOKEN'] = credentials['AGENT_TOKEN'] or secrets.token_urlsafe(48)
        credentials['ENTRANCE_CODE'] = credentials['ENTRANCE_CODE'] or secrets.token_hex(4)
        settings = cls(
            data_dir=data_dir,
            admin_password=credentials['ADMIN_PASSWORD'],
            agent_token=credentials['AGENT_TOKEN'],
            entrance_code=credentials['ENTRANCE_CODE'],
            cookie_secure=os.getenv("COOKIE_SECURE", "false").lower() == "true",
            releases_dir=Path(os.getenv('RELEASES_DIR', str(data_dir / 'releases'))),
            client_source_dir=Path(os.getenv("CLIENT_SOURCE_DIR", str(Path(__file__).resolve().parents[2] / 'client'))),
        )
        settings.validate()
        if credentials != saved:
            data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = path.with_suffix('.tmp')
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w') as file:
                json.dump(credentials, file, indent=2)
                file.write('\n')
                file.flush()
                os.fsync(file.fileno())
            temporary.replace(path)
        if generated_password:
            logger.info('Initial administrator password: {}', settings.admin_password)
        return settings

    def validate(self):
        import re

        if len(self.admin_password) < 12:
            raise ValueError("ADMIN_PASSWORD must contain at least 12 characters")
        if len(self.agent_token) < 32:
            raise ValueError("AGENT_TOKEN must contain at least 32 characters")
        if not re.fullmatch(r"[a-f0-9]{8}", self.entrance_code):
            raise ValueError("ENTRANCE_CODE must contain 8 lowercase hexadecimal characters")
