import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from gymsync.protocol import PROTO_VERSION, Reassembler, SyncSession, encode_chunks, info_payload
from gymsync.store import Store

NOW = 1_758_600_000  # 2026-09-23-ish


class ChunkingTest(unittest.TestCase):
    def test_roundtrip_small_payload(self):
        msg = {"m": "batch", "b": 1, "w": [{"i": "a1b2c3d4e5f60708", "k": 82.4, "t": NOW - 100}]}
        chunks = encode_chunks(7, msg, 16)
        self.assertTrue(all(len(c) <= 20 for c in chunks))
        r = Reassembler()
        out = []
        for c in chunks:
            out += r.feed(c, NOW)
        self.assertEqual(out, [msg])

    def test_out_of_order(self):
        msg = {"m": "hello", "v": 1, "d": "gtr4-abc", "ts": NOW, "p": 3}
        chunks = encode_chunks(9, msg, 16)
        self.assertGreater(len(chunks), 1)
        r = Reassembler()
        out = []
        for c in reversed(chunks):
            out += r.feed(c, NOW)
        self.assertEqual(out, [msg])

    def test_incomplete_expires(self):
        chunks = encode_chunks(3, {"m": "hello", "v": 1, "d": "x" * 40, "ts": NOW}, 16)
        r = Reassembler(timeout_s=10)
        r.feed(chunks[0], NOW)
        # partial expires; a fresh full send afterwards still works
        out = []
        for c in chunks:
            out += r.feed(c, NOW + 11)
        self.assertEqual(len(out), 1)

    def test_oversize_rejected(self):
        with self.assertRaises(ValueError):
            encode_chunks(1, {"x": "a" * 5000}, 16)

    def test_info_payload_is_short(self):
        self.assertLessEqual(len(info_payload(16)), 20)


class SessionTest(unittest.TestCase):
    def setUp(self):
        fd, self.db = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.store = Store(self.db)

    def tearDown(self):
        self.store.close()
        os.unlink(self.db)

    def session(self, **kwargs):
        defaults = dict(allowed_devices=[], allow_all=True)
        defaults.update(kwargs)
        return SyncSession(self.store, **defaults)

    def hello(self, session, ts=NOW, version=PROTO_VERSION, device="gtr4-abc"):
        return session.handle({"m": "hello", "v": version, "d": device, "ts": ts, "p": 1}, NOW)[0]

    def test_happy_path_with_dedupe(self):
        s = self.session()
        ack = self.hello(s)
        self.assertTrue(ack["ok"])
        self.assertEqual(ack["off"], 0)

        items = [
            {"i": "aaaa000000000001", "k": 82.4, "t": NOW - 60},
            {"i": "aaaa000000000002", "k": 500.0, "t": NOW - 50},  # kg out of range
        ]
        back = s.handle({"m": "batch", "b": 1, "w": items}, NOW)[0]
        self.assertEqual(back["acc"], ["aaaa000000000001"])
        self.assertEqual(back["rej"], [["aaaa000000000002", "kg out of range"]])

        # retry of the same batch: accepted item now reports as duplicate
        back2 = s.handle({"m": "batch", "b": 1, "w": items}, NOW)[0]
        self.assertEqual(back2["dup"], ["aaaa000000000001"])
        self.assertEqual(back2["acc"], [])

        s.handle({"m": "bye"}, NOW)
        rows = self.store.conn.execute("SELECT accepted, duplicated, rejected FROM sync_log").fetchall()
        self.assertEqual(rows, [(1, 1, 2)])

    def test_clock_correction(self):
        s = self.session()
        ack = self.hello(s, ts=NOW - 1000)  # watch 1000 s behind
        self.assertEqual(ack["off"], 1000)
        s.handle({"m": "batch", "b": 1, "w": [{"i": "bbbb000000000001", "k": 80.0, "t": NOW - 1000}]}, NOW)
        ts, offset = self.store.conn.execute("SELECT ts, clock_offset_s FROM body_weights").fetchone()
        self.assertEqual(ts, NOW)
        self.assertEqual(offset, 1000)

    def test_small_skew_not_corrected(self):
        s = self.session()
        ack = self.hello(s, ts=NOW - 120)
        self.assertEqual(ack["off"], 0)

    def test_version_mismatch(self):
        ack = self.hello(self.session(), version=99)
        self.assertFalse(ack["ok"])
        self.assertEqual(ack["err"], "version")

    def test_allowlist(self):
        s = self.session(allow_all=False, allowed_devices=["gtr4-good"])
        self.assertEqual(self.hello(s, device="gtr4-evil")["err"], "device")
        self.assertTrue(self.hello(s, device="gtr4-good")["ok"])

    def test_batch_before_hello_rejected(self):
        s = self.session()
        back = s.handle({"m": "batch", "b": 1, "w": [{"i": "cccc000000000001", "k": 80.0, "t": NOW}]}, NOW)[0]
        self.assertEqual(back["acc"], [])
        self.assertEqual(back["rej"], [["*", "no hello"]])


if __name__ == "__main__":
    unittest.main()
