from __future__ import annotations

from pathlib import Path

PORTAL_PACKAGE_ROOT = Path(__file__).resolve().parents[2]
SOURCE_PROJECT_ROOT = Path(__file__).resolve().parents[4]
SOURCE_LAYOUT = (SOURCE_PROJECT_ROOT / "ui").is_dir()
PROJECT_ROOT = SOURCE_PROJECT_ROOT if SOURCE_LAYOUT else PORTAL_PACKAGE_ROOT
PYTHON_ROOT = SOURCE_PROJECT_ROOT / "python" if SOURCE_LAYOUT else PORTAL_PACKAGE_ROOT.parent
