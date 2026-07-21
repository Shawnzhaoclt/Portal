from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, time as datetime_time, timezone
from typing import Any
from zoneinfo import ZoneInfo

PASSWORD_HASH_PREFIX = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 310_000


def utc_now_text() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"{PASSWORD_HASH_PREFIX}${PASSWORD_ITERATIONS}${_b64encode(salt)}${_b64encode(digest)}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        prefix, iterations_text, salt_text, digest_text = password_hash.split("$", 3)
        if prefix != PASSWORD_HASH_PREFIX:
            return False
        iterations = int(iterations_text)
        salt = _b64decode(salt_text)
        expected = _b64decode(digest_text)
    except (TypeError, ValueError):
        return False

    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def auth_secret() -> str:
    return os.getenv("PORTAL_AUTH_SECRET", "portal-local-development-secret")


def _default_access_token_expiry() -> int:
    session_timezone = ZoneInfo(os.getenv("PORTAL_SESSION_TIMEZONE", "America/New_York"))
    now = datetime.now(session_timezone)
    tomorrow = now.date().toordinal() + 1
    next_midnight = datetime.combine(datetime.fromordinal(tomorrow).date(), datetime_time.min, tzinfo=session_timezone)
    return int(next_midnight.astimezone(timezone.utc).timestamp()) - 1


def create_access_token(user_id: int, role: str = "user", ttl_seconds: int | None = None) -> str:
    now = int(time.time())
    configured_ttl = os.getenv("PORTAL_AUTH_TOKEN_TTL_SECONDS", "").strip()
    if ttl_seconds is not None:
        expires_at = now + ttl_seconds
    elif configured_ttl:
        expires_at = now + int(configured_ttl)
    else:
        expires_at = _default_access_token_expiry()
    payload: dict[str, Any] = {
        "sub": user_id,
        "role": role,
        "exp": expires_at,
        "iat": now,
        "nonce": secrets.token_urlsafe(8),
    }
    payload_text = _b64encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    signature = hmac.new(auth_secret().encode("utf-8"), payload_text.encode("ascii"), hashlib.sha256).digest()
    return f"{payload_text}.{_b64encode(signature)}"


def decode_access_token(token: str) -> dict[str, Any] | None:
    try:
        payload_text, signature_text = token.split(".", 1)
        expected = hmac.new(auth_secret().encode("utf-8"), payload_text.encode("ascii"), hashlib.sha256).digest()
        actual = _b64decode(signature_text)
        if not hmac.compare_digest(actual, expected):
            return None
        payload = json.loads(_b64decode(payload_text).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except (ValueError, json.JSONDecodeError, TypeError):
        return None
