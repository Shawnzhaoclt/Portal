"""Cityworks records looked up from the record, rather than from the asset.

Asset History answers "what happened to this pipe". This answers the inverse:
given a service request, inspection, investigation or work order, which asset was
it about and which sibling records belong to the same piece of work.

Two things about the source shape drive everything here. Records join in two
independent ways - direct foreign keys (an inspection carries REQUESTID and
WORKORDERID) and the ACTIVITYLINK table - and both have to be read or a record's
relatives go missing. And a service request carries no asset of its own: it
reaches assets only through the inspections and work orders raised from it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

import duckdb

from portal.app.resources.tables.storm_water_asset_history.source import (
    _calendar_date,
    _columns,
    _config,
    _connect,
    _id,
    _quote,
    _rows,
    _source,
)
from portal.runtime.transport import HTTPException


RECORD_KINDS = ("service_request", "inspection", "investigation", "work_order")
RECORD_LABELS = {
    "service_request": "Service request",
    "inspection": "Inspection",
    "investigation": "Investigation",
    "work_order": "Work order",
}
# ACTIVITYLINK stores the activity kind as free text and is not consistent about
# it - "WorkOrder" and "Workorder" both appear - so every comparison is folded.
LINK_TYPES = {
    "servicerequest": "service_request",
    "inspection": "inspection",
    "workorder": "work_order",
}
# A record set large enough to stop being a list and start being a report.
RELATED_LIMIT = 200
# Cityworks calls an investigation an inspection on an Investigation template -
# 35,000 of the 80,000 inspection rows - so the kind is read from the template
# rather than inferred from how the record happens to be linked.
INVESTIGATION_TEMPLATE_PREFIX = "investigation"


def _identifier(column: str) -> str:
    """SQL that renders an id as plain digits.

    Every identifier in this mirror is stored as a double, so a straight cast to
    text yields "17972.0" and would never match the "17972" a person types.
    """
    return f"CAST(TRY_CAST({_quote(column)} AS BIGINT) AS VARCHAR)"


def _inspection_kind(row: dict[str, Any]) -> str:
    template = str(row.get("INSPTEMPLATENAME") or "").strip().casefold()
    return "investigation" if template.startswith(INVESTIGATION_TEMPLATE_PREFIX) else "inspection"


def _table(config: dict[str, Any], key: str) -> str:
    tables = config.get("cityworksTables") or {}
    name = str(tables.get(key) or "").strip()
    if not name:
        raise HTTPException(
            status_code=503,
            detail=f"assetHistory.cityworksTables.{key} is not configured.",
        )
    return name


def _cityworks() -> tuple[duckdb.DuckDBPyConnection, dict[str, str]]:
    config = _config()
    _, path = _source(config, "cityworks")
    connection = _connect(Path(path))
    return connection, {
        "request": _table(config, "request"),
        "inspection": _table(config, "inspection"),
        "work_order": _table(config, "workOrder"),
        "work_order_entity": _table(config, "workOrderEntity"),
        "activity_link": _table(config, "activityLink"),
    }


def _one(connection: duckdb.DuckDBPyConnection, table: str, key: str, value: str) -> dict[str, Any] | None:
    rows = _rows(
        connection.execute(
            f"SELECT * FROM {_quote(table)} WHERE {_identifier(key)} = ? LIMIT 1",
            [_id(value)],
        )
    )
    return rows[0] if rows else None


def _many(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    key: str,
    values: Iterable[str],
    limit: int = RELATED_LIMIT,
) -> list[dict[str, Any]]:
    wanted = sorted({_id(value) for value in values if _id(value)})
    if not wanted:
        return []
    placeholders = ", ".join("?" for _ in wanted)
    return _rows(
        connection.execute(
            f"SELECT * FROM {_quote(table)} WHERE {_identifier(key)} IN ({placeholders}) LIMIT {int(limit)}",
            wanted,
        )
    )


def _linked(
    connection: duckdb.DuckDBPyConnection,
    tables: dict[str, str],
    kind: str,
    record_id: str,
) -> list[tuple[str, str]]:
    """Every (kind, id) the link table joins to this record, in either direction."""
    # An investigation is an inspection, so it answers to the same link type.
    wanted = {"inspection"} if kind == "investigation" else {
        name for name, mapped in LINK_TYPES.items() if mapped == kind
    }
    rows = _rows(
        connection.execute(
            f"""
            SELECT SOURCEACTIVITYTYPE,
                   {_identifier("SOURCEACTIVITYID")} AS source_id,
                   DESTACTIVITYTYPE,
                   {_identifier("DESTACTIVITYID")} AS dest_id
            FROM {_quote(tables["activity_link"])}
            WHERE {_identifier("SOURCEACTIVITYID")} = ? OR {_identifier("DESTACTIVITYID")} = ?
            """,
            [_id(record_id), _id(record_id)],
        )
    )
    found: list[tuple[str, str]] = []
    for row in rows:
        source_type = str(row.get("SOURCEACTIVITYTYPE") or "").casefold()
        dest_type = str(row.get("DESTACTIVITYTYPE") or "").casefold()
        source_id = _id(row.get("source_id"))
        dest_id = _id(row.get("dest_id"))
        if source_id == _id(record_id) and source_type in wanted:
            mapped = LINK_TYPES.get(dest_type)
            if mapped:
                found.append((mapped, dest_id))
        if dest_id == _id(record_id) and dest_type in wanted:
            mapped = LINK_TYPES.get(source_type)
            if mapped:
                found.append((mapped, source_id))
    return found


def _summarize(kind: str, row: dict[str, Any], link_reason: str = "") -> dict[str, Any]:
    """One row in a related-records list, in the shape the page renders."""
    if kind == "work_order":
        identifier = _id(row.get("WORKORDERID"))
        title = str(row.get("DESCRIPTION") or "").strip()
        status = str(row.get("STATUS") or "").strip()
        when = row.get("INITIATEDATE") or row.get("ACTUALSTARTDATE")
        closed = row.get("DATEWOCLOSED")
    elif kind == "service_request":
        identifier = _id(row.get("REQUESTID"))
        title = str(row.get("PROBLEMCODE") or "").strip()
        status = str(row.get("STATUS") or "").strip()
        when = row.get("DATETIMEINIT")
        closed = row.get("DATETIMECLOSED")
    else:
        identifier = _id(row.get("INSPECTIONID"))
        title = str(row.get("INSPTEMPLATENAME") or "").strip()
        status = str(row.get("STATUS") or "").strip()
        when = row.get("INSPDATE") or row.get("INITIATEDATE")
        closed = row.get("DATECLOSED")
    return {
        "kind": kind,
        "kind_label": RECORD_LABELS[kind],
        "id": identifier,
        "title": title,
        "status": status,
        "opened_at": _calendar_date(when),
        "closed_at": _calendar_date(closed),
        "link_reason": link_reason,
        "available": True,
    }


def _reference(kind: str, identifier: str, link_reason: str) -> dict[str, Any]:
    """A record Cityworks links to that Portal's copy does not carry.

    The mirror holds a filtered slice - about one linked work order in eleven is
    outside it - so a missing row means "not copied here", not "does not exist".
    Reporting it as a reference keeps the count honest and still offers the
    Cityworks link, which works whether or not the row was mirrored.
    """
    return {
        "kind": kind,
        "kind_label": RECORD_LABELS[kind],
        "id": identifier,
        "title": "",
        "status": "",
        "opened_at": None,
        "closed_at": None,
        "link_reason": link_reason,
        "available": False,
    }


# What a person is likely to have in front of them: the number, the problem or
# template it was raised under, and the address it happened at.
SEARCH_COLUMNS = {
    "service_request": ("PROBLEMCODE", "PROBADDRESS", "PROBLOCATION", "DESCRIPTION"),
    "inspection": ("INSPTEMPLATENAME", "LOCATION"),
    "work_order": ("DESCRIPTION", "WOADDRESS", "LOCATION"),
}
SEARCH_LIMIT = 10


def _subtitle(kind: str, row: dict[str, Any]) -> str:
    if kind == "service_request":
        return str(row.get("PROBADDRESS") or row.get("PROBLOCATION") or "").strip()
    if kind == "work_order":
        return str(row.get("WOADDRESS") or row.get("LOCATION") or "").strip()
    return str(row.get("LOCATION") or "").strip()


def _search_one(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    key: str,
    kind: str,
    query: str,
    limit: int,
) -> list[dict[str, Any]]:
    """Rows matching the number exactly, by prefix, or by any searchable text.

    Ranked so an exact number wins, then a number that starts the same way, then
    a text match - which is the order a person means when they type.
    """
    available = set(_columns(connection, table))
    text_columns = [name for name in SEARCH_COLUMNS.get(kind, ()) if name in available]
    digits = _id(query)
    identifier = _identifier(key)
    clauses = []
    params: list[Any] = []
    if digits:
        clauses.append(f"{identifier} = ?")
        params.append(digits)
        clauses.append(f"{identifier} LIKE ?")
        params.append(f"{digits}%")
    needle = f"%{query.strip()}%"
    for column in text_columns:
        clauses.append(f"CAST({_quote(column)} AS VARCHAR) ILIKE ?")
        params.append(needle)
    if not clauses:
        return []
    rank_parts = []
    rank_params: list[Any] = []
    if digits:
        rank_parts.append(f"WHEN {identifier} = ? THEN 0")
        rank_params.append(digits)
        rank_parts.append(f"WHEN {identifier} LIKE ? THEN 1")
        rank_params.append(f"{digits}%")
    rank = f"CASE {' '.join(rank_parts)} ELSE 2 END" if rank_parts else "2"
    return _rows(
        connection.execute(
            f"""
            SELECT *, {rank} AS match_rank
            FROM {_quote(table)}
            WHERE {' OR '.join(clauses)}
            ORDER BY match_rank, {identifier}
            LIMIT {int(limit)}
            """,
            rank_params + params,
        )
    )


def search(query: str, limit: int = SEARCH_LIMIT) -> list[dict[str, Any]]:
    """The best few records for what the reader typed, across all four kinds."""
    wanted = str(query or "").strip()
    if len(wanted) < 2:
        return []
    connection, tables = _cityworks()
    try:
        found: list[tuple[int, dict[str, Any]]] = []
        for kind, table, key in (
            ("service_request", tables["request"], "REQUESTID"),
            ("inspection", tables["inspection"], "INSPECTIONID"),
            ("work_order", tables["work_order"], "WORKORDERID"),
        ):
            for row in _search_one(connection, table, key, kind, wanted, limit):
                actual = _inspection_kind(row) if kind == "inspection" else kind
                summary = _summarize(actual, row)
                summary["subtitle"] = _subtitle(kind, row)
                found.append((int(row.get("match_rank") or 2), summary))
        # An exact number in any kind outranks a text match in every kind.
        found.sort(key=lambda item: (item[0], item[1]["kind"], item[1]["id"]))
        numbered = [summary for rank, summary in found if rank < 2]
        # Text matches take turns by kind, so a common problem code cannot fill
        # the whole list and hide the work order someone was actually after.
        by_kind: dict[str, list[dict[str, Any]]] = {}
        for rank, summary in found:
            if rank >= 2:
                by_kind.setdefault(summary["kind"], []).append(summary)
        interleaved: list[dict[str, Any]] = []
        while any(by_kind.values()):
            for kind in list(by_kind):
                if by_kind[kind]:
                    interleaved.append(by_kind[kind].pop(0))
        return (numbered + interleaved)[:limit]
    finally:
        connection.close()


def resolve(query: str) -> list[dict[str, Any]]:
    """Every record whose id matches, across all four kinds.

    Ids are only unique within a kind, so the same number can name a request and
    a work order. The page asks which one rather than guessing.
    """
    wanted = _id(query)
    if not wanted:
        return []
    connection, tables = _cityworks()
    try:
        matches: list[dict[str, Any]] = []
        request = _one(connection, tables["request"], "REQUESTID", wanted)
        if request:
            matches.append(_summarize("service_request", request))
        work_order = _one(connection, tables["work_order"], "WORKORDERID", wanted)
        if work_order:
            matches.append(_summarize("work_order", work_order))
        inspection = _one(connection, tables["inspection"], "INSPECTIONID", wanted)
        if inspection:
            matches.append(_summarize(_inspection_kind(inspection), inspection))
        return matches
    finally:
        connection.close()


# Cityworks attaches its work to more than the drainage network: parcels, city
# culverts, dams, inventory areas and connectivity nodes all appear as entities.
# Portal's asset universe is the three classes Asset History holds, so those are
# the only ones worth showing here — the rest name nothing a reader can open.
ASSET_ENTITY_TYPES = {"PIPES", "STRUCTURES", "CHANNELS"}


def _is_portal_asset(entity_type: str) -> bool:
    return entity_type.strip().upper() in ASSET_ENTITY_TYPES


def _asset_rows(
    connection: duckdb.DuckDBPyConnection,
    tables: dict[str, str],
    inspections: list[dict[str, Any]],
    work_order_ids: Iterable[str],
) -> list[dict[str, Any]]:
    """Assets reached through inspections and through work-order entities."""
    assets: dict[tuple[str, str], dict[str, Any]] = {}
    for row in inspections:
        entity_id = _id(row.get("ENTITYUID")) or _id(row.get("FEATUREUID"))
        entity_type = str(row.get("ENTITYTYPE") or "").strip()
        if not entity_id or not _is_portal_asset(entity_type):
            continue
        assets.setdefault(
            (entity_type.casefold(), entity_id),
            {
                "asset_id": entity_id,
                "asset_type": entity_type,
                "reached_by": f"Inspection {_id(row.get('INSPECTIONID'))}",
            },
        )
    entity_rows = _many(
        connection, tables["work_order_entity"], "WORKORDERID", work_order_ids, limit=RELATED_LIMIT * 4
    )
    for row in entity_rows:
        entity_id = _id(row.get("ENTITYUID")) or _id(row.get("FEATUREUID"))
        entity_type = str(row.get("ENTITYTYPE") or "").strip()
        if not entity_id or not _is_portal_asset(entity_type):
            continue
        assets.setdefault(
            (entity_type.casefold(), entity_id),
            {
                "asset_id": entity_id,
                "asset_type": entity_type,
                "reached_by": f"Work order {_id(row.get('WORKORDERID'))}",
            },
        )
    return sorted(assets.values(), key=lambda item: (item["asset_type"], item["asset_id"]))


def record_detail(kind: str, record_id: str) -> dict[str, Any]:
    """The record, the assets it touches, and its directly related records."""
    if kind not in RECORD_KINDS:
        raise HTTPException(status_code=404, detail=f"Unknown record kind: {kind}")
    wanted = _id(record_id)
    if not wanted:
        raise HTTPException(status_code=400, detail="A record id is required.")

    connection, tables = _cityworks()
    try:
        table = {
            "service_request": tables["request"],
            "work_order": tables["work_order"],
            "inspection": tables["inspection"],
            "investigation": tables["inspection"],
        }[kind]
        key = {
            "service_request": "REQUESTID",
            "work_order": "WORKORDERID",
            "inspection": "INSPECTIONID",
            "investigation": "INSPECTIONID",
        }[kind]
        row = _one(connection, table, key, wanted)
        if row is None:
            raise HTTPException(status_code=404, detail=f"{RECORD_LABELS[kind]} {wanted} was not found.")
        if kind in ("inspection", "investigation"):
            # Report what the record actually is, whichever door the reader used.
            kind = _inspection_kind(row)

        request_ids: set[str] = set()
        inspection_ids: set[str] = set()
        work_order_ids: set[str] = set()
        reasons: dict[tuple[str, str], str] = {}

        def remember(target_kind: str, value: Any, reason: str) -> None:
            identifier = _id(value)
            if not identifier or (target_kind == kind and identifier == wanted):
                return
            bucket = {
                "service_request": request_ids,
                "inspection": inspection_ids,
                "investigation": inspection_ids,
                "work_order": work_order_ids,
            }[target_kind]
            bucket.add(identifier)
            reasons.setdefault((target_kind, identifier), reason)

        # Direct foreign keys first - they are the strongest statement of
        # relationship the source makes.
        if kind == "service_request":
            remember("work_order", row.get("WORKORDERID"), "Named on the request")
            for inspection in _many(connection, tables["inspection"], "REQUESTID", [wanted]):
                remember("inspection", inspection.get("INSPECTIONID"), "Raised from this request")
        elif kind in ("inspection", "investigation"):
            remember("service_request", row.get("REQUESTID"), "Request that raised it")
            remember("work_order", row.get("WORKORDERID"), "Work order it belongs to")
        else:
            for inspection in _many(connection, tables["inspection"], "WORKORDERID", [wanted]):
                remember("inspection", inspection.get("INSPECTIONID"), "Carried out on this work order")

        for linked_kind, linked_id in _linked(connection, tables, kind, wanted):
            remember(linked_kind, linked_id, "Linked in Cityworks")

        requests = _many(connection, tables["request"], "REQUESTID", request_ids)
        inspections = _many(connection, tables["inspection"], "INSPECTIONID", inspection_ids)
        work_orders = _many(connection, tables["work_order"], "WORKORDERID", work_order_ids)

        # The record itself contributes its own asset and work-order entities.
        own_inspections = [row] if kind in ("inspection", "investigation") else []
        own_work_orders = {wanted} if kind == "work_order" else set()

        related: list[dict[str, Any]] = []
        for item in requests:
            identifier = _id(item.get("REQUESTID"))
            related.append(_summarize("service_request", item, reasons.get(("service_request", identifier), "")))
        for item in inspections:
            identifier = _id(item.get("INSPECTIONID"))
            reason = reasons.get(("inspection", identifier)) or reasons.get(("investigation", identifier), "")
            related.append(_summarize(_inspection_kind(item), item, reason))
        for item in work_orders:
            identifier = _id(item.get("WORKORDERID"))
            related.append(_summarize("work_order", item, reasons.get(("work_order", identifier), "")))

        # Anything the links promised but the mirror does not hold.
        found = {(item["kind"], item["id"]) for item in related}
        for (target_kind, identifier), reason in sorted(reasons.items()):
            listed = target_kind if target_kind != "investigation" else "inspection"
            if any(
                (kind_name, identifier) in found
                for kind_name in ({listed, "investigation"} if listed == "inspection" else {listed})
            ):
                continue
            related.append(_reference(target_kind, identifier, reason))

        assets = _asset_rows(
            connection,
            tables,
            own_inspections + inspections,
            own_work_orders | work_order_ids,
        )
        return {
            "record": _summarize(kind, row),
            "fields": {
                str(name): _calendar_date(value) if str(name).upper().startswith("DATE") else value
                for name, value in row.items()
                if value not in (None, "")
            },
            "assets": assets,
            "related": related,
            "counts": {
                "assets": len(assets),
                "service_requests": sum(1 for item in related if item["kind"] == "service_request"),
                "inspections": sum(1 for item in related if item["kind"] == "inspection"),
                "investigations": sum(1 for item in related if item["kind"] == "investigation"),
                "work_orders": sum(1 for item in related if item["kind"] == "work_order"),
                "not_in_portal": sum(1 for item in related if not item.get("available", True)),
            },
        }
    finally:
        connection.close()


def source_columns() -> dict[str, list[str]]:
    """Column names per table, so the page can show what a record carries."""
    connection, tables = _cityworks()
    try:
        return {key: _columns(connection, table) for key, table in tables.items()}
    finally:
        connection.close()
