from __future__ import annotations

import importlib
import re
import sys
from pathlib import Path


ENV_FILE = Path(__file__).resolve().parents[2] / "environment.yml"

IMPORT_NAMES = {
    "python": None,
    "pip": "pip",
    "fastapi": "fastapi",
    "uvicorn": "uvicorn",
    "sqlalchemy": "sqlalchemy",
    "alembic": "alembic",
    "pydantic-settings": "pydantic_settings",
    "python-dotenv": "dotenv",
    "pytest": "pytest",
    "httpx": "httpx",
    "python-multipart": "multipart",
    "email-validator": "email_validator",
    "pandas": "pandas",
    "openpyxl": "openpyxl",
    "xlrd": "xlrd",
    "duckdb": "duckdb",
    "pyarrow": "pyarrow",
    "geopandas": "geopandas",
    "pyogrio": "pyogrio",
    "geojson": "geojson",
    "rasterio": "rasterio",
    "rioxarray": "rioxarray",
    "xarray": "xarray",
    "pyodbc": "pyodbc",
}


def read_dependencies(path: Path) -> list[str]:
    dependencies: list[str] = []
    in_dependencies = False

    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()

        if not stripped or stripped.startswith("#"):
            continue

        if stripped == "dependencies:":
            in_dependencies = True
            continue

        if not in_dependencies:
            continue

        if not line.startswith((" ", "\t")):
            break

        if not stripped.startswith("- "):
            continue

        dependency = stripped[2:].split(" #", 1)[0].strip().strip("\"'")
        if dependency.endswith(":"):
            continue

        dependencies.append(dependency)

    return dependencies


def package_name(dependency: str) -> str:
    dependency = dependency.strip().strip("\"'")
    dependency = dependency.split("[", 1)[0]
    return re.split(r"[<>=!~]", dependency, maxsplit=1)[0].strip()


def version_text(module: object) -> str:
    version = getattr(module, "__version__", None) or getattr(module, "version", None)
    return f" ({version})" if version else ""


def check_python(dependency: str) -> tuple[bool, str]:
    match = re.search(r"=([0-9]+)(?:\.([0-9]+))?", dependency)
    current = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"

    if not match:
        return True, f"OK  python -> {current}"

    expected_major = int(match.group(1))
    expected_minor = int(match.group(2)) if match.group(2) else None
    major_ok = sys.version_info.major == expected_major
    minor_ok = expected_minor is None or sys.version_info.minor == expected_minor

    if major_ok and minor_ok:
        return True, f"OK  python -> {current}"

    expected = f"{expected_major}.{expected_minor}" if expected_minor is not None else str(expected_major)
    return False, f"FAIL python -> expected {expected}, got {current}"


def check_import(dependency: str) -> tuple[bool, str]:
    name = package_name(dependency)

    if name == "python":
        return check_python(dependency)

    import_name = IMPORT_NAMES.get(name, name.replace("-", "_"))

    try:
        module = importlib.import_module(import_name)
    except Exception as exc:
        return False, f"FAIL {name} -> import {import_name!r} failed: {exc}"

    return True, f"OK  {name} -> import {import_name}{version_text(module)}"


def main() -> int:
    if not ENV_FILE.exists():
        print(f"FAIL environment file not found: {ENV_FILE}")
        return 1

    dependencies = read_dependencies(ENV_FILE)
    if not dependencies:
        print(f"FAIL no dependencies found in {ENV_FILE}")
        return 1

    print(f"Checking {len(dependencies)} dependencies from {ENV_FILE.name}")
    print(f"Python executable: {sys.executable}")
    print()

    failures = 0
    for dependency in dependencies:
        ok, message = check_import(dependency)
        print(message)
        failures += 0 if ok else 1

    print()
    if failures:
        print(f"Environment check failed: {failures} issue(s)")
        return 1

    print("Environment check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

