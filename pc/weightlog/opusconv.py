"""Repack the Zepp recorder's Opus container into standard Ogg Opus.

The GTR 4 writes raw Opus packets each prefixed by an 8-byte header: a 4-byte
big-endian payload length followed by 4 bytes of flags. That is not a container
any player understands, so the packets are lifted out and wrapped in Ogg pages
with the OpusHead/OpusTags headers the format requires.

The recorder runs at 16 kHz mono in 20 ms frames. Opus granule positions are
always expressed at 48 kHz regardless of input rate, so each frame advances the
position by 960 samples.
"""
from __future__ import annotations

import logging
import pathlib
import struct

log = logging.getLogger("weightlog.opusconv")

FRAME_HEADER = 8
SAMPLES_PER_FRAME = 960  # 20 ms at the 48 kHz granule clock Opus always uses
PRE_SKIP = 312
INPUT_RATE = 16000
MAX_SEGMENTS = 255


def _crc_table() -> list[int]:
    # Ogg uses CRC-32 with polynomial 0x04c11db7, no reflection and no final xor.
    table = []
    for i in range(256):
        r = i << 24
        for _ in range(8):
            r = ((r << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if r & 0x80000000 else (r << 1) & 0xFFFFFFFF
        table.append(r)
    return table


_CRC = _crc_table()


def _crc32(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ _CRC[((crc >> 24) & 0xFF) ^ byte]
    return crc


def _lacing(packets: list[bytes]) -> list[int]:
    segments: list[int] = []
    for packet in packets:
        n = len(packet)
        while n >= 255:
            segments.append(255)
            n -= 255
        segments.append(n)  # a final 0 is correct for exact multiples of 255
    return segments


def _page(serial: int, seq: int, header_type: int, granule: int, packets: list[bytes]) -> bytes:
    segments = _lacing(packets)
    header = (
        b"OggS"
        + bytes((0, header_type))
        + struct.pack("<q", granule)
        + struct.pack("<I", serial)
        + struct.pack("<I", seq)
        + b"\x00\x00\x00\x00"  # CRC placeholder
        + bytes((len(segments),))
        + bytes(segments)
    )
    body = b"".join(packets)
    crc = _crc32(header + body)
    return header[:22] + struct.pack("<I", crc) + header[26:] + body


def parse_frames(data: bytes) -> list[bytes]:
    """Lift the raw Opus packets out of the Zepp container."""
    packets: list[bytes] = []
    offset = 0
    while offset + FRAME_HEADER <= len(data):
        (length,) = struct.unpack_from(">I", data, offset)
        start = offset + FRAME_HEADER
        end = start + length
        if length <= 0 or end > len(data):
            log.warning("truncated frame at offset %d (len=%d)", offset, length)
            break
        packets.append(data[start:end])
        offset = end
    return packets


def to_ogg_opus(src: str | pathlib.Path, dest: str | pathlib.Path, serial: int = 1) -> int:
    """Convert one recording. Returns the number of Opus packets written."""
    data = pathlib.Path(src).read_bytes()
    packets = parse_frames(data)
    if not packets:
        raise ValueError(f"no Opus frames found in {src}")

    head = (
        b"OpusHead"
        + bytes((1, 1))
        + struct.pack("<H", PRE_SKIP)
        + struct.pack("<I", INPUT_RATE)
        + struct.pack("<h", 0)
        + bytes((0,))
    )
    vendor = b"weightlog"
    tags = b"OpusTags" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0)

    out = bytearray()
    seq = 0
    out += _page(serial, seq, 0x02, 0, [head])  # BOS
    seq += 1
    out += _page(serial, seq, 0x00, 0, [tags])
    seq += 1

    # Audio pages: at most 255 lacing segments each, granule counted in 48 kHz
    # samples through the last packet that ends on the page.
    granule = 0
    batch: list[bytes] = []
    for i, packet in enumerate(packets):
        batch.append(packet)
        granule += SAMPLES_PER_FRAME
        last = i == len(packets) - 1
        if len(_lacing(batch)) >= MAX_SEGMENTS - 1 or last:
            out += _page(serial, seq, 0x04 if last else 0x00, granule, batch)
            seq += 1
            batch = []

    pathlib.Path(dest).write_bytes(bytes(out))
    return len(packets)


def main() -> None:
    import sys

    if len(sys.argv) != 3:
        sys.exit("usage: python -m weightlog.opusconv <in.opus> <out.ogg>")
    n = to_ogg_opus(sys.argv[1], sys.argv[2])
    print(f"wrote {sys.argv[2]}: {n} packets, {n * 20 / 1000:.1f}s")


if __name__ == "__main__":
    main()
