from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from collections.abc import Callable
from typing import Any


PYTHON_ROOT = Path(__file__).resolve().parents[2]
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))


JobHandler = Callable[[dict[str, Any]], dict[str, Any]]


def health_job(_: dict[str, Any]) -> dict[str, Any]:
    return {
        "ok": True,
        "worker": "portal-python",
        "pythonVersion": sys.version.split()[0],
        "executable": sys.executable,
    }


def request_job(request: dict[str, Any]) -> dict[str, Any]:
    from portal.runtime import dispatch_request

    return dispatch_request(request)


JOBS: dict[str, JobHandler] = {
    "request": request_job,
    "health": health_job,
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
