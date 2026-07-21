from __future__ import annotations

import inspect
import json
import re
from collections.abc import Generator
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from types import UnionType
from typing import Any, Union, get_args, get_origin, get_type_hints

from .transport import Dependency, FileResponse, HTTPException, Parameter, Request, Response, Route


_PATH_TOKEN = re.compile(r"\{([^}:]+)(?::path)?\}")
_STARTED = False


def _route_pattern(route: Route) -> re.Pattern[str]:
    cursor = 0
    parts: list[str] = ["^"]
    for match in _PATH_TOKEN.finditer(route.path):
        parts.append(re.escape(route.path[cursor : match.start()]))
        token = match.group(0)
        parts.append(f"(?P<{match.group(1)}>{'.+' if token.endswith(':path}') else '[^/]+'})")
        cursor = match.end()
    parts.append(re.escape(route.path[cursor:]))
    parts.append("$")
    return re.compile("".join(parts))


def _find_route(method: str, path: str) -> tuple[Route, dict[str, str]]:
    from portal.app.registry import app

    for route in app.routes:
        if route.method != method:
            continue
        match = _route_pattern(route).match(path)
        if match:
            return route, match.groupdict()
    raise HTTPException(status_code=404, detail=f"No local command is registered for {method} {path}.")


def _coerce_scalar(value: Any, annotation: Any) -> Any:
    if value is None or annotation in (Any, inspect.Parameter.empty):
        return value
    origin = get_origin(annotation)
    args = get_args(annotation)
    if origin in (Union, UnionType):
        options = [item for item in args if item is not type(None)]
        return _coerce_scalar(value, options[0]) if options else value
    if origin is list:
        values = value if isinstance(value, list) else [value]
        item_type = args[0] if args else Any
        return [_coerce_scalar(item, item_type) for item in values]
    if annotation is bool:
        return value if isinstance(value, bool) else str(value).strip().lower() in {"1", "true", "yes", "on"}
    if annotation in (str, int, float):
        return annotation(value)
    return value


def _body_value(body: Any, annotation: Any) -> Any:
    if annotation in (Any, inspect.Parameter.empty) or body is None:
        return body
    if isinstance(annotation, type) and hasattr(annotation, "model_validate"):
        return annotation.model_validate(body)
    if isinstance(annotation, type) and hasattr(annotation, "parse_obj"):
        return annotation.parse_obj(body)
    return body


def _resolve_callable(
    callable_: Any,
    *,
    app: Any,
    path: str,
    path_values: dict[str, str],
    query: dict[str, Any],
    headers: dict[str, str],
    body: Any,
    body_available: bool,
) -> tuple[Any, list[Generator[Any, None, None]]]:
    signature = inspect.signature(callable_)
    try:
        hints = get_type_hints(callable_)
    except Exception:
        hints = {}
    kwargs: dict[str, Any] = {}
    generators: list[Generator[Any, None, None]] = []

    for name, parameter in signature.parameters.items():
        annotation = hints.get(name, parameter.annotation)
        default = parameter.default
        if isinstance(default, Dependency):
            value, nested_generators = _resolve_callable(
                default.callable,
                app=app,
                path=path,
                path_values=path_values,
                query=query,
                headers=headers,
                body=body,
                body_available=False,
            )
            generators.extend(nested_generators)
            if inspect.isgenerator(value):
                generator = value
                value = next(generator)
                generators.append(generator)
            kwargs[name] = value
            continue
        if annotation is Request or name == "request":
            kwargs[name] = Request(app=app, path=path, headers=headers, query=query)
            continue
        if name in path_values:
            kwargs[name] = _coerce_scalar(path_values[name], annotation)
            continue
        if isinstance(default, Parameter):
            source_name = (default.alias or name).replace("_", "-").lower()
            header_value = next((value for key, value in headers.items() if key.lower() == source_name), None)
            raw = header_value if header_value is not None else query.get(default.alias or name, default.default)
            if raw is None and default.required:
                raise HTTPException(status_code=422, detail=f"Missing required value: {default.alias or name}.")
            kwargs[name] = _coerce_scalar(raw, annotation)
            continue
        if name in query:
            kwargs[name] = _coerce_scalar(query[name], annotation)
            continue
        if body_available and body is not None:
            kwargs[name] = _body_value(body, annotation)
            body_available = False
            continue
        if default is not inspect.Parameter.empty:
            kwargs[name] = default
            continue
        raise HTTPException(status_code=422, detail=f"Missing required value: {name}.")

    result = callable_(**kwargs)
    return result, generators


def _json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_value(item) for item in value]
    if hasattr(value, "model_dump"):
        return _json_value(value.model_dump())
    if hasattr(value, "dict"):
        return _json_value(value.dict())
    return str(value)


def _response_envelope(result: Any) -> dict[str, Any]:
    if isinstance(result, FileResponse):
        return {
            "status": result.status_code,
            "kind": "file",
            "path": result.path,
            "filename": result.filename,
            "mediaType": result.media_type,
            "headers": result.headers,
        }
    if isinstance(result, Response):
        content = result.content
        if not isinstance(content, (str, bytes, bytearray, dict, list, tuple, type(None))):
            content = b"".join(content)
        if isinstance(content, (bytes, bytearray)):
            return {
                "status": result.status_code,
                "kind": "binary",
                "bytes": list(content),
                "mediaType": result.media_type,
                "headers": result.headers,
            }
        return {
            "status": result.status_code,
            "kind": "json",
            "data": _json_value(content),
            "headers": result.headers,
        }
    return {"status": 200, "kind": "json", "data": _json_value(result), "headers": {}}


def dispatch_request(request: dict[str, Any]) -> dict[str, Any]:
    global _STARTED

    from portal.app.registry import app

    if not _STARTED:
        for handler in app.startup_handlers:
            handler()
        _STARTED = True

    method = str(request.get("method") or "GET").upper()
    path = str(request.get("path") or "/")
    query = request.get("query") if isinstance(request.get("query"), dict) else {}
    headers = request.get("headers") if isinstance(request.get("headers"), dict) else {}
    body = request.get("body")
    generators: list[Generator[Any, None, None]] = []

    try:
        route, path_values = _find_route(method, path)
        result, generators = _resolve_callable(
            route.endpoint,
            app=app,
            path=path,
            path_values=path_values,
            query=query,
            headers=headers,
            body=body,
            body_available=True,
        )
        if inspect.isawaitable(result):
            raise RuntimeError("Async local commands are not supported by this worker yet.")
        return _response_envelope(result)
    except HTTPException as error:
        return {
            "status": error.status_code,
            "kind": "error",
            "error": _json_value(error.detail),
            "headers": error.headers,
        }
    finally:
        for generator in reversed(generators):
            try:
                generator.close()
            except Exception:
                pass
