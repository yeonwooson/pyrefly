# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.

"""Identity-scoped OS observations of the benchmark's owned backend tree."""

import argparse
import ctypes
import json
import math
import os
import queue
import sys
import threading
import time
from pathlib import Path


def cpu_interval(previous, current, logical_cpus):
    wall = current["at"] - previous["at"]
    cpu = current["cpuSeconds"] - previous["cpuSeconds"]
    if (
        not math.isfinite(wall)
        or not math.isfinite(cpu)
        or wall <= 0
        or cpu < 0
        or logical_cpus <= 0
    ):
        raise ValueError("Invalid resource-counter interval")
    return {
        "wallSeconds": wall,
        "cpuSeconds": cpu,
        "oneCorePercent": cpu / wall * 100,
        "machinePercent": cpu / wall * 100 / logical_cpus,
    }


class WindowsProbe:
    def __init__(self, pid):
        from ctypes import wintypes

        self.pid = pid
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.OpenThread.restype = wintypes.HANDLE
        self.kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [
            ctypes.POINTER(wintypes.FILETIME)
        ] * 4
        self.kernel.GetThreadTimes.argtypes = self.kernel.GetProcessTimes.argtypes
        self.kernel.GetExitCodeProcess.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.DWORD),
        ]
        self.kernel.QueryFullProcessImageNameW.argtypes = [
            wintypes.HANDLE,
            wintypes.DWORD,
            wintypes.LPWSTR,
            ctypes.POINTER(wintypes.DWORD),
        ]

        class ThreadEntry(ctypes.Structure):
            _fields_ = [
                ("size", wintypes.DWORD),
                ("usage", wintypes.DWORD),
                ("tid", wintypes.DWORD),
                ("pid", wintypes.DWORD),
                ("priority", wintypes.LONG),
                ("deltaPriority", wintypes.LONG),
                ("flags", wintypes.DWORD),
            ]

        class MemoryCounters(ctypes.Structure):
            _fields_ = [("size", wintypes.DWORD), ("faults", wintypes.DWORD)] + [
                (name, ctypes.c_size_t)
                for name in [
                    "peakWorkingSet",
                    "workingSet",
                    "peakPaged",
                    "paged",
                    "peakNonPaged",
                    "nonPaged",
                    "pagefile",
                    "peakPagefile",
                    "private",
                ]
            ]

        self.ThreadEntry = ThreadEntry
        self.MemoryCounters = MemoryCounters
        self.kernel.Thread32First.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(ThreadEntry),
        ]
        self.kernel.Thread32Next.argtypes = self.kernel.Thread32First.argtypes
        self.kernel.K32GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(MemoryCounters),
            wintypes.DWORD,
        ]
        self.creation = None

    def times(self, handle, thread=False):
        from ctypes import wintypes

        values = [wintypes.FILETIME() for _ in range(4)]
        function = self.kernel.GetThreadTimes if thread else self.kernel.GetProcessTimes
        if not function(handle, *[ctypes.byref(value) for value in values]):
            raise ctypes.WinError(ctypes.get_last_error())
        raw = [(value.dwHighDateTime << 32) | value.dwLowDateTime for value in values]
        return str(raw[0]), (raw[2] + raw[3]) / 10_000_000

    def read(self):
        from ctypes import wintypes

        handle = self.kernel.OpenProcess(0x410, False, self.pid)
        if not handle:
            code = ctypes.get_last_error()
            if code == 87:
                return {"present": False, "pid": self.pid}
            raise ctypes.WinError(code)
        try:
            creation, cpu = self.times(handle)
            if self.creation is not None and creation != self.creation:
                return {"present": False, "pid": self.pid, "differentCreation": True}
            self.creation = creation
            exit_code = wintypes.DWORD()
            if not self.kernel.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                raise ctypes.WinError(ctypes.get_last_error())
            if exit_code.value != 259:
                return {
                    "present": False,
                    "pid": self.pid,
                    "creation": creation,
                    "exitCode": exit_code.value,
                    "finalCpuSeconds": cpu,
                }
            image = ctypes.create_unicode_buffer(32768)
            image_length = wintypes.DWORD(len(image))
            if not self.kernel.QueryFullProcessImageNameW(
                handle, 0, image, ctypes.byref(image_length)
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            memory = self.MemoryCounters()
            memory.size = ctypes.sizeof(memory)
            if not self.kernel.K32GetProcessMemoryInfo(
                handle, ctypes.byref(memory), memory.size
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            threads = []
            unavailable = []
            snapshot = self.kernel.CreateToolhelp32Snapshot(4, 0)
            if snapshot == ctypes.c_void_p(-1).value:
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                entry = self.ThreadEntry()
                entry.size = ctypes.sizeof(entry)
                success = self.kernel.Thread32First(snapshot, ctypes.byref(entry))
                while success:
                    if entry.pid == self.pid:
                        thread = self.kernel.OpenThread(0x0800, False, entry.tid)
                        if thread:
                            try:
                                try:
                                    born, used = self.times(thread, thread=True)
                                    threads.append(
                                        {
                                            "tid": entry.tid,
                                            "creation": born,
                                            "cpuSeconds": used,
                                        }
                                    )
                                except OSError as error:
                                    unavailable.append(
                                        {"tid": entry.tid, "error": str(error)}
                                    )
                            finally:
                                self.kernel.CloseHandle(thread)
                        else:
                            unavailable.append(
                                {
                                    "tid": entry.tid,
                                    "error": str(
                                        ctypes.WinError(ctypes.get_last_error())
                                    ),
                                }
                            )
                    success = self.kernel.Thread32Next(snapshot, ctypes.byref(entry))
                if ctypes.get_last_error() != 18:
                    raise ctypes.WinError(ctypes.get_last_error())
            finally:
                self.kernel.CloseHandle(snapshot)
            return {
                "present": True,
                "pid": self.pid,
                "creation": creation,
                "executableName": Path(image.value).name,
                "cpuSeconds": cpu,
                "rssBytes": memory.workingSet,
                "threadCount": len(threads) + len(unavailable),
                "threads": threads,
                "unavailableThreads": unavailable,
            }
        finally:
            self.kernel.CloseHandle(handle)


class LinuxProbe:
    def __init__(self, pid):
        self.pid = pid
        self.creation = None
        self.hz = os.sysconf("SC_CLK_TCK")

    def stat(self, path):
        fields = path.read_text().rsplit(")", 1)[1].split()
        return fields[19], (int(fields[11]) + int(fields[12])) / self.hz

    def read(self):
        root = Path("/proc") / str(self.pid)
        try:
            creation, cpu = self.stat(root / "stat")
            if self.creation is not None and self.creation != creation:
                return {"pid": self.pid, "present": False, "differentCreation": True}
            self.creation = creation
            executable_name = (root / "comm").read_text().strip()
            threads = []
            unavailable = []
            for task in (root / "task").iterdir():
                try:
                    born, used = self.stat(task / "stat")
                    threads.append(
                        {"tid": int(task.name), "creation": born, "cpuSeconds": used}
                    )
                except FileNotFoundError:
                    unavailable.append(
                        {"tid": int(task.name), "error": "thread retired"}
                    )
            rss = int((root / "statm").read_text().split()[1]) * os.sysconf(
                "SC_PAGE_SIZE"
            )
            return {
                "present": True,
                "pid": self.pid,
                "creation": creation,
                "executableName": executable_name,
                "cpuSeconds": cpu,
                "rssBytes": rss,
                "threadCount": len(threads) + len(unavailable),
                "threads": threads,
                "unavailableThreads": unavailable,
            }
        except FileNotFoundError:
            return {"present": False, "pid": self.pid}


def parent_processes():
    if sys.platform == "linux":
        rows = []
        for directory in Path("/proc").iterdir():
            if not directory.name.isdigit():
                continue
            try:
                fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
                rows.append((int(directory.name), int(fields[1])))
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
        return rows
    from ctypes import wintypes

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("size", wintypes.DWORD),
            ("usage", wintypes.DWORD),
            ("pid", wintypes.DWORD),
            ("heap", ctypes.c_size_t),
            ("module", wintypes.DWORD),
            ("threads", wintypes.DWORD),
            ("parent", wintypes.DWORD),
            ("priority", wintypes.LONG),
            ("flags", wintypes.DWORD),
            ("name", wintypes.WCHAR * 260),
        ]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel.Process32NextW.argtypes = kernel.Process32FirstW.argtypes
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    rows = []
    try:
        entry = ProcessEntry()
        entry.size = ctypes.sizeof(entry)
        success = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while success:
            rows.append((entry.pid, entry.parent))
            success = kernel.Process32NextW(snapshot, ctypes.byref(entry))
        if ctypes.get_last_error() != 18:
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel.CloseHandle(snapshot)
    return rows


class TreeProbe:
    def __init__(self, pid):
        self.root = pid
        self.probe_type = WindowsProbe if sys.platform == "win32" else LinuxProbe
        self.known = {pid: self.probe_type(pid)}

    def read(self):
        root = self.known[self.root].read()
        parents = parent_processes()
        owned = {self.root} if root["present"] else set()
        while True:
            additions = {pid for pid, parent in parents if parent in owned}
            new = additions - owned
            if not new:
                break
            owned.update(new)
        for pid in owned:
            if pid not in self.known:
                self.known[pid] = self.probe_type(pid)
        processes = []
        retired = []
        for pid, probe in self.known.items():
            row = root if pid == self.root else probe.read()
            if row["present"]:
                if int(row["creation"]) < int(self.known[self.root].creation):
                    raise RuntimeError("Observed descendant predates the owned root")
                processes.append(row)
            elif "finalCpuSeconds" in row:
                retired.append(row)
        return {
            **root,
            "processes": processes,
            "retiredProcesses": retired,
            "observedProcessCount": len(processes),
            "treeThreadCount": sum(row["threadCount"] for row in processes),
            "treeRssBytes": sum(row["rssBytes"] for row in processes),
        }


def summarize(samples, logical_cpus):
    present = [sample for sample in samples if sample.get("present")]
    if not present:
        return {"status": "NOT_MEASURED", "reason": "No identity-valid process sample"}
    first, last = present[0], present[-1]
    lifetimes = {}
    process_lifetimes = {}
    process_names = {}
    for sample in samples:
        for process in sample.get(
            "processes", [sample] if sample.get("present") else []
        ):
            process_key = (process["pid"], process["creation"])
            process_names[process_key] = process.get("executableName", "NOT_MEASURED")
            point = {"at": sample["at"], "cpuSeconds": process["cpuSeconds"]}
            if process_key not in process_lifetimes:
                process_lifetimes[process_key] = [point, point]
            else:
                process_lifetimes[process_key][1] = point
            for thread in process["threads"]:
                key = (*process_key, thread["tid"], thread["creation"])
                point = {"at": sample["at"], "cpuSeconds": thread["cpuSeconds"]}
                if key not in lifetimes:
                    lifetimes[key] = [point, point]
                else:
                    lifetimes[key][1] = point
        for process in sample.get("retiredProcesses", []):
            key = (process["pid"], process["creation"])
            if key in process_lifetimes:
                process_lifetimes[key][1] = {
                    "at": sample["at"],
                    "cpuSeconds": process["finalCpuSeconds"],
                }
    thread_usage = []
    for (pid, process_creation, tid, born), (start, end) in lifetimes.items():
        usage = (
            cpu_interval(start, end, logical_cpus) if end["at"] > start["at"] else None
        )
        thread_usage.append(
            {
                "pid": pid,
                "processCreation": process_creation,
                "tid": tid,
                "creation": born,
                "firstObservedAt": start["at"],
                "lastObservedAt": end["at"],
                "interval": usage or "NOT_MEASURED",
            }
        )
    process_intervals = [
        {
            "pid": pid,
            "creation": born,
            "executableName": process_names[(pid, born)],
            **cpu_interval(start, end, logical_cpus),
        }
        for (pid, born), (start, end) in process_lifetimes.items()
        if end["at"] > start["at"]
    ]
    wall = samples[-1]["at"] - samples[0]["at"]
    cpu = sum(row["cpuSeconds"] for row in process_intervals)
    return {
        "status": "MEASURED",
        "processIdentity": {"pid": first["pid"], "creation": first["creation"]},
        "logicalCpus": logical_cpus,
        "samples": len(present),
        "initialThreads": first["threadCount"],
        "peakSampledThreads": max(sample["threadCount"] for sample in present),
        "finalSampledThreads": last["threadCount"],
        "initialProcesses": samples[0].get("observedProcessCount", 1),
        "peakSampledProcesses": max(
            sample.get("observedProcessCount", 1) for sample in samples
        ),
        "finalObservedProcesses": samples[-1].get("observedProcessCount", 0),
        "peakSampledTreeThreads": max(
            sample.get("treeThreadCount", sample.get("threadCount", 0))
            for sample in samples
        ),
        "peakSampledTreeRssBytes": max(
            sample.get("treeRssBytes", sample.get("rssBytes", 0)) for sample in samples
        ),
        "processIntervals": process_intervals,
        "observedTreeInterval": {
            "wallSeconds": wall,
            "cpuSeconds": cpu,
            "oneCorePercent": cpu / wall * 100,
            "machinePercent": cpu / wall * 100 / logical_cpus,
        }
        if wall > 0
        else "NOT_MEASURED",
        "peakSampledRssBytes": max(sample["rssBytes"] for sample in present),
        "threadIntervals": thread_usage,
        "unavailableThreadObservations": sum(
            len(process["unavailableThreads"])
            for sample in samples
            for process in sample.get(
                "processes", [sample] if sample.get("present") else []
            )
        ),
        "scope": "Creation-bound backend and observed descendants, including Node's Worker/runtime threads; collector excluded",
        "limits": "Can miss short-lived processes/threads. CPU intervals are first-to-last observations, not full lifetimes or exclusive query CPU. OS threads are not analysis-worker counts. Coarse CPU counters can yield zero deltas.",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--interval-ms", type=int, default=100)
    arguments = parser.parse_args()
    if arguments.pid <= 0 or not 20 <= arguments.interval_ms <= 1000:
        parser.error("Expected positive PID and interval in [20, 1000] ms")
    if sys.platform not in ("win32", "linux"):
        print(
            json.dumps(
                {"kind": "ready", "status": "NOT_MEASURED", "reason": sys.platform}
            ),
            flush=True,
        )
        return
    probe = TreeProbe(arguments.pid)
    commands = queue.Queue()

    def read_commands():
        try:
            for line in sys.stdin:
                commands.put(json.loads(line))
            commands.put({"command": "stop"})
        except json.JSONDecodeError as error:
            commands.put({"command": "invalid", "error": str(error)})

    threading.Thread(target=read_commands, daemon=True).start()
    samples = []
    cpu_start = time.process_time()
    while True:
        sample = probe.read()
        sample["at"] = time.perf_counter()
        samples.append(sample)
        print(json.dumps({"kind": "sample", **sample}), flush=True)
        if len(samples) == 1:
            if not sample.get("present"):
                raise RuntimeError("Owned backend absent before first resource sample")
            print(json.dumps({"kind": "ready", "status": "MEASURED"}), flush=True)
        try:
            command = commands.get(timeout=arguments.interval_ms / 1000)
        except queue.Empty:
            continue
        if command["command"] == "stop":
            final = probe.read()
            final["at"] = time.perf_counter()
            samples.append(final)
            print(json.dumps({"kind": "sample", **final}), flush=True)
            break
        raise ValueError("Unknown sampler command")
    cpus = os.cpu_count()
    if cpus is None:
        raise RuntimeError(
            "Logical CPU count unavailable; cannot normalize utilization"
        )
    summary = summarize(samples, cpus)
    summary["samplerCpuSeconds"] = time.process_time() - cpu_start
    summary["intervalMs"] = arguments.interval_ms
    print(json.dumps({"kind": "summary", **summary}), flush=True)


if __name__ == "__main__":
    main()
