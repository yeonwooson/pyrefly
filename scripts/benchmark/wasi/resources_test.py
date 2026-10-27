# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

import os
import subprocess
import sys
import time
import unittest
from pathlib import Path

import resources


class ResourceTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform in ("win32", "linux"), "OS probe unsupported")
    def test_owned_descendant_cpu_and_retirement(self):
        child = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import time; sum(i*i for i in range(5000000)); time.sleep(0.4)",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        try:
            probe = resources.TreeProbe(os.getpid())
            samples = []
            for _ in range(60):
                row = probe.read()
                row["at"] = time.perf_counter()
                samples.append(row)
                if child.poll() is not None:
                    break
                time.sleep(0.025)
            self.assertEqual(child.wait(timeout=5), 0)
            final = probe.read()
            self.assertFalse(any(row["pid"] == child.pid for row in final["processes"]))
            result = resources.summarize(samples, os.cpu_count())
            descendant = [
                row for row in result["processIntervals"] if row["pid"] == child.pid
            ]
            self.assertEqual(len(descendant), 1)
            self.assertGreater(descendant[0]["cpuSeconds"], 0)
            self.assertTrue(
                any(row["pid"] == child.pid for row in result["threadIntervals"])
            )
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
            child.stderr.close()

    @unittest.skipUnless(sys.platform in ("win32", "linux"), "OS probe unsupported")
    def test_live_process_identity_threads_and_executable(self):
        probe_type = (
            resources.WindowsProbe if sys.platform == "win32" else resources.LinuxProbe
        )
        row = probe_type(os.getpid()).read()
        self.assertTrue(row["present"])
        self.assertEqual(row["pid"], os.getpid())
        self.assertTrue(row["creation"])
        self.assertGreater(row["threadCount"], 0)
        self.assertGreaterEqual(row["cpuSeconds"], 0)
        self.assertTrue(row["executableName"])
        if sys.platform == "win32":
            self.assertEqual(
                row["executableName"].lower(), Path(sys.executable).name.lower()
            )

    def test_normalization_and_invalid_counters(self):
        row = resources.cpu_interval(
            {"at": 1, "cpuSeconds": 2}, {"at": 3, "cpuSeconds": 3}, 4
        )
        self.assertEqual(row["oneCorePercent"], 50)
        self.assertEqual(row["machinePercent"], 12.5)
        for start, end, cpus in [
            ({"at": 2, "cpuSeconds": 3}, {"at": 1, "cpuSeconds": 2}, 4),
            ({"at": 1, "cpuSeconds": 1}, {"at": 2, "cpuSeconds": 0}, 4),
            ({"at": 1, "cpuSeconds": 1}, {"at": 2, "cpuSeconds": 2}, 0),
            ({"at": 1, "cpuSeconds": 1}, {"at": float("nan"), "cpuSeconds": 2}, 4),
        ]:
            with self.subTest(start=start, end=end, cpus=cpus):
                with self.assertRaises(ValueError):
                    resources.cpu_interval(start, end, cpus)

    def test_reused_thread_and_process_ids_remain_separate(self):
        rows = []
        for at, process, thread, cpu in [
            (1, "1", "10", 0),
            (2, "1", "10", 1),
            (3, "1", "20", 0),
            (4, "1", "20", 1),
            (5, "2", "30", 0),
            (6, "2", "30", 1),
        ]:
            rows.append(
                {
                    "present": True,
                    "pid": 42,
                    "creation": process,
                    "at": at,
                    "cpuSeconds": cpu,
                    "threadCount": 1,
                    "rssBytes": 100,
                    "threads": [{"tid": 7, "creation": thread, "cpuSeconds": cpu}],
                    "unavailableThreads": [],
                }
            )
        result = resources.summarize(rows, 4)
        self.assertEqual(len(result["threadIntervals"]), 3)
        self.assertEqual(
            [row["interval"]["cpuSeconds"] for row in result["threadIntervals"]],
            [1, 1, 1],
        )
        self.assertEqual(
            [
                (row["firstObservedAt"], row["lastObservedAt"])
                for row in result["threadIntervals"]
            ],
            [(1, 2), (3, 4), (5, 6)],
        )
        self.assertEqual(len(result["processIntervals"]), 2)

    def test_absence_does_not_invent_zero_cpu(self):
        self.assertEqual(
            resources.summarize([{"present": False}], 4)["status"], "NOT_MEASURED"
        )


if __name__ == "__main__":
    unittest.main()
