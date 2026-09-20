"""Incremental collection preserves complete history and raw-page provenance."""
from collections import Counter
import json
import hashlib
from pathlib import Path
import tempfile
import unittest

from backend.tracker import validate_document
from backend.coverage import _observed_adjacency
from tests.test_fetch_pull_history import (
    FakeClient, api_response, collector_module, make_capture, make_prepared, make_writer,
)


def pull(timestamp, item=1):
    return {"item": item, "pool_id": 1, "item_num": 1, "time": timestamp}


def occurrences(rows):
    return Counter(json.dumps(row, sort_keys=True) for row in rows)


class IncrementalTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.prepared = make_prepared()
        self.history = [pull(timestamp) for timestamp in range(120, 0, -10)]

    def collect(self, rows, *, prepared=None, page_size=3, full=False):
        prepared = prepared or self.prepared
        pages = [rows[index:index + page_size] for index in range(0, len(rows), page_size)] or [[]]

        def handler(type_id, cursor, call_number):
            if type_id != 3:
                return api_response([])
            index = int(cursor) if cursor is not None else 0
            return api_response(pages[index], next_cursor=str(index + 1) if index + 1 < len(pages) else "")

        client = FakeClient(prepared, handler)
        writer = make_writer(self.root, prepared, start_type=3, consecutive_misses=1, max_type=5)
        options = {"baseline": {}} if full else {}
        collector_module.PullHistoryCollector(
            client, writer, start_type=3, consecutive_misses=1, max_type=5, **options
        ).run()
        self.assertTrue(writer.manifest["complete"])
        document = json.loads((writer.run_dir / "records.json").read_text("utf-8"))
        raw = {path.relative_to(writer.run_dir).as_posix(): path.read_text("utf-8")
               for path in writer.run_dir.glob("raw/**/*.json")}
        validate_document(document, writer.manifest, raw)
        return writer, [cursor for type_id, cursor in client.calls if type_id == 3]

    def assert_history(self, writer, expected):
        actual = [entry["record"] for entry in writer.records if entry["source_type_id"] == 3]
        self.assertEqual(occurrences(actual), occurrences(expected))
        self.assertEqual(actual, expected)

    def test_equal_time_sequence_survives_full_and_incremental_collection(self):
        baseline = [pull(120, item=2), pull(120, item=3)] + self.history
        self.collect(baseline, page_size=2, full=True)
        updated = [pull(120, item=4)] + baseline
        writer, calls = self.collect(updated, page_size=2)
        self.assertLess(len(calls), (len(updated) + 1) // 2)
        self.assert_history(writer, updated)

    def test_reordered_equal_time_rewards_require_full_pagination(self):
        baseline = [pull(120, item=2), pull(120, item=3)] + self.history
        self.collect(baseline, page_size=2, full=True)
        updated = [baseline[1], baseline[0]] + baseline[2:]
        writer, calls = self.collect(updated, page_size=2)
        self.assertEqual(len(calls), (len(updated) + 1) // 2)
        self.assert_history(writer, updated)

    def test_interleaved_new_equal_time_reward_requires_full_pagination(self):
        baseline = [pull(120, item=2), pull(120, item=3)] + self.history
        self.collect(baseline, page_size=2, full=True)
        updated = baseline[:1] + [pull(120, item=4)] + baseline[1:]
        writer, calls = self.collect(updated, page_size=2)
        self.assertEqual(len(calls), (len(updated) + 1) // 2)
        self.assert_history(writer, updated)

    def test_unchanged_history_stops_after_verified_overlap(self):
        self.collect(self.history, full=True)
        writer, calls = self.collect(self.history)
        self.assertEqual(calls, [None])
        self.assert_history(writer, self.history)

    def test_new_pull_shifts_pages_and_preserves_saved_tail(self):
        baseline, _ = self.collect(self.history, full=True)
        original_raw = [path.read_bytes() for path in sorted(baseline.run_dir.glob("raw/type_0003/*.json"))]
        updated = [pull(130)] + self.history
        writer, calls = self.collect(updated)
        self.assertEqual(calls, [None, "1"])
        self.assert_history(writer, updated)
        merged_raw = [path.read_bytes() for path in writer.run_dir.glob("raw/type_0003/*.json")]
        for raw in original_raw:
            self.assertIn(raw, merged_raw)

    def test_incremental_empty_overlap_pages_preserve_coverage(self):
        self.collect(self.history, full=True)
        for timestamp in (130, 140, 150):
            updated = [pull(value) for value in range(timestamp, 120, -10)] + self.history
            writer, _ = self.collect(updated)
            document = json.loads((writer.run_dir / "records.json").read_text("utf-8"))
            empty_pages = {}
            for path in writer.run_dir.glob("raw/type_*/*.json"):
                if not json.loads(path.read_text("utf-8"))["data"]["list"]:
                    type_id = str(int(path.parent.name.split("_")[1]))
                    empty_pages.setdefault(type_id, []).append(int(path.stem.split("_")[1]))
            counts = Counter()
            identities = []
            for entry in document["records"]:
                key = hashlib.sha256(json.dumps(entry["record"], sort_keys=True,
                    separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
                identity = entry["source_type_id"], key
                counts[identity] += 1
                identities.append((*identity, counts[identity]))
            expected = set(zip(identities, identities[1:]))
            self.assertNotEqual(_observed_adjacency([document], counts), expected)
            document["_coverage_empty_pages"] = empty_pages
            self.assertEqual(_observed_adjacency([document], counts), expected)
            # Missing even one retained empty page leaves its boundary unknown.
            empty_pages["3"].pop(0)
            self.assertNotEqual(_observed_adjacency([document], counts), expected)

    def test_identical_newest_pulls_across_pages_preserve_occurrences(self):
        baseline = [pull(120), pull(120)] + self.history[1:]
        self.collect(baseline, page_size=2, full=True)
        updated = [pull(120)] + baseline
        writer, calls = self.collect(updated, page_size=2)
        self.assertLess(len(calls), (len(updated) + 1) // 2)
        self.assert_history(writer, updated)

    def test_different_account_cannot_supply_overlap(self):
        self.collect(self.history, full=True)
        other = make_prepared(account="different-account@example.invalid")
        writer, calls = self.collect(self.history, prepared=other)
        self.assertEqual(len(calls), 4)
        self.assert_history(writer, self.history)

    def test_incomplete_export_cannot_supply_overlap(self):
        baseline, _ = self.collect(self.history, full=True)
        baseline.fail_run("interrupted", "Synthetic interruption")
        writer, calls = self.collect(self.history)
        self.assertEqual(len(calls), 4)
        self.assert_history(writer, self.history)

    def test_corrupt_raw_archive_cannot_supply_overlap(self):
        baseline, _ = self.collect(self.history, full=True)
        path = baseline.run_dir / "raw/type_0003/page_0001.json"
        path.write_text('{"code":0,"data":{"list":[],"next":""}}', encoding="utf-8")
        writer, calls = self.collect(self.history)
        self.assertEqual(len(calls), 4)
        self.assert_history(writer, self.history)

    def test_changed_overlap_falls_back_to_full_pagination(self):
        self.collect(self.history, full=True)
        changed = list(self.history)
        changed[1] = pull(110, item=999)
        writer, calls = self.collect(changed)
        self.assertEqual(len(calls), 4)
        self.assert_history(writer, changed)

    def test_changed_trailing_overlap_record_is_not_discarded(self):
        self.collect(self.history, full=True)
        changed = list(self.history)
        changed[2] = pull(100, item=999)
        writer, calls = self.collect(changed)
        self.assertEqual(len(calls), 4)
        self.assert_history(writer, changed)

    def test_transformed_page_preserves_original_response_and_baseline(self):
        baseline, _ = self.collect(self.history, full=True)
        before = {path.relative_to(baseline.run_dir): path.read_bytes()
                  for path in baseline.run_dir.rglob("*.json")}
        updated = [pull(130)] + self.history
        writer, _ = self.collect(updated)
        path = writer.run_dir / "raw/type_0003/page_0001.json"
        page = json.loads(path.read_text("utf-8"))
        receipt = writer.run_dir / page["_collector"]["original_response"]
        self.assertEqual(json.loads(receipt.read_text("utf-8"))["data"]["list"], updated[:3])
        self.assertEqual(page["data"]["list"], [pull(130)])
        for relative, raw in before.items():
            self.assertEqual((baseline.run_dir / relative).read_bytes(), raw)

    def test_explicit_full_refresh_bypasses_saved_overlap(self):
        self.collect(self.history, full=True)
        writer, calls = self.collect(self.history, full=True)
        self.assertEqual(len(calls), 4)
        self.assert_history(writer, self.history)

    def test_repeated_updates_use_latest_merged_baseline(self):
        self.collect(self.history, full=True)
        first_update = [pull(130)] + self.history
        previous, _ = self.collect(first_update)
        second_update = [pull(140)] + first_update
        writer, calls = self.collect(second_update)
        self.assertEqual(calls, [None, "1"])
        self.assertEqual(writer.manifest["types"]["3"]["baseline_export"], previous.run_dir.name)
        self.assertEqual(writer.manifest["types"]["3"]["new_records"], 1)
        self.assert_history(writer, second_update)

    def test_uncertain_response_order_requires_full_pagination(self):
        self.collect(self.history, full=True)
        shuffled = list(self.history)
        shuffled[0], shuffled[1] = shuffled[1], shuffled[0]
        writer, calls = self.collect(shuffled)
        self.assertEqual(len(calls), 4)
        self.assert_history(writer, shuffled)

    def test_same_account_different_server_or_channel_cannot_reuse(self):
        self.collect(self.history, full=True)
        other_channel = collector_module.prepare_request(collector_module.parse_capture(
            make_capture().replace("game_channel_id=5", "game_channel_id=6")
        ))
        for prepared in (make_prepared(server=11), other_channel):
            with self.subTest(server=prepared.body, channel=prepared.capture.game_channel_id):
                writer, calls = self.collect(self.history, prepared=prepared)
                self.assertEqual(len(calls), 4)
                self.assert_history(writer, self.history)

    def test_failure_before_overlap_retains_valid_partial_export(self):
        self.collect(self.history, full=True)
        fresh_page = [pull(130)] + self.history[:2]

        def handler(type_id, cursor, call_number):
            if cursor is not None:
                raise collector_module.FetchError("Synthetic later-page failure")
            return api_response(fresh_page, next_cursor="later")

        client = FakeClient(self.prepared, handler)
        writer = make_writer(self.root, self.prepared, start_type=3, consecutive_misses=1, max_type=5)
        with self.assertRaises(collector_module.ControlError):
            collector_module.PullHistoryCollector(
                client, writer, start_type=3, consecutive_misses=1, max_type=5
            ).run()
        self.assertFalse(writer.manifest["complete"])
        self.assert_history(writer, fresh_page)
        document = json.loads((writer.run_dir / "records.json").read_text("utf-8"))
        raw = {path.relative_to(writer.run_dir).as_posix(): path.read_text("utf-8")
               for path in writer.run_dir.glob("raw/**/*.json")}
        validate_document(document, writer.manifest, raw)

    def test_saved_type_beyond_empty_probe_gap_is_still_checked(self):
        baseline = make_writer(self.root, self.prepared, start_type=3, consecutive_misses=1, max_type=10)
        baseline.start_type(7)
        baseline.save_page(7, 1, api_response(self.history).body, self.history)
        baseline.finish_type(7, "complete")
        baseline.complete_run()

        def handler(type_id, cursor, call_number):
            return api_response(self.history if type_id in (3, 7) else [])

        client = FakeClient(self.prepared, handler)
        writer = make_writer(self.root, self.prepared, start_type=3, consecutive_misses=1, max_type=10)
        collector_module.PullHistoryCollector(
            client, writer, start_type=3, consecutive_misses=1, max_type=10
        ).run()
        self.assertIn((7, None), client.calls)
        self.assertTrue(writer.manifest["complete"])
        self.assertEqual(writer.manifest["types"]["7"]["records"], len(self.history))
