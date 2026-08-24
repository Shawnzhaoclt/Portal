from __future__ import annotations

import mimetypes
import os
import re
import struct
from functools import lru_cache
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import duckdb

from pydantic import BaseModel, Field

from portal.runtime.transport import APIRouter, Depends, FileResponse, HTTPException, Query

from portal.app.core.records import clean_record
from portal.app.dashboards.amteam import user_observations
from portal.app.management.models import User
from portal.app.management.router import get_current_user
from portal.app.sync.errors import RevisionChanged, SyncError
from portal.app.sync.models import Identity
from portal.app.sync.physical_entities import MLO_ENTITY_TYPE
from portal.app.sync.runtime import current_coordinator

router = APIRouter(prefix="/api/amteam", tags=["am-team"])

PIPE_TABLE = "ML"
INSPECTION_TABLE = "MLI"
OBSERVATION_TABLE = "ITPipes_Defects_Merged_PT_With_Source_Distance"
EXCLUDED_OBSERVATION_TEXT = ("Access", "Vermin", "Misc")
SNAPSHOT_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".wmv"}
REPORT_EXTENSIONS = {".pdf"}
MP4_CONTAINER_BOXES = {b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts"}

ColumnMap = dict[str, str]


def normalized_column_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def configured_database_path(environment_name: str, label: str) -> Path:
    configured = str(os.getenv(environment_name) or "").strip()
    if not configured:
        raise HTTPException(status_code=503, detail=f"{label} is not configured in portal.settings.json.")
    database = Path(configured).expanduser()
    if not database.is_file():
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"Configured {label} file was not found.",
                "database": str(database),
            },
        )
    return database


def amteam_database_path() -> Path:
    return configured_database_path("PORTAL_ITPIPES_DUCKDB", "ITPipes production DuckDB")


def amteam_merged_database_path() -> Path:
    return configured_database_path("PORTAL_ITPIPES_MERGED_DUCKDB", "ITPipes merged-defects DuckDB")


def quote_sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def amteam_media_root() -> Path:
    configured = str(os.getenv("PORTAL_AMTEAM_MEDIA_ROOT") or "").strip()
    if not configured:
        raise HTTPException(status_code=503, detail="ITPipes media root is not configured in portal.settings.json.")
    return Path(configured)


def connect_amteam_database() -> duckdb.DuckDBPyConnection:
    database = amteam_database_path()
    merged_database = amteam_merged_database_path()
    try:
        connection = duckdb.connect()
        connection.execute(f"ATTACH {quote_sql_literal(str(database))} AS itpipes_source (READ_ONLY)")
        connection.execute(f"ATTACH {quote_sql_literal(str(merged_database))} AS itpipes_merged (READ_ONLY)")
        connection.execute('create temp view "ML" as select * from itpipes_source.ML')
        connection.execute('create temp view "MLI" as select * from itpipes_source.MLI')
        connection.execute('create temp view "MLO_Media" as select * from itpipes_source.MLO_Media')
        connection.execute(
            '''
            create temp view "ITPipes_Defects_Merged_PT" as
            select observation.*, media.Media_ID
            from itpipes_merged.ITPipes_Defects_Merged_PT as observation
            left join (
                select MLO_ID, min(Media_ID) as Media_ID
                from itpipes_source.MLO_Media
                group by MLO_ID
            ) as media
              on media.MLO_ID = try_cast(observation.MLO_ID as bigint)
            '''
        )
        # The risk-scoring merge overwrites Distance with MAX_CL_POINT_DISTANCE
        # (a computed distance to the worst-scoring consequence location) for
        # defects that have one, which is unrelated to where the observation
        # actually sits along the pipe. Observation distance must reflect the
        # original inspection reading, so pull it back from the source MLO
        # table rather than trusting the merged copy.
        connection.execute(
            '''
            create temp view "ITPipes_Defects_Merged_PT_With_Source_Distance" as
            select
                observation.* exclude ("Distance"),
                source_mlo."Distance" as "Distance"
            from "ITPipes_Defects_Merged_PT" as observation
            left join itpipes_source.MLO as source_mlo
              on source_mlo.MLO_ID = try_cast(observation.MLO_ID as bigint)
            '''
        )
        return connection
    except (duckdb.Error, OSError) as error:
        raise HTTPException(
            status_code=503,
            detail={
                "message": "Could not open the configured ITPipes DuckDB datasource.",
                "database": str(database),
                "merged_database": str(merged_database),
                "error": str(error),
            },
        ) from error


def fetch_dicts(
    connection: duckdb.DuckDBPyConnection,
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
) -> list[dict[str, Any]]:
    cursor = connection.execute(sql, params or [])
    columns = [column[0] for column in cursor.description]
    return [clean_record(dict(zip(columns, row))) for row in cursor.fetchall()]


def fetch_one(
    connection: duckdb.DuckDBPyConnection,
    sql: str,
    params: list[Any] | tuple[Any, ...] | None = None,
) -> dict[str, Any]:
    rows = fetch_dicts(connection, sql, params)
    return rows[0] if rows else {}


def table_columns(connection: duckdb.DuckDBPyConnection, table_name: str) -> list[dict[str, Any]]:
    return fetch_dicts(
        connection,
        """
        select column_name as name, data_type, ordinal_position
        from information_schema.columns
        where lower(table_name) = lower(?)
        order by ordinal_position
        """,
        [table_name],
    )


def available_column_lookup(connection: duckdb.DuckDBPyConnection, table_name: str) -> dict[str, str]:
    columns = table_columns(connection, table_name)
    return {normalized_column_key(str(column["name"])): str(column["name"]) for column in columns}


def resolve_column(lookup: dict[str, str], candidates: tuple[str, ...], label: str) -> str:
    for candidate in candidates:
        column = lookup.get(normalized_column_key(candidate))
        if column:
            return column
    raise HTTPException(
        status_code=503,
        detail={
            "message": "AM Team DuckDB table is missing an expected column.",
            "column": label,
            "candidates": list(candidates),
        },
    )


def optional_column(lookup: dict[str, str], candidates: tuple[str, ...]) -> str | None:
    for candidate in candidates:
        column = lookup.get(normalized_column_key(candidate))
        if column:
            return column
    return None


def select_expression(column: str | None, alias: str) -> str:
    if not column:
        return f"null as {quote_identifier(alias)}"
    return f"{quote_identifier(column)} as {quote_identifier(alias)}"


def qualified_select_expression(table_alias: str, column: str | None, alias: str) -> str:
    if not column:
        return f"null as {quote_identifier(alias)}"
    return f"{table_alias}.{quote_identifier(column)} as {quote_identifier(alias)}"


def table_reference(table_name: str) -> str:
    return quote_identifier(table_name)


def text_expression(table_alias: str, column: str) -> str:
    prefix = f"{table_alias}." if table_alias else ""
    return f"coalesce(cast({prefix}{quote_identifier(column)} as varchar), '')"


def pipe_search_where(
    table_alias: str,
    project_column: str,
    street_column: str,
    query: str,
) -> tuple[str, list[Any]]:
    project_text = text_expression(table_alias, project_column)
    street_text = text_expression(table_alias, street_column)
    normalized_project = f"regexp_replace(lower({project_text}), '[^a-z0-9]', '', 'g')"
    normalized_street = f"regexp_replace(lower({street_text}), '[^a-z0-9]', '', 'g')"
    like_value = f"%{query}%"
    normalized_query = normalized_column_key(query)
    match_parts = [
        f"lower({project_text}) like lower(?)",
        f"lower({street_text}) like lower(?)",
    ]
    params: list[Any] = [like_value, like_value]
    if normalized_query:
        normalized_like = f"%{normalized_query}%"
        match_parts.extend([
            f"{normalized_project} like ?",
            f"{normalized_street} like ?",
        ])
        params.extend([normalized_like, normalized_like])
    if len(normalized_query) >= 3:
        threshold = 0.82 if len(normalized_query) >= 5 else 0.9
        match_parts.extend([
            f"jaro_winkler_similarity(lower({project_text}), lower(?)) >= ?",
            f"jaro_winkler_similarity(lower({street_text}), lower(?)) >= ?",
        ])
        params.extend([query, threshold, query, threshold])
    return f"({' or '.join(match_parts)})", params


def exact_pipe_search_where(
    table_alias: str,
    project_column: str,
    street_column: str,
    query: str,
    kind: str | None,
) -> tuple[str, list[Any]]:
    project_text = text_expression(table_alias, project_column)
    street_text = text_expression(table_alias, street_column)
    normalized_kind = normalized_column_key(kind or "")
    exact_project = f"lower(trim({project_text})) = lower(trim(?))"
    exact_street = f"lower(trim({street_text})) = lower(trim(?))"
    if normalized_kind in {"projecttitle", "project"}:
        return exact_project, [query]
    if normalized_kind in {"address", "street"}:
        return exact_street, [query]
    return f"({exact_project} or {exact_street})", [query, query]


def media_path_from_value(value: Any) -> Path | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text.lower().startswith(("http://", "https://")):
        return None
    path = Path(text)
    if path.is_absolute():
        return path
    return amteam_database_path().parent / path


def image_available(value: Any) -> bool:
    path = media_path_from_value(value)
    if path is None or not path.exists() or not path.is_file():
        return False
    media_type, _ = mimetypes.guess_type(path)
    return media_type is None or media_type.startswith("image/")


def compact_structure_id(value: Any) -> str:
    return re.sub(r"\s+", "", str(value or "").strip())


def inspection_date_prefix(value: Any) -> str:
    if isinstance(value, datetime):
        return value.strftime("%Y.%m.%d")
    if isinstance(value, date):
        return value.strftime("%Y.%m.%d")

    text = str(value or "").strip()
    if not text:
        return ""

    iso_match = re.match(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text)
    if iso_match:
        year, month, day = iso_match.groups()
        return f"{year}.{month.zfill(2)}.{day.zfill(2)}"

    us_match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})", text)
    if us_match:
        month, day, year = us_match.groups()
        return f"{year}.{month.zfill(2)}.{day.zfill(2)}"

    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).strftime("%Y.%m.%d")
    except ValueError:
        return ""


def media_subdirectory(parent: Path, name: str) -> Path | None:
    if not parent.exists() or not parent.is_dir():
        return None
    for child in parent.iterdir():
        if child.is_dir() and child.name.lower() == name.lower():
            return child
    return None


def files_with_extensions(directory: Path | None, extensions: set[str]) -> list[Path]:
    if directory is None or not directory.exists() or not directory.is_dir():
        return []
    return sorted(
        (path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in extensions),
        key=lambda path: path.name.lower(),
    )


def read_uint32_be(file_obj: Any) -> int:
    data = file_obj.read(4)
    if len(data) != 4:
        raise EOFError("Unexpected end of MP4 metadata.")
    return struct.unpack(">I", data)[0]


def read_uint64_be(file_obj: Any) -> int:
    data = file_obj.read(8)
    if len(data) != 8:
        raise EOFError("Unexpected end of MP4 metadata.")
    return struct.unpack(">Q", data)[0]


def iter_mp4_boxes(file_obj: Any, start: int, end: int, path: tuple[bytes, ...] = ()):
    file_obj.seek(start)
    while file_obj.tell() + 8 <= end:
        box_offset = file_obj.tell()
        size_bytes = file_obj.read(4)
        box_type = file_obj.read(4)
        if len(size_bytes) != 4 or len(box_type) != 4:
            break

        box_size = struct.unpack(">I", size_bytes)[0]
        header_size = 8
        if box_size == 1:
            try:
                box_size = read_uint64_be(file_obj)
            except EOFError:
                break
            header_size = 16
        elif box_size == 0:
            box_size = end - box_offset

        if box_size < header_size or box_offset + box_size > end:
            break

        data_start = box_offset + header_size
        data_end = box_offset + box_size
        box_path = (*path, box_type)
        yield box_offset, box_size, box_type, data_start, data_end, box_path

        if box_type in MP4_CONTAINER_BOXES:
            yield from iter_mp4_boxes(file_obj, data_start, data_end, box_path)

        file_obj.seek(data_end)


def mp4_video_metadata(path: Path) -> dict[str, Any]:
    if path.suffix.lower() != ".mp4":
        return {}

    try:
        file_size = path.stat().st_size
        with path.open("rb") as file_obj:
            boxes = list(iter_mp4_boxes(file_obj, 0, file_size))
            tracks = [box for box in boxes if box[2] == b"trak"]
            for track in tracks:
                _offset, _size, _type, _start, _end, track_path = track
                track_boxes = [box for box in boxes if box[5][:len(track_path)] == track_path]
                handler: bytes | None = None
                timescale: int | None = None
                duration: int | None = None
                sample_count = 0

                for _box_offset, _box_size, box_type, data_start, _data_end, _box_path in track_boxes:
                    if box_type == b"hdlr":
                        file_obj.seek(data_start)
                        file_obj.read(8)
                        handler = file_obj.read(4)
                    elif box_type == b"mdhd":
                        file_obj.seek(data_start)
                        version_data = file_obj.read(1)
                        if not version_data:
                            continue
                        version = version_data[0]
                        file_obj.read(3)
                        if version == 1:
                            file_obj.read(16)
                            timescale = read_uint32_be(file_obj)
                            duration = read_uint64_be(file_obj)
                        else:
                            file_obj.read(8)
                            timescale = read_uint32_be(file_obj)
                            duration = read_uint32_be(file_obj)
                    elif box_type == b"stts":
                        file_obj.seek(data_start)
                        file_obj.read(4)
                        entry_count = read_uint32_be(file_obj)
                        for _entry_index in range(entry_count):
                            sample_count += read_uint32_be(file_obj)
                            file_obj.read(4)

                if handler == b"vide" and timescale and duration:
                    duration_seconds = duration / timescale
                    fps = sample_count / duration_seconds if sample_count and duration_seconds > 0 else None
                    return {
                        "duration_seconds": duration_seconds,
                        "frame_count": sample_count or None,
                        "fps": fps,
                    }
    except (OSError, EOFError, struct.error):
        return {}

    return {}


def media_url(path: Path) -> str:
    relative_path = media_relative_path(path)
    return f"/api/amteam/media?path={quote(relative_path, safe='/')}"


def media_relative_path(path: Path) -> str:
    """Return a media-root-relative path without resolving every network file."""
    root = amteam_media_root()
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        # Callers normally pass paths derived from the configured root. Keep a
        # defensive fallback for equivalent absolute paths with different forms.
        return path.absolute().relative_to(root.absolute()).as_posix()


def media_asset(path: Path, kind: str) -> dict[str, Any]:
    media_type, _ = mimetypes.guess_type(path)
    return {
        "name": path.name,
        "kind": kind,
        "relative_path": media_relative_path(path),
        "url": media_url(path),
        "media_type": media_type,
    }


def inspection_media_directory(us_mh: Any, ds_mh: Any, inspection_date: Any) -> tuple[Path | None, list[str], dict[str, Any]]:
    warnings: list[str] = []
    root = amteam_media_root()
    metadata = {
        "media_root": str(root),
        "pipe_folder": None,
        "inspection_folder": None,
        "date_prefix": inspection_date_prefix(inspection_date),
    }

    if not root.exists() or not root.is_dir():
        warnings.append(f"AM Team media root was not found: {root}")
        return None, warnings, metadata

    upstream = compact_structure_id(us_mh)
    downstream = compact_structure_id(ds_mh)
    if not upstream or not downstream:
        warnings.append("US_MH or DS_MH is missing, so the media folder cannot be resolved.")
        return None, warnings, metadata

    pipe_folder_names = [f"{upstream}{downstream}", f"{downstream}{upstream}"]
    pipe_folder = next((root / name for name in pipe_folder_names if (root / name).is_dir()), None)
    if pipe_folder is None:
        warnings.append(f"Pipe media folder was not found. Tried: {', '.join(pipe_folder_names)}")
        return None, warnings, metadata
    metadata["pipe_folder"] = str(pipe_folder)

    date_prefix = metadata["date_prefix"]
    if not date_prefix:
        warnings.append("Inspection date is missing or could not be parsed, so the inspection media folder cannot be resolved.")
        return None, warnings, metadata

    matches = sorted(
        (child for child in pipe_folder.iterdir() if child.is_dir() and child.name.startswith(str(date_prefix))),
        key=lambda path: path.name,
        reverse=True,
    )
    if not matches:
        warnings.append(f"No inspection media folder starts with {date_prefix} under {pipe_folder}.")
        return None, warnings, metadata

    metadata["inspection_folder"] = str(matches[0])
    return matches[0], warnings, metadata


@lru_cache(maxsize=256)
def _inspection_media_assets_cached(
    media_root: str,
    us_mh: str,
    ds_mh: str,
    inspection_date_text: str,
) -> dict[str, Any]:
    # The CCTV media folders are read-only while the desktop app is running.
    # Caching avoids repeated SMB directory enumeration for the same inspection.
    media_directory, warnings, metadata = inspection_media_directory(us_mh, ds_mh, inspection_date_text)
    snapshots_dir = media_subdirectory(media_directory, "SnapShots") if media_directory else None
    videos_dir = media_subdirectory(media_directory, "Videos") if media_directory else None
    reports_dir = media_subdirectory(media_directory, "Reports") if media_directory else None

    snapshots = [media_asset(path, "snapshot") for path in files_with_extensions(snapshots_dir, SNAPSHOT_EXTENSIONS)]
    videos = [media_asset(path, "video") for path in files_with_extensions(videos_dir, VIDEO_EXTENSIONS)]
    reports = [media_asset(path, "report") for path in files_with_extensions(reports_dir, REPORT_EXTENSIONS)]

    if media_directory is not None:
        if snapshots_dir is None:
            warnings.append(f"SnapShots folder was not found under {media_directory}.")
        if videos_dir is None:
            warnings.append(f"Videos folder was not found under {media_directory}.")
        if reports_dir is None:
            warnings.append(f"Reports folder was not found under {media_directory}.")

    return {
        **metadata,
        "snapshots": snapshots,
        "videos": videos,
        "reports": reports,
        "warnings": warnings,
    }


def inspection_media_assets(us_mh: Any, ds_mh: Any, inspection_date: Any) -> dict[str, Any]:
    return _inspection_media_assets_cached(
        str(amteam_media_root()),
        str(us_mh or ""),
        str(ds_mh or ""),
        str(inspection_date or ""),
    )


def normalized_file_token(value: Any) -> str:
    return normalized_column_key(str(value or ""))


def distance_file_tokens(value: Any) -> list[str]:
    text = str(value or "").strip()
    tokens: list[str] = []
    if text:
        tokens.append(text)

    try:
        number = float(text)
    except (TypeError, ValueError):
        number = None

    if number is not None:
        if number.is_integer():
            tokens.append(str(int(number)))
        tokens.append(f"{number:f}".rstrip("0").rstrip("."))

    return list(dict.fromkeys(token for token in tokens if token))


def snapshot_observation_prefixes(row: dict[str, Any], us_mh: Any, ds_mh: Any) -> list[str]:
    us = str(us_mh or "").strip()
    ds = str(ds_mh or "").strip()
    code = str(row.get("code") or "").strip()
    if not us or not ds or not code:
        return []

    prefixes = [
        f"{us}_{ds}_{code}_{distance}".casefold()
        for distance in distance_file_tokens(row.get("distance"))
    ]
    return [prefix for prefix in prefixes if prefix]


def snapshot_name_matches_observation_prefix(snapshot_name: str, prefix: str) -> bool:
    return snapshot_name.strip().casefold().startswith(prefix.strip().casefold())


def matching_snapshot_assets(
    row: dict[str, Any],
    snapshots: list[dict[str, Any]],
    us_mh: Any = None,
    ds_mh: Any = None,
) -> list[dict[str, Any]]:
    prefix_tokens = snapshot_observation_prefixes(row, us_mh, ds_mh)
    matches = []
    for snapshot in snapshots:
        snapshot_name = Path(str(snapshot.get("name") or "")).stem
        if snapshot_name and any(snapshot_name_matches_observation_prefix(snapshot_name, prefix) for prefix in prefix_tokens):
            matches.append(snapshot)
    if matches:
        return matches

    fallback_tokens = [
        normalized_file_token(row.get("media_id")),
        normalized_file_token(row.get("mlo_id")),
    ]
    fallback_tokens = [token for token in fallback_tokens if len(token) >= 2]
    if not fallback_tokens:
        return []

    for snapshot in snapshots:
        snapshot_name = normalized_file_token(Path(str(snapshot.get("name") or "")).stem)
        if snapshot_name and any(token in snapshot_name for token in fallback_tokens):
            matches.append(snapshot)
    return matches


def dedupe_observation_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped_rows: list[dict[str, Any]] = []
    rows_by_mlo_id: dict[str, dict[str, Any]] = {}

    for row in rows:
        mlo_id = str(row.get("mlo_id") or "").strip()
        if not mlo_id:
            deduped_rows.append(row)
            continue

        existing_row = rows_by_mlo_id.get(mlo_id)
        if existing_row is None:
            rows_by_mlo_id[mlo_id] = row
            deduped_rows.append(row)
            continue

        for key in ("media_id", "full_path"):
            existing_value = existing_row.get(key)
            next_value = row.get(key)
            if (existing_value is None or existing_value == "") and next_value not in (None, ""):
                existing_row[key] = next_value

    return deduped_rows


def pipe_columns(lookup: dict[str, str]) -> dict[str, str | None]:
    return {
        "ml_id": resolve_column(lookup, ("ML_ID", "MLID"), "ML_ID"),
        "ml_name": optional_column(lookup, ("ML_Name", "MLNAME", "ML Name")),
        "project_title": resolve_column(lookup, ("ProjectTitle", "Project_Title", "Project Title"), "ProjectTitle"),
        "street": resolve_column(lookup, ("Street",), "Street"),
        "us_mh": optional_column(lookup, ("US_MH", "USMH", "US MH", "Upstream_MH", "Upstream MH")),
        "ds_mh": optional_column(lookup, ("DS_MH", "DSMH", "DS MH", "Downstream_MH", "Downstream MH")),
        "material": optional_column(lookup, ("Material",)),
        "pipe_shape": optional_column(lookup, ("Pipe_Shape", "Pipe Shape", "Shape")),
        "pipe_height": optional_column(lookup, ("Pipe_Height", "Pipe Height", "Height")),
    }


def inspection_columns(lookup: dict[str, str]) -> dict[str, str | None]:
    return {
        "ml_id": resolve_column(lookup, ("ML_ID", "MLID"), "ML_ID"),
        "mli_id": resolve_column(lookup, ("MLI_ID", "MLIID"), "MLI_ID"),
        "operator": optional_column(lookup, ("Operator",)),
        "inspection_date": optional_column(
            lookup,
            ("Inspection_Date", "Inspection Date", "InspectionDate", "Inspecation Date", "Inspecation_Date"),
        ),
        "reason_of_inspection": optional_column(
            lookup,
            ("Reason_of_inspection", "Reason of inspection", "Reason_for_inspection", "Reason"),
        ),
        "inspection_direction": optional_column(
            lookup,
            ("Inspection_Direction", "Inspection Direction", "Inspecation_Direction", "Inspecation Direction"),
        ),
        "inspection_length": optional_column(
            lookup,
            ("Inspection_Length", "Inspection Length", "Inspected_Length", "Inspected Length", "Inspecation_Length", "Inspecation Length"),
        ),
        "inspection_status": optional_column(
            lookup,
            ("Inspection_status", "Inspection Status", "Inspecation_status", "Inspecation Status"),
        ),
        "current_status": optional_column(lookup, ("current_status", "Current_Status", "Current Status")),
    }


def observation_columns(lookup: dict[str, str]) -> dict[str, str | None]:
    return {
        "mlo_id": resolve_column(lookup, ("MLO_ID", "MLOID"), "MLO_ID"),
        "mli_id": resolve_column(lookup, ("MLI_ID", "MLIID"), "MLI_ID"),
        "distance": optional_column(lookup, ("distance", "Distance", "Dist")),
        "code": optional_column(lookup, ("code", "Code")),
        "observation_text": resolve_column(
            lookup,
            ("observation_text", "Observation_Text", "Observation Text", "Observation"),
            "observation_text",
        ),
        "grade": resolve_column(lookup, ("Grade",), "Grade"),
        "continuous": optional_column(lookup, ("Continuous",)),
        "joint": optional_column(lookup, ("Joint",)),
        "value_percent": optional_column(lookup, ("Value_Percent", "Value Percent", "ValuePercent")),
        "remarks": optional_column(lookup, ("Remarks",)),
        "clock_from": optional_column(lookup, ("Clock_From", "Clock From", "ClockFrom")),
        "clock_to": optional_column(lookup, ("Clock_To", "Clock To", "ClockTo")),
        "vcr_time": optional_column(lookup, ("VCR_Time", "VCR Time", "VCRTime")),
        "digital_time": optional_column(lookup, ("Digital_Time", "Digital Time", "DigitalTime")),
        "media_id": optional_column(lookup, ("Media_ID", "MediaID", "Media ID")),
        "full_path": optional_column(lookup, ("full_path", "Full_Path", "Full Path", "path")),
    }


def inspection_context(connection: duckdb.DuckDBPyConnection, mli_id: str) -> dict[str, Any]:
    pipe_lookup = available_column_lookup(connection, PIPE_TABLE)
    inspection_lookup = available_column_lookup(connection, INSPECTION_TABLE)
    pipe_cols = pipe_columns(pipe_lookup)
    inspection_cols = inspection_columns(inspection_lookup)

    inspection_ml_id = str(inspection_cols["ml_id"])
    inspection_mli_id = str(inspection_cols["mli_id"])
    pipe_ml_id = str(pipe_cols["ml_id"])
    select_sql = ", ".join(
        [
            qualified_select_expression("i", inspection_cols.get("inspection_date"), "inspection_date"),
            qualified_select_expression("p", pipe_cols.get("us_mh"), "us_mh"),
            qualified_select_expression("p", pipe_cols.get("ds_mh"), "ds_mh"),
        ]
    )
    return fetch_one(
        connection,
        f"""
        select {select_sql}
        from {table_reference(INSPECTION_TABLE)} as i
        inner join {table_reference(PIPE_TABLE)} as p
          on i.{quote_identifier(inspection_ml_id)} = p.{quote_identifier(pipe_ml_id)}
        where i.{quote_identifier(inspection_mli_id)} = ?
        limit 1
        """,
        [mli_id],
    )


@router.get("/source")
def amteam_source() -> dict[str, Any]:
    connection = connect_amteam_database()
    try:
        tables = {}
        for table_name in (PIPE_TABLE, INSPECTION_TABLE, OBSERVATION_TABLE):
            count = fetch_one(connection, f"select count(*) as row_count from {table_reference(table_name)}").get("row_count")
            tables[table_name] = {
                "row_count": count,
                "columns": table_columns(connection, table_name),
            }
        return {
            "database": str(amteam_database_path()),
            "merged_defects_database": str(amteam_merged_database_path()),
            "tables": tables,
        }
    finally:
        connection.close()


@router.get("/pipes")
def search_pipes(
    search: str = Query(default="", min_length=0),
    limit: int = Query(default=25, ge=1, le=100),
) -> dict[str, Any]:
    query = search.strip()
    if not query:
        return {"query": query, "rows": []}

    connection = connect_amteam_database()
    try:
        columns = pipe_columns(available_column_lookup(connection, PIPE_TABLE))
        select_sql = ", ".join(select_expression(column, alias) for alias, column in columns.items())
        project_column = str(columns["project_title"])
        street_column = str(columns["street"])
        ml_id_column = str(columns["ml_id"])
        where_sql, where_params = pipe_search_where("", project_column, street_column, query)
        rows = fetch_dicts(
            connection,
            f"""
            select {select_sql}
            from {table_reference(PIPE_TABLE)}
            where {where_sql}
            order by
              {quote_identifier(project_column)} nulls last,
              {quote_identifier(street_column)} nulls last,
              try_cast({quote_identifier(ml_id_column)} as bigint) nulls last
            limit ?
            """,
            [*where_params, limit],
        )
        return {"query": query, "rows": rows}
    finally:
        connection.close()


@router.get("/inspection-search")
def search_inspections(
    search: str = Query(default="", min_length=0),
    limit: int = Query(default=250, ge=1, le=1000),
) -> dict[str, Any]:
    query = search.strip()
    if not query:
        return {"query": query, "pipe_count": 0, "rows": []}

    connection = connect_amteam_database()
    try:
        pipe_lookup = available_column_lookup(connection, PIPE_TABLE)
        inspection_lookup = available_column_lookup(connection, INSPECTION_TABLE)
        pipe_cols = pipe_columns(pipe_lookup)
        inspection_cols = inspection_columns(inspection_lookup)

        inspection_selects = [
            qualified_select_expression("i", column, alias)
            for alias, column in inspection_cols.items()
        ]
        pipe_selects = [
            qualified_select_expression("p", pipe_cols.get(alias), alias)
            for alias in ("ml_name", "project_title", "street", "us_mh", "ds_mh", "material", "pipe_shape", "pipe_height")
        ]
        select_sql = ", ".join([*inspection_selects, *pipe_selects])

        pipe_ml_id = str(pipe_cols["ml_id"])
        inspection_ml_id = str(inspection_cols["ml_id"])
        project_column = str(pipe_cols["project_title"])
        street_column = str(pipe_cols["street"])
        mli_id_column = str(inspection_cols["mli_id"])

        where_sql, where_params = pipe_search_where("p", project_column, street_column, query)

        pipe_count = fetch_one(
            connection,
            f"""
            select count(distinct cast(p.{quote_identifier(pipe_ml_id)} as varchar)) as pipe_count
            from {table_reference(PIPE_TABLE)} as p
            where {where_sql}
            """,
            where_params,
        ).get("pipe_count", 0)

        order_terms = [
            f"p.{quote_identifier(project_column)} nulls last",
            f"p.{quote_identifier(street_column)} nulls last",
        ]
        if inspection_cols.get("inspection_date"):
            order_terms.append(f"try_cast(i.{quote_identifier(str(inspection_cols['inspection_date']))} as timestamp) desc nulls last")
        order_terms.append(f"try_cast(i.{quote_identifier(mli_id_column)} as bigint) desc nulls last")

        rows = fetch_dicts(
            connection,
            f"""
            select {select_sql}
            from {table_reference(INSPECTION_TABLE)} as i
            inner join {table_reference(PIPE_TABLE)} as p
              on cast(i.{quote_identifier(inspection_ml_id)} as varchar) = cast(p.{quote_identifier(pipe_ml_id)} as varchar)
            where {where_sql}
            order by {", ".join(order_terms)}
            limit ?
            """,
            [*where_params, limit],
        )
        return {"query": query, "pipe_count": pipe_count, "rows": rows}
    finally:
        connection.close()


@router.get("/pipe-groups")
def search_pipe_groups(
    search: str = Query(default="", min_length=0),
    kind: str | None = Query(default=None),
    pipe_limit: int = Query(default=250, ge=1, le=1000),
) -> dict[str, Any]:
    query = search.strip()
    if not query:
        return {"query": query, "kind": kind, "rows": []}

    connection = connect_amteam_database()
    try:
        pipe_lookup = available_column_lookup(connection, PIPE_TABLE)
        inspection_lookup = available_column_lookup(connection, INSPECTION_TABLE)
        pipe_cols = pipe_columns(pipe_lookup)
        inspection_cols = inspection_columns(inspection_lookup)

        pipe_select_sql = ", ".join(select_expression(column, alias) for alias, column in pipe_cols.items())
        pipe_ml_id = str(pipe_cols["ml_id"])
        project_column = str(pipe_cols["project_title"])
        street_column = str(pipe_cols["street"])
        pipe_where_sql, pipe_where_params = exact_pipe_search_where("", project_column, street_column, query, kind)

        pipe_rows = fetch_dicts(
            connection,
            f"""
            select {pipe_select_sql}
            from {table_reference(PIPE_TABLE)}
            where {pipe_where_sql}
            order by
              {quote_identifier(project_column)} nulls last,
              {quote_identifier(street_column)} nulls last,
              try_cast({quote_identifier(pipe_ml_id)} as bigint) nulls last
            limit ?
            """,
            [*pipe_where_params, pipe_limit],
        )

        groups: list[dict[str, Any]] = []
        groups_by_ml_id: dict[str, dict[str, Any]] = {}
        for pipe in pipe_rows:
            ml_id = str(pipe.get("ml_id") or "").strip()
            if not ml_id or ml_id in groups_by_ml_id:
                continue
            group = {**pipe, "inspections": []}
            groups.append(group)
            groups_by_ml_id[ml_id] = group

        if not groups_by_ml_id:
            return {"query": query, "kind": kind, "rows": []}

        inspection_selects = [
            qualified_select_expression("i", column, alias)
            for alias, column in inspection_cols.items()
        ]
        pipe_selects = [
            qualified_select_expression("p", pipe_cols.get(alias), alias)
            for alias in ("ml_name", "project_title", "street", "us_mh", "ds_mh", "material", "pipe_shape", "pipe_height")
        ]
        inspection_select_sql = ", ".join([*inspection_selects, *pipe_selects])
        inspection_ml_id = str(inspection_cols["ml_id"])
        mli_id_column = str(inspection_cols["mli_id"])
        placeholders = ", ".join("?" for _ in groups_by_ml_id)
        order_terms = [f"try_cast(i.{quote_identifier(mli_id_column)} as bigint) desc nulls last"]
        if inspection_cols.get("inspection_date"):
            order_terms.insert(0, f"try_cast(i.{quote_identifier(str(inspection_cols['inspection_date']))} as timestamp) desc nulls last")

        inspection_rows = fetch_dicts(
            connection,
            f"""
            select {inspection_select_sql}
            from {table_reference(INSPECTION_TABLE)} as i
            inner join {table_reference(PIPE_TABLE)} as p
              on cast(i.{quote_identifier(inspection_ml_id)} as varchar) = cast(p.{quote_identifier(pipe_ml_id)} as varchar)
            where cast(i.{quote_identifier(inspection_ml_id)} as varchar) in ({placeholders})
            order by cast(i.{quote_identifier(inspection_ml_id)} as varchar), {", ".join(order_terms)}
            """,
            list(groups_by_ml_id),
        )

        seen_inspections: set[tuple[str, str]] = set()
        for inspection in inspection_rows:
            ml_id = str(inspection.get("ml_id") or "").strip()
            mli_id = str(inspection.get("mli_id") or "").strip()
            key = (ml_id, mli_id)
            group = groups_by_ml_id.get(ml_id)
            if group is None or key in seen_inspections:
                continue
            seen_inspections.add(key)
            group["inspections"].append(inspection)

        return {"query": query, "kind": kind, "rows": groups}
    finally:
        connection.close()


@router.get("/pipes/{ml_id}/inspections")
def pipe_inspections(
    ml_id: str,
    limit: int = Query(default=100, ge=1, le=500),
) -> dict[str, Any]:
    connection = connect_amteam_database()
    try:
        columns = inspection_columns(available_column_lookup(connection, INSPECTION_TABLE))
        select_sql = ", ".join(select_expression(column, alias) for alias, column in columns.items())
        ml_id_column = str(columns["ml_id"])
        mli_id_column = str(columns["mli_id"])
        order_terms = []
        if columns.get("inspection_date"):
            order_terms.append(f"try_cast({quote_identifier(str(columns['inspection_date']))} as timestamp) desc nulls last")
        order_terms.append(f"try_cast({quote_identifier(mli_id_column)} as bigint) desc nulls last")
        rows = fetch_dicts(
            connection,
            f"""
            select {select_sql}
            from {table_reference(INSPECTION_TABLE)}
            where cast({quote_identifier(ml_id_column)} as varchar) = ?
            order by {", ".join(order_terms)}
            limit ?
            """,
            [ml_id, limit],
        )
        return {"ml_id": ml_id, "rows": rows}
    finally:
        connection.close()


def inspection_observation_payload(
    connection: duckdb.DuckDBPyConnection,
    mli_id: str,
    *,
    limit: int,
    columns: ColumnMap | None = None,
    user_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Load one inspection using indexed keys and one reusable source connection."""
    context = inspection_context(connection, mli_id)
    media = inspection_media_assets(
        context.get("us_mh"),
        context.get("ds_mh"),
        context.get("inspection_date"),
    ) if context else {
        "media_root": str(amteam_media_root()),
        "pipe_folder": None,
        "inspection_folder": None,
        "date_prefix": None,
        "snapshots": [],
        "videos": [],
        "reports": [],
        "warnings": ["Inspection record was not found, so media could not be resolved."],
    }
    columns = columns or observation_columns(available_column_lookup(connection, OBSERVATION_TABLE))
    select_sql = ", ".join(select_expression(column, alias) for alias, column in columns.items())
    mli_id_column = str(columns["mli_id"])
    mlo_id_column = str(columns["mlo_id"])
    grade_column = str(columns["grade"])
    text_column = str(columns["observation_text"])
    exclusion_sql = " and ".join(
        f"lower(coalesce(cast({quote_identifier(text_column)} as varchar), '')) not like lower(?)" for _ in EXCLUDED_OBSERVATION_TEXT
    )
    rows = fetch_dicts(
        connection,
        f"""
        select {select_sql}
        from {table_reference(OBSERVATION_TABLE)}
        where {quote_identifier(mli_id_column)} = ?
          and {quote_identifier(grade_column)} is not null
          and {exclusion_sql}
        order by {quote_identifier(mlo_id_column)} asc
        limit ?
        """,
        [mli_id, *[f"%{pattern}%" for pattern in EXCLUDED_OBSERVATION_TEXT], limit],
    )
    rows = dedupe_observation_rows(rows)
    for row in rows:
        matched_snapshots = matching_snapshot_assets(
            row,
            media["snapshots"],
            context.get("us_mh") if context else None,
            context.get("ds_mh") if context else None,
        )
        row["image_urls"] = [snapshot["url"] for snapshot in matched_snapshots]
        row["image_available"] = len(matched_snapshots) > 0
        row["image_url"] = row["image_urls"][0] if row["image_urls"] else None
        row["origin"] = "itpipes"

    # Reviewer-added observations live in stormwater.db rather than the read-only source
    # cache, so they are merged here and ordered into the same distance sequence.
    rows.extend(user_rows or [])
    rows.sort(key=lambda item: (
        float(item.get("distance")) if isinstance(item.get("distance"), (int, float)) else 0.0,
        str(item.get("mlo_id") or ""),
    ))
    return {
        "mli_id": mli_id,
        "media": media,
        "rows": rows,
        # Lets the add-observation form reject an out-of-range distance before posting.
        "distance_limit": inspection_distance_limit(connection, mli_id),
    }


@router.get("/inspections/{mli_id}/observations")
def inspection_observations(
    mli_id: str,
    limit: int = Query(default=1000, ge=1, le=5000),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    user_rows = [
        user_observations.observation_row(values)
        for values in stored_user_observations(current_user, mli_id)
    ]
    connection = connect_amteam_database()
    try:
        return inspection_observation_payload(connection, mli_id, limit=limit, user_rows=user_rows)
    finally:
        connection.close()


@router.get("/inspections/observations")
def inspection_observations_batch(
    mli_id: list[str] | None = Query(default=None),
    limit: int = Query(default=1000, ge=1, le=5000),
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    requested_ids = list(dict.fromkeys(item.strip() for item in (mli_id or []) if item and item.strip()))
    if not requested_ids:
        return {"rows": {}}
    if len(requested_ids) > 500:
        raise HTTPException(status_code=422, detail="A maximum of 500 inspection IDs can be loaded at once.")

    user_rows_by_inspection = stored_user_observations_by_inspection(current_user)
    connection = connect_amteam_database()
    try:
        columns = observation_columns(available_column_lookup(connection, OBSERVATION_TABLE))
        return {
            "rows": {
                inspection_id: inspection_observation_payload(
                    connection,
                    inspection_id,
                    limit=limit,
                    columns=columns,
                    user_rows=user_rows_by_inspection.get(inspection_id, []),
                )
                for inspection_id in requested_ids
            }
        }
    finally:
        connection.close()


@router.get("/media")
def amteam_media(path: str = Query(..., min_length=1)):
    root = amteam_media_root().resolve()
    candidate = (root / path).resolve()
    if not candidate.is_relative_to(root):
        raise HTTPException(status_code=403, detail={"message": "Media path is outside the AM Team media root."})
    if not candidate.exists() or not candidate.is_file():
        raise HTTPException(status_code=404, detail={"message": "AM Team media file was not found.", "path": path})

    media_type, _ = mimetypes.guess_type(candidate)
    return FileResponse(candidate, media_type=media_type or "application/octet-stream", filename=candidate.name)


@router.get("/observations/{mlo_id}/media")
def observation_media(mlo_id: str):
    raise HTTPException(
        status_code=410,
        detail={
            "message": "Observation table media paths are no longer used. Use inspection media assets from /api/amteam/inspections/{mli_id}/observations.",
            "mlo_id": mlo_id,
        },
    )


# Reviewers work a shared inspection queue, so a handful of retries covers the few
# reviewers who can realistically be adding to one inspection at the same moment.
USER_OBSERVATION_COLLISION_RETRIES = 5


class UserObservationRequest(BaseModel):
    """One reviewer-added observation, limited to the fields the STM Risk ETL reads."""

    code: str = Field(min_length=1, max_length=32)
    observation_text: str = Field(min_length=1, max_length=255)
    distance: float = Field(ge=0)
    digital_time_seconds: float | None = Field(default=None, ge=0)
    grade: float | None = Field(default=None, ge=1, le=5)
    value_percent: float | None = Field(default=None, ge=0, le=100)
    clock_from: float | None = Field(default=None, ge=0, le=12)
    clock_to: float | None = Field(default=None, ge=0, le=12)
    joint: bool | None = None
    remarks: str | None = Field(default=None, max_length=500)
    # A continuous defect repeats the same defect at a second, further distance.
    continuous: bool = False
    finish_distance: float | None = Field(default=None, ge=0)
    finish_time_seconds: float | None = Field(default=None, ge=0)


def _amteam_coordinator(user: User):
    try:
        return current_coordinator(
            Identity(
                user_id=str(user.id),
                employee_number=str(user.employee_id or "").strip(),
                email=str(user.email),
            )
        )
    except SyncError as error:
        _amteam_sync_error(error)


def _amteam_sync_error(error: SyncError) -> None:
    raise HTTPException(
        status_code=503,
        detail={"code": error.code, "message": str(error), "details": error.details},
    )


def stored_user_observations(user: User, mli_id: str) -> list[dict[str, Any]]:
    """Return the reviewer-added MLO rows recorded against one inspection."""
    coordinator = _amteam_coordinator(user)
    entities = coordinator.query_entities(MLO_ENTITY_TYPE, filters={"MLI_ID": str(mli_id)})
    rows: list[dict[str, Any]] = []
    for entity in entities:
        if bool(entity.get("deleted")):
            continue
        values = entity.get("values")
        if isinstance(values, dict):
            rows.append(dict(values))
    return rows


def stored_user_observation_history(user: User, mli_id: str) -> list[dict[str, Any]]:
    """Every reviewer MLO row ever written for one inspection, deleted ones included.

    Deleting an observation leaves a tombstone under the same global identifier, so the
    identifier stays taken even though the row has left the review table. Allocation has
    to see those rows or it would reissue an identifier that cannot be inserted again.
    """
    coordinator = _amteam_coordinator(user)
    rows: list[dict[str, Any]] = []
    for entity in coordinator.query_entities(
        MLO_ENTITY_TYPE, filters={"MLI_ID": str(mli_id)}, include_deleted=True
    ):
        values = entity.get("values")
        if isinstance(values, dict):
            rows.append(dict(values))
    return rows


def stored_user_observations_by_inspection(user: User) -> dict[str, list[dict[str, Any]]]:
    """Group every reviewer-added observation by inspection in a single read."""
    coordinator = _amteam_coordinator(user)
    grouped: dict[str, list[dict[str, Any]]] = {}
    for entity in coordinator.query_entities(MLO_ENTITY_TYPE):
        if bool(entity.get("deleted")):
            continue
        values = entity.get("values")
        if not isinstance(values, dict):
            continue
        grouped.setdefault(str(values.get("MLI_ID") or ""), []).append(
            user_observations.observation_row(values)
        )
    return grouped


def source_continuous_values(connection: duckdb.DuckDBPyConnection, mli_id: str) -> list[str]:
    """Continuous markers already used by ITPipes on one inspection."""
    columns = observation_columns(available_column_lookup(connection, OBSERVATION_TABLE))
    continuous_column = columns.get("continuous")
    if not continuous_column:
        return []
    rows = fetch_dicts(
        connection,
        f"""
        select distinct cast({quote_identifier(str(continuous_column))} as varchar) as continuous
        from {table_reference(OBSERVATION_TABLE)}
        where {quote_identifier(str(columns["mli_id"]))} = ?
        """,
        [mli_id],
    )
    return [str(row.get("continuous") or "") for row in rows]


def inspection_distance_limit(
    connection: duckdb.DuckDBPyConnection, mli_id: str
) -> float | None:
    """Return how far along the pipe an observation may sit, or None when unknown.

    The inspected length is preferred over the inventory section length. Measured across
    the source data, the inspected length is present for 96% of inspections and only
    0.01% of real ITPipes observations exceed it, whereas the inventory length is present
    for 14% of pipes and 7.6% of observations already run past it, so treating the
    inventory figure as a hard bound would reject field data that is actually correct.
    The inventory length is kept only as a fallback when an inspection carries no length.
    """
    inspection_columns_lookup = inspection_columns(
        available_column_lookup(connection, INSPECTION_TABLE)
    )
    length_column = inspection_columns_lookup.get("inspection_length")
    pipe_columns_lookup = pipe_columns(available_column_lookup(connection, PIPE_TABLE))
    section_column = optional_column(
        available_column_lookup(connection, PIPE_TABLE),
        ("Section_Length", "Section Length", "SectionLength"),
    )

    selected = []
    if length_column:
        selected.append(
            f"try_cast(inspection.{quote_identifier(str(length_column))} as double) as inspected_length"
        )
    if section_column:
        selected.append(
            f"try_cast(pipe.{quote_identifier(str(section_column))} as double) as section_length"
        )
    if not selected:
        return None

    rows = fetch_dicts(
        connection,
        f"""
        select {', '.join(selected)}
        from {table_reference(INSPECTION_TABLE)} as inspection
        left join {table_reference(PIPE_TABLE)} as pipe
          on pipe.{quote_identifier(str(pipe_columns_lookup["ml_id"]))}
             = inspection.{quote_identifier(str(inspection_columns_lookup["ml_id"]))}
        where cast(inspection.{quote_identifier(str(inspection_columns_lookup["mli_id"]))} as varchar) = ?
        """,
        [str(mli_id)],
    )
    if not rows:
        return None

    for key in ("inspected_length", "section_length"):
        value = rows[0].get(key)
        if value is not None and float(value) > 0:
            return float(value)
    return None


@router.get("/inspections/{mli_id}/user-observations")
def list_user_observations(
    mli_id: str,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    rows = [
        user_observations.observation_row(values)
        for values in stored_user_observations(current_user, mli_id)
    ]
    rows.sort(key=lambda row: (float(row.get("distance") or 0), str(row.get("mlo_id") or "")))
    return {"mli_id": mli_id, "rows": rows}


@router.post("/inspections/{mli_id}/user-observations")
def create_user_observation(
    mli_id: str,
    payload: UserObservationRequest,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    if payload.continuous and payload.finish_distance is None:
        raise HTTPException(status_code=422, detail="A continuous defect needs a finish distance.")
    if payload.continuous and payload.finish_distance is not None and payload.finish_distance <= payload.distance:
        raise HTTPException(
            status_code=422,
            detail="The finish distance of a continuous defect must be greater than its start distance.",
        )
    # The camera only travels forward, so the finish cannot sit earlier in the video than
    # the start. Equal seconds are accepted because the position is stored whole-second
    # and a short defect can round both ends onto the same one.
    if (
        payload.continuous
        and payload.finish_time_seconds is not None
        and payload.digital_time_seconds is not None
        and payload.finish_time_seconds < payload.digital_time_seconds
    ):
        raise HTTPException(
            status_code=422,
            detail="The finish video time of a continuous defect cannot be before its start.",
        )

    connection = connect_amteam_database()
    try:
        distance_limit = inspection_distance_limit(connection, mli_id)
        source_continuous = source_continuous_values(connection, mli_id) if payload.continuous else []
    finally:
        connection.close()

    # An observation cannot sit beyond the end of what was inspected. Unknown lengths are
    # left unchecked rather than guessed at, so a missing length never blocks a review.
    if distance_limit is not None:
        furthest = max(
            payload.distance,
            payload.finish_distance if payload.continuous and payload.finish_distance is not None else payload.distance,
        )
        if furthest > distance_limit:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Distance {furthest:g} ft is beyond the inspected length of this pipe "
                    f"({distance_limit:g} ft)."
                ),
            )

    fields = {
        "Code": payload.code,
        "Observation_Text": payload.observation_text,
        "Grade": payload.grade,
        "Joint": payload.joint,
        "Value_Percent": payload.value_percent,
        "Remarks": payload.remarks,
        "Clock_From": payload.clock_from,
        "Clock_To": payload.clock_to,
    }

    # Identifiers are derived from what is already stored, so a reviewer who loses the
    # race for a sequence number re-reads and takes the next one instead of failing.
    coordinator = _amteam_coordinator(current_user)
    last_conflict: RevisionChanged | None = None
    for _attempt in range(USER_OBSERVATION_COLLISION_RETRIES):
        # Identifiers are allocated against every row ever written, including deleted
        # ones, because their tombstones still hold the identifier.
        sequence = user_observations.next_observation_sequence(
            stored_user_observation_history(current_user, mli_id), mli_id
        )

        continuous_sequence: int | None = None
        if payload.continuous:
            # Continuity markers carry no tombstone, so a number freed by a deletion is
            # genuinely available again and only the live rows matter here.
            used = list(source_continuous)
            used.extend(
                str(values.get("Continuous") or "")
                for values in stored_user_observations(current_user, mli_id)
            )
            continuous_sequence = user_observations.next_continuous_sequence(used)

        rows = user_observations.build_observation_mutations(
            mli_id=mli_id,
            fields=fields,
            start_distance=payload.distance,
            finish_distance=payload.finish_distance if payload.continuous else None,
            start_time_seconds=payload.digital_time_seconds,
            finish_time_seconds=payload.finish_time_seconds,
            sequence=sequence,
            continuous_sequence=continuous_sequence,
        )
        try:
            coordinator.commit(user_observations.insert_mutations(rows, mli_id))
        except RevisionChanged as error:
            # Another reviewer took this identifier between the read and the commit.
            last_conflict = error
            continue
        except SyncError as error:
            _amteam_sync_error(error)

        return {
            "mli_id": mli_id,
            "rows": [user_observations.observation_row(values) for _mlo_id, values in rows],
        }

    if last_conflict is not None:
        _amteam_sync_error(last_conflict)
    raise HTTPException(status_code=409, detail="The observation could not be given a free identifier.")


@router.delete("/inspections/{mli_id}/user-observations/{mlo_id}")
def delete_user_observation(
    mli_id: str,
    mlo_id: str,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    if not user_observations.is_user_mlo_id(mlo_id):
        raise HTTPException(
            status_code=400,
            detail="Only observations added in Portal can be deleted. ITPipes observations are read-only.",
        )

    coordinator = _amteam_coordinator(current_user)
    entities = [
        entity
        for entity in coordinator.query_entities(MLO_ENTITY_TYPE, filters={"MLO_ID": mlo_id})
        if not bool(entity.get("deleted"))
    ]
    if not entities:
        raise HTTPException(status_code=404, detail=f"Observation {mlo_id} was not found.")

    # The start and finish of a continuous defect are one reviewer entry, so removing
    # either one removes the pair and never leaves an unmatched marker for the ETL.
    partner_ids = user_observations.continuous_partner_ids(
        stored_user_observations(current_user, mli_id), mlo_id
    )
    for partner_id in partner_ids:
        entities.extend(
            entity
            for entity in coordinator.query_entities(MLO_ENTITY_TYPE, filters={"MLO_ID": partner_id})
            if not bool(entity.get("deleted"))
        )

    try:
        coordinator.commit(user_observations.delete_mutations(entities))
    except SyncError as error:
        _amteam_sync_error(error)

    removed = sorted({str((entity.get("values") or {}).get("MLO_ID") or "") for entity in entities})
    return {"mli_id": mli_id, "deleted": removed}
