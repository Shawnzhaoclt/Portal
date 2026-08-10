"""Generate complete Windows icon families from the approved app masters."""

from __future__ import annotations

import argparse
import io
import struct
from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


WINDOWS_ICON_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)
COMPACT_ICON_MAX_SIZE = 48


def compact_icon_canvas(master: Image.Image) -> Image.Image:
    """Tightly frame the approved artwork for Windows taskbar-sized icons."""
    bounds = master.getchannel("A").getbbox()
    if bounds is None:
        return master
    content = master.crop(bounds)
    side = max(content.size)
    padding = max(1, round(side * 0.03))
    canvas_side = side + padding * 2
    canvas = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    canvas.alpha_composite(
        content,
        ((canvas_side - content.width) // 2, (canvas_side - content.height) // 2),
    )
    return canvas


def resized_icon(master: Image.Image, size: int) -> Image.Image:
    source = compact_icon_canvas(master) if size <= COMPACT_ICON_MAX_SIZE else master
    frame = source.resize((size, size), Image.Resampling.LANCZOS)
    if size <= 24:
        # Preserve the shield edge and central role mark at taskbar and compact
        # Explorer sizes without changing the approved color or composition.
        frame = frame.filter(ImageFilter.UnsharpMask(radius=0.55, percent=190, threshold=1))
        frame = ImageEnhance.Contrast(frame).enhance(1.10)
    elif size <= COMPACT_ICON_MAX_SIZE:
        frame = frame.filter(ImageFilter.UnsharpMask(radius=0.65, percent=135, threshold=1))
        frame = ImageEnhance.Contrast(frame).enhance(1.05)
    return frame


def write_png_ico(path: Path, frames: list[Image.Image]) -> None:
    encoded: list[bytes] = []
    for frame in frames:
        output = io.BytesIO()
        frame.save(output, format="PNG", optimize=True)
        encoded.append(output.getvalue())

    header_size = 6 + len(frames) * 16
    offset = header_size
    payload = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    for frame, data in zip(frames, encoded, strict=True):
        width, height = frame.size
        payload.extend(
            struct.pack(
                "<BBBBHHII",
                0 if width == 256 else width,
                0 if height == 256 else height,
                0,
                0,
                1,
                32,
                len(data),
                offset,
            )
        )
        offset += len(data)
    for data in encoded:
        payload.extend(data)
    path.write_bytes(payload)


def generate(master_path: Path, icon_directory: Path) -> None:
    master = Image.open(master_path).convert("RGBA")
    icon_directory.mkdir(parents=True, exist_ok=True)
    frames = [resized_icon(master, size) for size in WINDOWS_ICON_SIZES]
    for size, frame in zip(WINDOWS_ICON_SIZES, frames, strict=True):
        frame.save(icon_directory / f"{size}x{size}.png", optimize=True)

    resized_icon(master, 512).save(icon_directory / "icon.png", optimize=True)
    resized_icon(master, 128).save(icon_directory / "128x128.png", optimize=True)
    resized_icon(master, 256).save(icon_directory / "128x128@2x.png", optimize=True)
    write_png_ico(icon_directory / "icon.ico", frames)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("master", type=Path)
    parser.add_argument("icon_directory", type=Path)
    arguments = parser.parse_args()
    generate(arguments.master.resolve(), arguments.icon_directory.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
