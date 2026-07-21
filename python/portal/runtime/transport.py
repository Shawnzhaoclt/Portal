from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterable


@dataclass(frozen=True)
class Parameter:
    default: Any = None
    alias: str | None = None
    required: bool = False


@dataclass(frozen=True)
class Dependency:
    callable: Callable[..., Any]


def Query(default: Any = None, *_: Any, alias: str | None = None, **__: Any) -> Parameter:
    return Parameter(default=None if default is ... else default, alias=alias, required=default is ...)


def Header(default: Any = None, *_: Any, alias: str | None = None, **__: Any) -> Parameter:
    return Parameter(default=None if default is ... else default, alias=alias, required=default is ...)


def Depends(callable_: Callable[..., Any]) -> Dependency:
    return Dependency(callable_)


class HTTPException(Exception):
    def __init__(self, status_code: int, detail: Any, headers: dict[str, str] | None = None) -> None:
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail
        self.headers = headers or {}


@dataclass
class Route:
    method: str
    path: str
    endpoint: Callable[..., Any]
    name: str

    @property
    def methods(self) -> set[str]:
        return {self.method}


class APIRouter:
    def __init__(self, *, prefix: str = "", **_: Any) -> None:
        self.prefix = prefix.rstrip("/")
        self.routes: list[Route] = []

    def _route(self, method: str, path: str, **_: Any) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def decorator(endpoint: Callable[..., Any]) -> Callable[..., Any]:
            route_path = f"{self.prefix}{path}" or "/"
            self.routes.append(Route(method, route_path, endpoint, endpoint.__name__))
            return endpoint

        return decorator

    def get(self, path: str, **kwargs: Any):
        return self._route("GET", path, **kwargs)

    def post(self, path: str, **kwargs: Any):
        return self._route("POST", path, **kwargs)

    def put(self, path: str, **kwargs: Any):
        return self._route("PUT", path, **kwargs)

    def patch(self, path: str, **kwargs: Any):
        return self._route("PATCH", path, **kwargs)

    def delete(self, path: str, **kwargs: Any):
        return self._route("DELETE", path, **kwargs)

    def head(self, path: str, **kwargs: Any):
        return self._route("HEAD", path, **kwargs)

    def include_router(self, router: "APIRouter", *, prefix: str = "", **_: Any) -> None:
        include_prefix = prefix.rstrip("/")
        for route in router.routes:
            self.routes.append(
                Route(route.method, f"{self.prefix}{include_prefix}{route.path}" or "/", route.endpoint, route.name)
            )


class LocalApplication(APIRouter):
    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.router = self
        self.startup_handlers: list[Callable[..., Any]] = []
        self.state = SimpleNamespace()

    def on_event(self, event: str):
        def decorator(handler: Callable[..., Any]) -> Callable[..., Any]:
            if event == "startup":
                self.startup_handlers.append(handler)
            return handler

        return decorator

class URL:
    def __init__(self, value: str) -> None:
        self._value = value

    def __str__(self) -> str:
        return self._value


class Request:
    def __init__(
        self,
        *,
        app: LocalApplication,
        path: str,
        headers: dict[str, str] | None = None,
        query: dict[str, Any] | None = None,
    ) -> None:
        self.app = app
        self.headers = {str(key).lower(): str(value) for key, value in (headers or {}).items()}
        self.query_params = query or {}
        self.url = URL(f"tauri://localhost{path}")
        self.base_url = URL("tauri://localhost/")


@dataclass
class Response:
    content: Any = b""
    status_code: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    media_type: str | None = None


class JSONResponse(Response):
    def __init__(self, content: Any, status_code: int = 200, headers: dict[str, str] | None = None, **_: Any) -> None:
        super().__init__(content=content, status_code=status_code, headers=headers or {}, media_type="application/json")


class FileResponse(Response):
    def __init__(
        self,
        path: str | Path,
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        media_type: str | None = None,
        filename: str | None = None,
        **_: Any,
    ) -> None:
        super().__init__(content=b"", status_code=status_code, headers=headers or {}, media_type=media_type)
        self.path = str(path)
        self.filename = filename


class StreamingResponse(Response):
    def __init__(
        self,
        content: Iterable[bytes],
        status_code: int = 200,
        headers: dict[str, str] | None = None,
        media_type: str | None = None,
        **_: Any,
    ) -> None:
        super().__init__(content=content, status_code=status_code, headers=headers or {}, media_type=media_type)
