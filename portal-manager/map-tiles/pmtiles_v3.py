"""Small PMTiles v3 writer used by Portal Manager.

The directory and header encoding is adapted from the BSD-3-Clause PMTiles
Python reference implementation maintained by Protomaps:
https://github.com/protomaps/PMTiles/tree/main/python/pmtiles/pmtiles
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
import gzip
import hashlib
import io
import json
from pathlib import Path
import shutil
import tempfile
from typing import BinaryIO, Iterable


class Compression(IntEnum):
    UNKNOWN = 0
    NONE = 1
    GZIP = 2
    BROTLI = 3
    ZSTD = 4


class TileType(IntEnum):
    UNKNOWN = 0
    MVT = 1
    PNG = 2
    JPEG = 3
    WEBP = 4
    AVIF = 5


@dataclass
class Entry:
    tile_id: int
    offset: int
    length: int
    run_length: int


def _rotate(n: int, x: int, y: int, rx: int, ry: int) -> tuple[int, int]:
    if ry == 0:
        if rx != 0:
            x = n - 1 - x
            y = n - 1 - y
        x, y = y, x
    return x, y


def zxy_to_tile_id(z: int, x: int, y: int) -> int:
    if z < 0 or z > 31:
        raise ValueError("Tile zoom must be between 0 and 31.")
    maximum = (1 << z) - 1
    if x < 0 or y < 0 or x > maximum or y > maximum:
        raise ValueError(f"Tile {z}/{x}/{y} is outside the zoom-level bounds.")
    accumulator = ((1 << (z * 2)) - 1) // 3
    level = z - 1
    while level >= 0:
        scale = 1 << level
        rx = scale & x
        ry = scale & y
        accumulator += ((3 * rx) ^ ry) << level
        x, y = _rotate(scale, x, y, rx, ry)
        level -= 1
    return accumulator


def tile_id_to_zxy(tile_id: int) -> tuple[int, int, int]:
    if tile_id < 0:
        raise ValueError("Tile ID cannot be negative.")
    z = ((3 * tile_id + 1).bit_length() - 1) // 2
    if z >= 32:
        raise OverflowError("Tile zoom exceeds the PMTiles 64-bit limit.")
    accumulator = ((1 << (z * 2)) - 1) // 3
    position = tile_id - accumulator
    x = 0
    y = 0
    scale = 1
    size = 1 << z
    while scale < size:
        rx = (position // 2) & scale
        ry = (position ^ rx) & scale
        x, y = _rotate(scale, x, y, rx, ry)
        x += rx
        y += ry
        position >>= 1
        scale <<= 1
    return z, x, y


def _write_varint(stream: BinaryIO, value: int) -> None:
    if value < 0:
        raise ValueError("PMTiles varints cannot be negative.")
    while True:
        current = value & 0x7F
        value >>= 7
        if value:
            stream.write(bytes([current | 0x80]))
        else:
            stream.write(bytes([current]))
            return


def serialize_directory(entries: Iterable[Entry]) -> bytes:
    values = list(entries)
    stream = io.BytesIO()
    _write_varint(stream, len(values))
    previous_id = 0
    for entry in values:
        _write_varint(stream, entry.tile_id - previous_id)
        previous_id = entry.tile_id
    for entry in values:
        _write_varint(stream, entry.run_length)
    for entry in values:
        _write_varint(stream, entry.length)
    for index, entry in enumerate(values):
        if index > 0 and entry.offset == values[index - 1].offset + values[index - 1].length:
            _write_varint(stream, 0)
        else:
            _write_varint(stream, entry.offset + 1)
    return gzip.compress(stream.getvalue(), mtime=0)


def _build_roots_and_leaves(entries: list[Entry], leaf_size: int) -> tuple[bytes, bytes, int]:
    roots: list[Entry] = []
    leaves = bytearray()
    for start in range(0, len(entries), leaf_size):
        block = serialize_directory(entries[start : start + leaf_size])
        roots.append(Entry(entries[start].tile_id, len(leaves), len(block), 0))
        leaves.extend(block)
    return serialize_directory(roots), bytes(leaves), len(roots)


def _optimized_directories(entries: list[Entry], target_root_length: int) -> tuple[bytes, bytes, int]:
    root = serialize_directory(entries)
    if len(root) < target_root_length:
        return root, b"", 0
    leaf_size = 4096
    while True:
        root, leaves, leaf_count = _build_roots_and_leaves(entries, leaf_size)
        if len(root) < target_root_length:
            return root, leaves, leaf_count
        leaf_size *= 2


def serialize_header(header: dict[str, object]) -> bytes:
    stream = io.BytesIO()

    def uint64(value: int) -> None:
        stream.write(int(value).to_bytes(8, "little"))

    def int32(value: int) -> None:
        stream.write(int(value).to_bytes(4, "little", signed=True))

    def uint8(value: int) -> None:
        stream.write(int(value).to_bytes(1, "little"))

    stream.write(b"PMTiles\x03")
    for key in (
        "root_offset",
        "root_length",
        "metadata_offset",
        "metadata_length",
        "leaf_directory_offset",
        "leaf_directory_length",
        "tile_data_offset",
        "tile_data_length",
        "addressed_tiles_count",
        "tile_entries_count",
        "tile_contents_count",
    ):
        uint64(int(header.get(key, 0)))
    uint8(1 if header.get("clustered") else 0)
    uint8(int(header.get("internal_compression", Compression.GZIP)))
    uint8(int(header.get("tile_compression", Compression.GZIP)))
    uint8(int(header.get("tile_type", TileType.MVT)))
    uint8(int(header["min_zoom"]))
    uint8(int(header["max_zoom"]))
    min_lon = int(header.get("min_lon_e7", -1_800_000_000))
    min_lat = int(header.get("min_lat_e7", -900_000_000))
    max_lon = int(header.get("max_lon_e7", 1_800_000_000))
    max_lat = int(header.get("max_lat_e7", 900_000_000))
    int32(min_lon)
    int32(min_lat)
    int32(max_lon)
    int32(max_lat)
    uint8(int(header.get("center_zoom", header["min_zoom"])))
    int32(int(header.get("center_lon_e7", round((min_lon + max_lon) / 2))))
    int32(int(header.get("center_lat_e7", round((min_lat + max_lat) / 2))))
    encoded = stream.getvalue()
    if len(encoded) != 127:
        raise RuntimeError(f"PMTiles header must be 127 bytes, got {len(encoded)}.")
    return encoded


def read_header(path: Path) -> dict[str, int | bool]:
    with path.open("rb") as handle:
        value = handle.read(127)
    if len(value) != 127 or value[:7] != b"PMTiles" or value[7] != 3:
        raise RuntimeError(f"Not a PMTiles v3 archive: {path}")

    def uint64(position: int) -> int:
        return int.from_bytes(value[position : position + 8], "little")

    def int32(position: int) -> int:
        return int.from_bytes(value[position : position + 4], "little", signed=True)

    return {
        "version": value[7],
        "root_offset": uint64(8),
        "root_length": uint64(16),
        "metadata_offset": uint64(24),
        "metadata_length": uint64(32),
        "leaf_directory_offset": uint64(40),
        "leaf_directory_length": uint64(48),
        "tile_data_offset": uint64(56),
        "tile_data_length": uint64(64),
        "addressed_tiles_count": uint64(72),
        "tile_entries_count": uint64(80),
        "tile_contents_count": uint64(88),
        "clustered": value[96] == 1,
        "internal_compression": value[97],
        "tile_compression": value[98],
        "tile_type": value[99],
        "min_zoom": value[100],
        "max_zoom": value[101],
        "min_lon_e7": int32(102),
        "min_lat_e7": int32(106),
        "max_lon_e7": int32(110),
        "max_lat_e7": int32(114),
        "center_zoom": value[118],
        "center_lon_e7": int32(119),
        "center_lat_e7": int32(123),
    }


class Writer:
    def __init__(self, destination: BinaryIO):
        self.destination = destination
        self.entries: list[Entry] = []
        self.content_offsets: dict[bytes, int] = {}
        self.tile_file = tempfile.TemporaryFile()
        self.offset = 0
        self.addressed_tiles = 0
        self.clustered = True

    def write_tile(self, tile_id: int, data: bytes) -> None:
        if self.entries and tile_id < self.entries[-1].tile_id:
            self.clustered = False
        digest = hashlib.blake2b(data, digest_size=16).digest()
        existing_offset = self.content_offsets.get(digest)
        if existing_offset is not None:
            previous = self.entries[-1]
            if tile_id == previous.tile_id + previous.run_length and previous.offset == existing_offset:
                previous.run_length += 1
            else:
                self.entries.append(Entry(tile_id, existing_offset, len(data), 1))
        else:
            self.tile_file.write(data)
            self.entries.append(Entry(tile_id, self.offset, len(data), 1))
            self.content_offsets[digest] = self.offset
            self.offset += len(data)
        self.addressed_tiles += 1

    def finalize(self, header: dict[str, object], metadata: dict[str, object]) -> None:
        if not self.entries:
            raise RuntimeError("Cannot create an empty PMTiles archive.")
        self.entries.sort(key=lambda entry: entry.tile_id)
        header = dict(header)
        header["addressed_tiles_count"] = self.addressed_tiles
        header["tile_entries_count"] = len(self.entries)
        header["tile_contents_count"] = len(self.content_offsets)
        header["min_zoom"] = tile_id_to_zxy(self.entries[0].tile_id)[0]
        header["max_zoom"] = tile_id_to_zxy(self.entries[-1].tile_id)[0]
        root, leaves, _leaf_count = _optimized_directories(self.entries, 16384 - 127)
        compressed_metadata = gzip.compress(
            json.dumps(metadata, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            mtime=0,
        )
        header.update(
            {
                "clustered": self.clustered,
                "internal_compression": Compression.GZIP,
                "root_offset": 127,
                "root_length": len(root),
                "metadata_offset": 127 + len(root),
                "metadata_length": len(compressed_metadata),
                "leaf_directory_offset": 127 + len(root) + len(compressed_metadata),
                "leaf_directory_length": len(leaves),
                "tile_data_offset": 127 + len(root) + len(compressed_metadata) + len(leaves),
                "tile_data_length": self.offset,
            }
        )
        self.destination.write(serialize_header(header))
        self.destination.write(root)
        self.destination.write(compressed_metadata)
        self.destination.write(leaves)
        self.tile_file.seek(0)
        shutil.copyfileobj(self.tile_file, self.destination)
        self.tile_file.close()

