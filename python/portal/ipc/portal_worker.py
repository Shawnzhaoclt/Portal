from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from collections.abc import Callable
from typing import Any


_DLL_DIRECTORY_HANDLES: list[Any] = []


def _configure_packaged_geospatial_runtime() -> None:
    """Expose the bundled GDAL/PROJ runtime before Portal routes are imported."""
    if not getattr(sys, "frozen", False):
        return

    runtime_root = Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    dll_directories = (runtime_root, runtime_root / "Library" / "bin")
    existing_path = os.environ.get("PATH", "")
    os.environ["PATH"] = os.pathsep.join(
        [str(path) for path in dll_directories if path.is_dir()] + ([existing_path] if existing_path else [])
    )
    if hasattr(os, "add_dll_directory"):
        for path in dll_directories:
            if path.is_dir():
                _DLL_DIRECTORY_HANDLES.append(os.add_dll_directory(str(path)))

    gdal_data = runtime_root / "Library" / "share" / "gdal"
    proj_data = runtime_root / "Library" / "share" / "proj"
    if gdal_data.is_dir():
        os.environ.setdefault("GDAL_DATA", str(gdal_data))
    if proj_data.is_dir():
        os.environ.setdefault("PROJ_DATA", str(proj_data))


_configure_packaged_geospatial_runtime()


PYTHON_ROOT = Path(__file__).resolve().parents[2]
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from portal.app.core.secure_catalog import install_system_catalog_sqlcipher_hook

install_system_catalog_sqlcipher_hook()


JobHandler = Callable[[dict[str, Any]], dict[str, Any]]


def health_job(_: dict[str, Any]) -> dict[str, Any]:
    geospatial_runtime: dict[str, Any]
    try:
        import pyproj
        import rasterio
        import shapely
        from pyproj import Transformer
        from shapely.geometry import LineString, mapping
        from shapely.ops import transform

        # Exercise the exact imports used by terrain_profile._sample_profile.
        _ = (Transformer, LineString, mapping, transform)
        geospatial_runtime = {
            "ok": True,
            "pyprojVersion": pyproj.__version__,
            "rasterioVersion": rasterio.__version__,
            "shapelyVersion": shapely.__version__,
        }
    except Exception as error:
        geospatial_runtime = {
            "ok": False,
            "errorType": type(error).__name__,
            "error": str(error),
        }
    return {
        "ok": True,
        "worker": "portal-python",
        "pythonVersion": sys.version.split()[0],
        "executable": sys.executable,
        "geospatialRuntime": geospatial_runtime,
    }


def request_job(request: dict[str, Any]) -> dict[str, Any]:
    from portal.runtime import dispatch_request

    return dispatch_request(request)


def management_job(request: dict[str, Any]) -> dict[str, Any]:
    """Run the standalone Portal Manager against the local system catalog."""
    from portal.app.management_runner import run

    payload = dict(request)
    settings_value = payload.pop("_settings_path", None) or os.environ.get("PORTAL_SETTINGS_PATH")
    if not settings_value:
        raise ValueError("Portal Manager settings were not supplied to the Python worker.")
    return run(payload, Path(str(settings_value)))


def secure_catalog_job(request: dict[str, Any]) -> dict[str, Any]:
    """Encrypt one verified plaintext catalog for the current Desktop user."""
    from portal.app.core.secure_catalog import encrypt_plaintext_system_catalog

    source = request.get("source")
    destination = request.get("destination")
    if not isinstance(source, str) or not isinstance(destination, str):
        raise ValueError("System catalog encryption requires source and destination paths.")
    return encrypt_plaintext_system_catalog(source, destination)


JOBS: dict[str, JobHandler] = {
    "request": request_job,
    "health": health_job,
    "management": management_job,
    "secure_catalog": secure_catalog_job,
}


def parse_request(raw_request: str | None) -> dict[str, Any]:
    if not raw_request:
        return {}
    parsed = json.loads(raw_request)
    if not isinstance(parsed, dict):
        raise ValueError("The job request must be a JSON object.")
    return parsed


def serve() -> int:
    for raw_message in sys.stdin:
        raw_message = raw_message.strip()
        if not raw_message:
            continue

        request_id: Any = None
        try:
            message = json.loads(raw_message)
            if not isinstance(message, dict):
                raise ValueError("The worker message must be a JSON object.")
            request_id = message.get("id")
            job = str(message.get("job") or "")
            if job not in JOBS:
                raise ValueError(f"Unknown Python job: {job or '<empty>'}.")
            request = message.get("request")
            if not isinstance(request, dict):
                raise ValueError("The worker request must be a JSON object.")
            response = {
                "id": request_id,
                "ok": True,
                "result": JOBS[job](request),
            }
        except Exception as error:  # Keep the worker alive after a failed command.
            response = {
                "id": request_id,
                "ok": False,
                "error": str(error),
            }

        print(json.dumps(response, separators=(",", ":")), flush=True)

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Portal desktop Python job worker")
    parser.add_argument("--job", choices=sorted(JOBS))
    parser.add_argument("--request-json")
    parser.add_argument("--request-stdin", action="store_true")
    parser.add_argument("--serve", action="store_true")
    arguments = parser.parse_args()

    if arguments.serve:
        return serve()
    if not arguments.job:
        parser.error("--job is required unless --serve is used")

    try:
        raw_request = sys.stdin.read() if arguments.request_stdin else arguments.request_json
        result = JOBS[arguments.job](parse_request(raw_request))
    except Exception as error:  # The Rust host records the structured job failure.
        print(str(error), file=sys.stderr)
        return 1

    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
