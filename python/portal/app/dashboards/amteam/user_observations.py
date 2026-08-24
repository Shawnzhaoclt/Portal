"""Reviewer-added observations stored beside the read-only ITPipes source data.

ITPipes observations arrive through the DuckDB source cache and are never written by
Portal. Observations a reviewer records during a CCTV review are stored in the registered
``MLO`` entity in stormwater.db instead, so they synchronise like any other business
record and can be removed again. Because Portal only ever writes that table, a row's mere
presence there identifies it as reviewer-added; no origin column is required.

Every reviewer-added row is identified as ``PRO_<MLI>_<nn>``, which keeps them
distinguishable from ITPipes rows everywhere, including in the STM Risk ETL.

A continuous defect writes two such rows and pairs them through the ``Continuous``
column, in Portal's own namespace: ``PS01``/``PF01``. ITPipes uses ``S01``/``F01``, and
because reviewer rows are merged with ITPipes rows downstream, sharing that namespace
would let a Portal pair collide with an ITPipes pair on the same pipe. The pair number is
still allocated clear of the inspection's ITPipes numbers, so the two namespaces never
even share a number. The STM Risk ETL is being updated to parse both conventions.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Mapping

from portal.app.sync.models import Mutation
from portal.app.sync.physical_entities import MLO_ENTITY_TYPE, stable_global_id


SINGLE_PREFIX = "PRO"
# Retained so identifiers issued before the prefixes were unified are still recognised
# as reviewer-added and can still be deleted.
LEGACY_PREFIXES = ("PS", "PF")
USER_MLO_PREFIXES = (SINGLE_PREFIX, *LEGACY_PREFIXES)

# ITPipes marks continuity as S01/F01 numbered within one inspection.
CONTINUOUS_START_CODE = "S"
CONTINUOUS_FINISH_CODE = "F"
# Portal marks its continuous pairs PS01/PF01; ITPipes marks its own S01/F01. Parsing
# accepts both so allocation can keep the numbers distinct across the two sources.
CONTINUOUS_MARKER_PREFIX = "P"
_CONTINUOUS_PATTERN = re.compile(r"^P?([SF])(\d+)$", re.IGNORECASE)

# The ETL reads exactly these MLO columns, so nothing else is worth collecting.
EDITABLE_FIELDS = (
    "Distance",
    "Code",
    "Observation_Text",
    "Grade",
    "Joint",
    "Value_Percent",
    "Remarks",
    "Clock_From",
    "Clock_To",
)


def is_user_mlo_id(value: object) -> bool:
    """Return whether an MLO identifier was created by a reviewer rather than ITPipes."""
    text = str(value or "").strip().upper()
    return any(text.startswith(f"{prefix}_") for prefix in USER_MLO_PREFIXES)


def _sequence_from_mlo_id(value: object, mli_id: str) -> int | None:
    text = str(value or "").strip().upper()
    for prefix in USER_MLO_PREFIXES:
        head = f"{prefix}_{mli_id.upper()}_"
        if text.startswith(head):
            suffix = text[len(head):]
            if suffix.isdigit():
                return int(suffix)
    return None


def _continuous_marker(values: Mapping[str, Any]) -> tuple[str, int] | None:
    match = _CONTINUOUS_PATTERN.match(str(values.get("Continuous") or "").strip())
    return (match.group(1).upper(), int(match.group(2))) if match else None


def continuous_partner_ids(rows: Iterable[Mapping[str, Any]], mlo_id: str) -> list[str]:
    """Return the identifier of the other half of a continuous pair.

    Both halves are ordinary ``PRO_`` rows, so the pairing lives in the Continuous column
    exactly where ITPipes keeps it: the number identifies the pair within the inspection
    and the letter says which end it is. Only Portal writes this table, so a match here is
    always the reviewer's own other half.
    """
    candidates = list(rows)
    target = str(mlo_id or "").strip().upper()
    marker = next(
        (
            _continuous_marker(values)
            for values in candidates
            if str(values.get("MLO_ID") or "").strip().upper() == target
        ),
        None,
    )
    if marker is None:
        return []
    letter, number = marker
    partner_letter = CONTINUOUS_FINISH_CODE if letter == CONTINUOUS_START_CODE else CONTINUOUS_START_CODE
    return [
        str(values.get("MLO_ID"))
        for values in candidates
        if str(values.get("MLO_ID") or "").strip().upper() != target
        and _continuous_marker(values) == (partner_letter, number)
    ]


def next_observation_sequence(existing: Iterable[Mapping[str, Any]], mli_id: str) -> int:
    """Return the next free per-inspection sequence for a reviewer-added identifier."""
    used = {
        sequence
        for values in existing
        if (sequence := _sequence_from_mlo_id(values.get("MLO_ID"), mli_id)) is not None
    }
    return max(used, default=0) + 1


def format_mlo_id(mli_id: str, sequence: int) -> str:
    return f"{SINGLE_PREFIX}_{mli_id}_{sequence:02d}"


def next_continuous_sequence(used_continuous: Iterable[object]) -> int:
    """Return the next free ITPipes continuous number for an inspection.

    Both ITPipes and reviewer rows share one numbering space inside an inspection. Reusing
    a number would make the ETL pair a reviewer's start with an ITPipes finish, so the
    allocator considers every value already present on the inspection.
    """
    used: set[int] = set()
    for value in used_continuous:
        match = _CONTINUOUS_PATTERN.match(str(value or "").strip())
        if match:
            used.add(int(match.group(2)))
    return max(used, default=0) + 1


def format_continuous(code: str, sequence: int) -> str:
    return f"{CONTINUOUS_MARKER_PREFIX}{code}{sequence:02d}"


def _clean(value: Any) -> Any:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return value


def observation_values(
    *,
    mlo_id: str,
    mli_id: str,
    fields: Mapping[str, Any],
    distance: float,
    digital_time_seconds: float | None,
    continuous: str | None,
) -> dict[str, Any]:
    """Build one MLO row in the same shape ITPipes writes."""
    values: dict[str, Any] = {
        "MLO_ID": mlo_id,
        "MLI_ID": mli_id,
        "Distance": float(distance),
        "Continuous": continuous,
        # ITPipes records the media position in whole seconds and leaves the legacy tape
        # position at zero, so reviewer rows seek identically in the inspection video.
        "Digital_Time": str(int(digital_time_seconds)) if digital_time_seconds is not None else None,
        "VCR_Time": "0",
    }
    for field in EDITABLE_FIELDS:
        if field in ("Distance",):
            continue
        values[field] = _clean(fields.get(field))
    return values


def build_observation_mutations(
    *,
    mli_id: str,
    fields: Mapping[str, Any],
    start_distance: float,
    finish_distance: float | None,
    start_time_seconds: float | None,
    finish_time_seconds: float | None,
    sequence: int,
    continuous_sequence: int | None,
) -> list[tuple[str, dict[str, Any]]]:
    """Return the (mlo_id, values) rows for one reviewer entry.

    A continuous defect produces two rows sharing code, text, and grade, differing only in
    distance and media position, exactly as ITPipes stores them.
    """
    if finish_distance is None:
        mlo_id = format_mlo_id(mli_id, sequence)
        return [(
            mlo_id,
            observation_values(
                mlo_id=mlo_id,
                mli_id=mli_id,
                fields=fields,
                distance=start_distance,
                digital_time_seconds=start_time_seconds,
                continuous=None,
            ),
        )]

    if continuous_sequence is None:
        raise ValueError("A continuous defect requires a continuous sequence number.")

    # Two rows, so two identifiers; which end each one is comes from Continuous, not
    # from the identifier.
    start_id = format_mlo_id(mli_id, sequence)
    finish_id = format_mlo_id(mli_id, sequence + 1)
    return [
        (
            start_id,
            observation_values(
                mlo_id=start_id,
                mli_id=mli_id,
                fields=fields,
                distance=start_distance,
                digital_time_seconds=start_time_seconds,
                continuous=format_continuous(CONTINUOUS_START_CODE, continuous_sequence),
            ),
        ),
        (
            finish_id,
            observation_values(
                mlo_id=finish_id,
                mli_id=mli_id,
                fields=fields,
                distance=finish_distance,
                digital_time_seconds=finish_time_seconds,
                continuous=format_continuous(CONTINUOUS_FINISH_CODE, continuous_sequence),
            ),
        ),
    ]


def sequence_lock_key(mli_id: str) -> str:
    """Serialises identifier allocation across reviewers working one inspection."""
    return f"mlo-sequence:{mli_id}"


def insert_mutations(
    rows: Iterable[tuple[str, dict[str, Any]]], mli_id: str = ""
) -> list[Mutation]:
    """Build the insert mutations for one reviewer entry.

    Sequence numbers are read before the commit, so two reviewers adding to the same
    inspection can compute the same one. Holding a lock on the inspection makes the
    allocation and the insert one atomic step, which turns the race into a wait rather
    than a rejection for the second reviewer.
    """
    lock_keys = (sequence_lock_key(mli_id),) if mli_id else ()
    return [
        Mutation(
            entity_type=MLO_ENTITY_TYPE,
            entity_id=stable_global_id("mlo", mlo_id),
            operation_type="insert_entity",
            base_record_revision=None,
            values=values,
            unique_lock_keys=lock_keys,
        )
        for mlo_id, values in rows
    ]


def delete_mutations(entities: Iterable[Mapping[str, Any]]) -> list[Mutation]:
    return [
        Mutation(
            entity_type=MLO_ENTITY_TYPE,
            entity_id=str(entity["entity_id"]),
            operation_type="delete_entity",
            base_record_revision=str(entity["record_revision"]),
        )
        for entity in entities
        if not bool(entity.get("deleted"))
    ]


def observation_row(values: Mapping[str, Any]) -> dict[str, Any]:
    """Map a stored MLO row onto the shape the review table already renders."""
    return {
        "mlo_id": values.get("MLO_ID"),
        "mli_id": values.get("MLI_ID"),
        "distance": values.get("Distance"),
        "code": values.get("Code"),
        "observation_text": values.get("Observation_Text"),
        "grade": values.get("Grade"),
        "continuous": values.get("Continuous"),
        "joint": values.get("Joint"),
        "value_percent": values.get("Value_Percent"),
        "remarks": values.get("Remarks"),
        "clock_from": values.get("Clock_From"),
        "clock_to": values.get("Clock_To"),
        "vcr_time": values.get("VCR_Time"),
        "digital_time": values.get("Digital_Time"),
        "media_id": None,
        "full_path": None,
        "image_urls": [],
        "image_available": False,
        "image_url": None,
        "origin": "user",
    }
