"""ITpipes cloud media.

The inspection media now lives in ITpipes' S3 bucket, not on the share. ITpipes
mints presigned URLs for it - query-string credentials with an ``Expires`` stamp -
which its web app hands to the browser after the user signs in.

Portal therefore never holds an ITpipes credential. The desktop host reads the
session cookie from the window the user signed in to, this module uses that cookie
to fetch the page and harvest the presigned URLs, and the bytes are streamed back
through Portal's own origin. The proxy exists for two reasons the presigned URL
cannot satisfy on its own: the viewer draws video frames onto a canvas, which needs
same-origin bytes, and the presigned link expires, which would strand a page left
open. Range requests pass through so the scrubber keeps working.
"""

from __future__ import annotations

import mimetypes
import re
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterator

ITPIPES_ORIGIN = "https://charlottenc.itpipes.com"
INSPECTION_PATH = "/Asset/SearchByInspId"
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)
# A presigned S3 link. The query string carries the credential, so the pattern
# stops at the first character that cannot appear in a URL.
S3_URL_PATTERN = re.compile(
    r"https://[A-Za-z0-9.\-]+\.s3[.A-Za-z0-9\-]*\.amazonaws\.com/[^\s\"'<>\\)]+",
    re.IGNORECASE,
)
VIDEO_SUFFIXES = (".mp4", ".avi", ".mov", ".wmv", ".mkv")
PICTURE_SUFFIXES = (".jpg", ".jpeg", ".png", ".gif", ".bmp")
# Bounded so an open-ended range on a 400 MB video does not buffer the whole file.
MEDIA_CHUNK_BYTES = 4 * 1024 * 1024
STREAM_BLOCK_BYTES = 256 * 1024


def _opener() -> urllib.request.OpenerDirector:
    """A redirect-following opener that keeps the session cookie attached.

    urllib drops headers across redirects to a different host, and ITpipes bounces
    through its login route, so the cookie is re-attached by the handler rather than
    set once on the request.
    """
    context = ssl.create_default_context()
    # The corporate network intercepts TLS with a CA certificate that lacks the
    # Authority Key Identifier extension. Python 3.13 rejects that under its new
    # strict X.509 profile, though browsers on the same machine accept it. Only the
    # strict-profile flag is relaxed: the chain must still verify against the
    # Windows trust store and the hostname must still match.
    context.verify_flags &= ~ssl.VERIFY_X509_STRICT
    return urllib.request.build_opener(urllib.request.HTTPSHandler(context=context))


def _fetch_text(url: str, cookie: str, timeout: int = 12) -> tuple[str, str]:
    request = urllib.request.Request(url)
    request.add_header("User-Agent", BROWSER_USER_AGENT)
    request.add_header("Accept", "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8")
    if cookie:
        request.add_header("Cookie", cookie)
    with _opener().open(request, timeout=timeout) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        return response.read().decode(charset, errors="replace"), response.geturl()


def _unescape(body: str) -> str:
    """Presigned URLs arrive HTML-escaped, JSON-escaped, or both."""
    return (
        body.replace("&amp;", "&")
        .replace("\\u0026", "&")
        .replace("\\u003d", "=")
        .replace("\\/", "/")
    )


def _is_signed_out_url(url: str) -> bool:
    """ITpipes bounces a dead session to /Account/Logon - note Logon, not Login."""
    lowered = url.lower()
    return "/account/log" in lowered or "login" in lowered


def _media_kind(path: str) -> str:
    lowered = path.lower()
    if lowered.endswith(VIDEO_SUFFIXES) or "/videos/" in lowered:
        return "video"
    if lowered.endswith(PICTURE_SUFFIXES) or "/pictures/" in lowered or "/images/" in lowered:
        return "picture"
    if lowered.endswith(".pdf"):
        return "report"
    return "other"


def _describe(raw_url: str) -> dict[str, Any] | None:
    parsed = urllib.parse.urlsplit(raw_url)
    file_name = urllib.parse.unquote(parsed.path.rsplit("/", 1)[-1])
    if not file_name:
        return None
    return {
        "name": file_name,
        "kind": _media_kind(parsed.path),
        "source_url": raw_url,
        # Proxied through Portal so canvas capture works and an expired link can be
        # refreshed without the page holding a stale URL.
        "url": "/api/amteam/itpipes/media?u=" + urllib.parse.quote(raw_url, safe=""),
    }


def collect_media_urls(body: str) -> list[str]:
    """Every distinct presigned S3 URL in a page, in the order it appears."""
    found: list[str] = []
    for match in S3_URL_PATTERN.finditer(_unescape(body)):
        candidate = match.group(0).rstrip(".,;")
        if candidate not in found:
            found.append(candidate)
    return found


def _same_origin_links(body: str) -> list[str]:
    links: list[str] = []
    for match in re.finditer(r"href=[\"']([^\"']+)[\"']", body, re.IGNORECASE):
        href = match.group(1)
        absolute = ITPIPES_ORIGIN + href if href.startswith("/") else href
        if absolute.startswith(ITPIPES_ORIGIN) and "insp" in absolute.lower():
            if absolute not in links:
                links.append(absolute)
    return links


# The desktop host posts the session cookie with every session probe, and the
# worker keeps the latest one so ordinary data endpoints can fetch media without
# threading the cookie through each request. One user per worker process, so one
# slot is the right shape. Held in memory only - never written anywhere.
_session_lock = threading.Lock()
_session_cookie = ""
# Scraping ITpipes per inspection is slow; successful manifests are reused briefly.
_MANIFEST_TTL_SECONDS = 10 * 60
_manifest_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def remember_cookie(cookie: str) -> None:
    global _session_cookie
    cleaned = (cookie or "").strip()
    with _session_lock:
        if cleaned and cleaned != _session_cookie:
            _session_cookie = cleaned
            # A new session mints new presigned URLs; the old ones may be dead.
            _manifest_cache.clear()
        elif not cleaned:
            _session_cookie = ""


def current_cookie() -> str:
    with _session_lock:
        return _session_cookie


def inspection_media(mli_id: str, cookie: str) -> dict[str, Any]:
    """Presigned media for one inspection, or a not-connected answer.

    A redirect to the login route means the session has lapsed rather than that the
    inspection has no media, and the two are reported differently so the page can
    offer to sign in again instead of showing an empty gallery.
    """
    if not cookie:
        return {"connected": False, "reason": "no_session", "media": []}

    with _session_lock:
        cached = _manifest_cache.get(mli_id)
        if cached and time.monotonic() - cached[0] < _MANIFEST_TTL_SECONDS:
            return cached[1]

    query = urllib.parse.urlencode({"assetType": "ML", "inspID": mli_id})
    try:
        body, final_url = _fetch_text(f"{ITPIPES_ORIGIN}{INSPECTION_PATH}?{query}", cookie)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return {"connected": False, "reason": "signed_out", "media": []}
        return {"connected": True, "reason": f"http_{error.code}", "media": []}
    except (urllib.error.URLError, OSError) as error:
        return {"connected": False, "reason": "unreachable", "detail": str(error), "media": []}

    if _is_signed_out_url(final_url):
        return {"connected": False, "reason": "signed_out", "media": []}

    urls = collect_media_urls(body)
    if not urls:
        # Some ITpipes views list the inspection and keep the media on a detail
        # page; follow a few same-origin inspection links before giving up.
        for link in _same_origin_links(body)[:4]:
            try:
                inner, _ = _fetch_text(link, cookie)
            except (urllib.error.URLError, OSError):
                continue
            urls = collect_media_urls(inner)
            if urls:
                break

    media = [entry for entry in (_describe(url) for url in urls) if entry]
    result = {
        "connected": True,
        "mli_id": mli_id,
        "source_url": final_url,
        "media": media,
        "counts": {
            kind: sum(1 for entry in media if entry["kind"] == kind)
            for kind in ("video", "picture", "report", "other")
        },
    }
    if media:
        with _session_lock:
            _manifest_cache[mli_id] = (time.monotonic(), result)
    return result


def cloud_media_assets(mli_id: str) -> dict[str, Any]:
    """Cloud media in the shape the observation endpoints always returned.

    Same keys as the old share-based listing, so the snapshot-to-observation
    matching and the whole viewer keep working unchanged - only the storage moved.
    """
    result = inspection_media(mli_id, current_cookie())
    buckets: dict[str, list[dict[str, Any]]] = {"snapshots": [], "videos": [], "reports": []}
    kind_map = {"picture": ("snapshots", "snapshot"), "video": ("videos", "video"), "report": ("reports", "report")}
    for entry in result.get("media", []):
        target = kind_map.get(str(entry.get("kind")))
        if target is None:
            continue
        key, kind = target
        media_type, _ = mimetypes.guess_type(str(entry.get("name")))
        buckets[key].append(
            {
                "name": entry["name"],
                "kind": kind,
                "relative_path": entry["name"],
                "url": entry["url"],
                "media_type": media_type,
            }
        )
    warnings: list[str] = []
    if not result.get("connected"):
        warnings.append("ITpipes is not signed in, so inspection media could not be loaded.")
    elif not result.get("media"):
        warnings.append("ITpipes returned no media for this inspection.")
    return {
        "media_root": "ITpipes cloud",
        "pipe_folder": None,
        "inspection_folder": None,
        "date_prefix": None,
        **buckets,
        "warnings": warnings,
        "itpipes_connected": bool(result.get("connected")),
        "itpipes_reason": result.get("reason"),
    }


def session_state(cookie: str) -> dict[str, Any]:
    """Whether this cookie still represents a signed-in ITpipes session.

    The landing page redirects to the login route when the session has lapsed, so
    the final URL after redirects is the answer - cheaper and more reliable than
    guessing from the cookie's presence alone.
    """
    if not cookie:
        return {"connected": False, "reason": "no_session"}
    try:
        _, final_url = _fetch_text(ITPIPES_ORIGIN, cookie, timeout=10)
    except urllib.error.HTTPError as error:
        if error.code in (401, 403):
            return {"connected": False, "reason": "signed_out"}
        return {"connected": False, "reason": f"http_{error.code}"}
    except (urllib.error.URLError, OSError) as error:
        return {"connected": False, "reason": "unreachable", "detail": str(error)}
    if _is_signed_out_url(final_url):
        return {"connected": False, "reason": "signed_out"}
    return {"connected": True}


def is_itpipes_media_url(raw_url: str) -> bool:
    """Only ITpipes' own S3 media may be proxied - this is not a general relay."""
    parsed = urllib.parse.urlsplit(raw_url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (
        host == "s3.amazonaws.com" or host.endswith(".s3.amazonaws.com") or ".s3." in host
    )


def _bounded_range(range_header: str | None) -> str | None:
    """Cap an open-ended range so one request cannot pull a whole video."""
    if not range_header or not range_header.startswith("bytes="):
        return range_header
    spec = range_header[len("bytes=") :]
    if "," in spec:
        return range_header
    if spec.endswith("-"):
        try:
            start = int(spec[:-1] or 0)
        except ValueError:
            return range_header
        return f"bytes={start}-{start + MEDIA_CHUNK_BYTES - 1}"
    return range_header


def open_media(raw_url: str, range_header: str | None) -> tuple[int, dict[str, str], Iterator[bytes]]:
    """Stream one media object, passing Range through so seeking works."""
    request = urllib.request.Request(raw_url)
    request.add_header("User-Agent", BROWSER_USER_AGENT)
    bounded = _bounded_range(range_header)
    if bounded:
        request.add_header("Range", bounded)
    response = _opener().open(request, timeout=90)
    headers = {"Accept-Ranges": "bytes"}
    for name in ("Content-Type", "Content-Range", "Content-Length", "ETag", "Last-Modified"):
        value = response.headers.get(name)
        if value:
            headers[name] = value

    def stream() -> Iterator[bytes]:
        try:
            while True:
                block = response.read(STREAM_BLOCK_BYTES)
                if not block:
                    break
                yield block
        finally:
            response.close()

    return response.status, headers, stream()
