import base64
import os
import tempfile
import unittest

from weightlog.memo import MemoAssembler
from weightlog.protocol import PROTO_VERSION, SyncSession
from weightlog.store import Store

NOW = 1790000000
MEMO_ID = "a1b2c3d4e5f60718"


def parts_of(data: bytes, size: int) -> list[bytes]:
    return [data[i : i + size] for i in range(0, len(data), size)]


class MemoTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.tmp.name, "t.db"))
        self.memo_dir = os.path.join(self.tmp.name, "memos")
        self.assembler = MemoAssembler(self.memo_dir)
        # Stand-in for the watch's Opus output; contents are opaque to us.
        self.audio = bytes(range(256)) * 12  # 3072 bytes
        self.parts = parts_of(self.audio, 1024)

    def tearDown(self):
        self.tmp.cleanup()

    def session(self) -> SyncSession:
        s = SyncSession(self.store, [], True, assembler=self.assembler)
        s.handle({"m": "hello", "v": PROTO_VERSION, "d": "gtr4-test", "ts": NOW, "p": 0}, NOW)
        return s

    def begin(self, session, **over):
        msg = {
            "m": "memo",
            "id": MEMO_ID,
            "ts": NOW,
            "secs": 4,
            "bytes": len(self.audio),
            "parts": len(self.parts),
        }
        msg.update(over)
        return session.handle(msg, NOW)[0]

    def send_part(self, session, n):
        return session.handle(
            {"m": "memo_part", "id": MEMO_ID, "n": n, "d": base64.b64encode(self.parts[n]).decode()},
            NOW,
        )[0]

    def test_full_transfer_stores_the_memo(self):
        s = self.session()
        self.assertEqual(self.begin(s), {"m": "memo_ack", "id": MEMO_ID, "ok": True, "have": 0})

        for n in range(len(self.parts) - 1):
            ack = self.send_part(s, n)
            self.assertTrue(ack["ok"])
            self.assertEqual(ack["have"], n + 1)
            self.assertNotIn("done", ack)

        final = self.send_part(s, len(self.parts) - 1)
        self.assertTrue(final["ok"])
        self.assertTrue(final["done"])

        rows = list(self.store.conn.execute("select id, secs, bytes, path from voice_memos"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], MEMO_ID)
        self.assertEqual(rows[0][2], len(self.audio))
        # The bytes on disk are exactly what the watch sent.
        with open(rows[0][3], "rb") as fh:
            self.assertEqual(fh.read(), self.audio)

    def test_resumes_after_a_dropped_connection(self):
        s = self.session()
        self.begin(s)
        self.send_part(s, 0)  # then the link drops

        s2 = self.session()
        ack = self.begin(s2)
        self.assertEqual(ack["have"], 1, "must resume at the first missing part")
        for n in range(1, len(self.parts)):
            reply = self.send_part(s2, n)
        self.assertTrue(reply["done"])
        with open(list(self.store.conn.execute("select path from voice_memos"))[0][0], "rb") as fh:
            self.assertEqual(fh.read(), self.audio)

    def test_out_of_order_part_is_refused_and_restates_position(self):
        s = self.session()
        self.begin(s)
        self.send_part(s, 0)

        ack = self.send_part(s, 2)  # skips part 1
        self.assertFalse(ack["ok"])
        self.assertEqual(ack["have"], 1)

        # A replayed part is likewise refused, without corrupting the file.
        ack = self.send_part(s, 0)
        self.assertFalse(ack["ok"])
        self.assertEqual(ack["have"], 1)

    def test_already_stored_memo_is_reported_done(self):
        s = self.session()
        self.begin(s)
        for n in range(len(self.parts)):
            self.send_part(s, n)

        ack = self.begin(self.session())
        self.assertTrue(ack["ok"])
        self.assertTrue(ack["done"], "watch should be told to drop its copy")

    def test_declared_size_is_enforced(self):
        s = self.session()
        # Claim fewer bytes than will actually be sent.
        self.begin(s, bytes=len(self.audio) - 500)
        ok_so_far = True
        for n in range(len(self.parts)):
            ok_so_far = self.send_part(s, n)["ok"]
            if not ok_so_far:
                break
        self.assertFalse(ok_so_far, "overrunning the declared size must be refused")
        self.assertEqual(list(self.store.conn.execute("select count(*) from voice_memos"))[0][0], 0)

    def test_memo_without_hello_is_refused(self):
        s = SyncSession(self.store, [], True, assembler=self.assembler)
        ack = self.begin(s)
        self.assertFalse(ack["ok"])
        self.assertEqual(ack["err"], "no hello")

    def test_memos_disabled_when_no_directory_configured(self):
        s = SyncSession(self.store, [], True, assembler=None)
        s.handle({"m": "hello", "v": PROTO_VERSION, "d": "gtr4-test", "ts": NOW, "p": 0}, NOW)
        ack = self.begin(s)
        self.assertFalse(ack["ok"])
        self.assertEqual(ack["err"], "memos disabled")

    def test_bad_ids_and_sizes_are_rejected(self):
        s = self.session()
        self.assertFalse(self.begin(s, id="../etc/passwd")["ok"])
        self.assertFalse(self.begin(s, parts=0)["ok"])
        self.assertFalse(self.begin(s, bytes=0)["ok"])
        self.assertFalse(self.begin(s, bytes=99_000_000)["ok"])


if __name__ == "__main__":
    unittest.main()
