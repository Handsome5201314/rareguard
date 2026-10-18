"""Encrypted per-Octop-user bindings and short-lived confirmation requests."""
from __future__ import annotations

import csv
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
from contextlib import contextmanager
import threading

from cryptography.fernet import Fernet, InvalidToken

from .client import PluginError

_initialization_lock = threading.Lock()


@contextmanager
def initialization_lock(root: Path):
    """Protect initial key creation across threads and Octop worker processes."""
    path = root / "initialize.lock"
    if path.is_symlink():
        raise PluginError("STORAGE_UNSAFE", "插件初始化锁不能是符号链接。")
    with _initialization_lock, path.open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            if path.stat().st_size == 0:
                lock.write(b"0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def storage_root() -> Path:
    configured = os.environ.get("DRAVET_PLUGIN_DATA_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".octop" / "private" / "dravet-monitor-plugin"


def _secure_directory(root: Path):
    if not root.is_absolute() or root.is_symlink():
        raise PluginError("STORAGE_UNSAFE", "插件存储必须是服务端绝对路径，不能是符号链接。")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == "nt":
        flags = subprocess.CREATE_NO_WINDOW
        try:
            result = subprocess.run(["whoami", "/user", "/fo", "csv", "/nh"],
                                    capture_output=True, text=True, check=True, creationflags=flags)
            sid = list(csv.reader(result.stdout.strip().splitlines()))[0][1]
            subprocess.run(["icacls", str(root), "/inheritance:r", "/grant:r",
                            f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"],
                           capture_output=True, check=True, creationflags=flags)
        except (OSError, subprocess.SubprocessError, IndexError):
            raise PluginError("STORAGE_UNSAFE", "无法限制插件私有目录访问权限，拒绝保存凭据。") from None
    else:
        root.chmod(0o700)


class BindingStore:
    def __init__(self, root: Path):
        _secure_directory(root)
        self.path = root / "bindings.sqlite"
        key_file = root / "key.bin"
        if key_file.is_symlink() or self.path.is_symlink():
            raise PluginError("STORAGE_UNSAFE", "插件密钥或数据库不能是符号链接。")
        with initialization_lock(root):
            if not key_file.exists():
                if self.path.exists() and self.path.stat().st_size:
                    raise PluginError("STORAGE_KEY_MISSING", "插件旧数据库缺少加密密钥，不能生成替代密钥。")
                fd = os.open(key_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(Fernet.generate_key())
                    stream.flush()
                    os.fsync(stream.fileno())
            try:
                self.cipher = Fernet(key_file.read_bytes())
            except (ValueError, OSError):
                raise PluginError("STORAGE_KEY_INVALID", "插件加密密钥无效或无法读取。") from None
        with self.connection() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS bindings (owner TEXT PRIMARY KEY, payload BLOB NOT NULL);
            """)
        if os.name != "nt":
            self.path.chmod(0o600)

    @contextmanager
    def connection(self):
        db = sqlite3.connect(self.path, timeout=30)
        try:
            with db:
                yield db
        finally:
            db.close()

    def seal(self, data) -> bytes:
        return self.cipher.encrypt(json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8"))

    def open(self, data):
        try:
            return json.loads(self.cipher.decrypt(data))
        except (InvalidToken, ValueError, UnicodeError):
            raise PluginError("STORAGE_INTEGRITY_ERROR", "插件私有存储完整性检查失败，不能读取或覆盖旧绑定。") from None

    def get(self, owner: str):
        with self.connection() as db:
            row = db.execute("SELECT payload FROM bindings WHERE owner=?", (owner,)).fetchone()
            if not row:
                raise PluginError("NOT_BOUND", "当前Octop用户未绑定夜间监测，请登录夜间监测并发送专属连接包。")
            return self.open(row[0])

    def bind(self, owner: str, value):
        with self.connection() as db:
            db.execute("INSERT INTO bindings VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET payload=excluded.payload",
                       (owner, self.seal(value)))

    def unbind(self, owner: str):
        with self.connection() as db:
            db.execute("DELETE FROM bindings WHERE owner=?", (owner,))



def owner_key(user_id: int) -> str:
    return hashlib.sha256(f"octop-user:{user_id}".encode()).hexdigest()
