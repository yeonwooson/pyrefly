import importlib.util
import os
import sys
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "benchmark_sample", Path(__file__).with_name("sample.py")
)
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)


class ResourceTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform in ("win32", "linux"), "OS probe unsupported")
    def test_live_process_probe_has_identity_threads_and_executable(self):
        probe_type = (
            sample.WindowsProbe if sys.platform == "win32" else sample.LinuxProbe
        )
        result = probe_type(os.getpid()).read()
        self.assertTrue(result["present"])
        self.assertEqual(result["pid"], os.getpid())
        self.assertTrue(result["creation"])
        self.assertGreater(result["threadCount"], 0)
        self.assertGreaterEqual(result["cpuSeconds"], 0)
        self.assertTrue(result["executableName"])
        if sys.platform == "win32":
            self.assertEqual(
                result["executableName"].lower(), Path(sys.executable).name.lower()
            )

    def test_utilization_has_explicit_denominators(self):
        result = sample.cpu_interval(
            {"at": 1, "cpuSeconds": 2}, {"at": 3, "cpuSeconds": 3}, 4
        )
        self.assertEqual(result["oneCorePercent"], 50)
        self.assertEqual(result["machinePercent"], 12.5)

    def test_invalid_counter_delta_fails(self):
        for start, end, cpus in [
            ({"at": 2, "cpuSeconds": 3}, {"at": 1, "cpuSeconds": 2}, 4),
            ({"at": 1, "cpuSeconds": 1}, {"at": 2, "cpuSeconds": 2}, 0),
            ({"at": 1, "cpuSeconds": 1}, {"at": float("nan"), "cpuSeconds": 2}, 4),
        ]:
            with self.subTest(start=start, end=end, cpus=cpus):
                with self.assertRaises(ValueError):
                    sample.cpu_interval(start, end, cpus)

    def test_reused_thread_id_is_not_one_lifetime(self):
        rows = []
        for at, creation, cpu in [
            (1, "10", 0),
            (2, "10", 1),
            (3, "20", 0),
            (4, "20", 1),
        ]:
            rows.append(
                {
                    "present": True,
                    "pid": 42,
                    "creation": "1",
                    "at": at,
                    "cpuSeconds": at,
                    "threadCount": 1,
                    "rssBytes": 100,
                    "threads": [{"tid": 7, "creation": creation, "cpuSeconds": cpu}],
                    "unavailableThreads": [],
                }
            )
        result = sample.summarize(rows, 4)
        self.assertEqual(len(result["threadIntervals"]), 2)
        self.assertEqual(
            [row["interval"]["cpuSeconds"] for row in result["threadIntervals"]],
            [1, 1],
        )
        self.assertEqual(
            [
                (row["firstObservedAt"], row["lastObservedAt"])
                for row in result["threadIntervals"]
            ],
            [(1, 2), (3, 4)],
        )

    def test_absence_does_not_invent_zero_cpu(self):
        result = sample.summarize([{"present": False}], 4)
        self.assertEqual(result["status"], "NOT_MEASURED")


if __name__ == "__main__":
    unittest.main()
