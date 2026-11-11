"use strict";

const fs = require("node:fs");
const path = require("node:path");

function addDirectoryReading(imports, getMemory, preopens) {
  const directories = new Map(
    Object.values(preopens).map((hostPath, index) => [
      3 + index,
      { hostPath: path.resolve(hostPath), root: path.resolve(hostPath) },
    ])
  );
  const originalOpen = imports.path_open;
  const originalClose = imports.fd_close;
  const originalRead = imports.fd_readdir;
  let adaptedReads = 0;

  imports.path_open = (...args) => {
    const result = originalOpen(...args);
    if (result !== 0 || (args[4] & 2) === 0) return result;
    const parent = directories.get(args[0]);
    if (!parent) throw new Error("Untracked WASI directory descriptor");
    const memory = getMemory().buffer;
    const relative = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(memory, args[2], args[3])
    );
    const hostPath = path.resolve(parent.hostPath, relative);
    const fromRoot = path.relative(parent.root, hostPath);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(".." + path.sep) ||
      path.isAbsolute(fromRoot)
    ) {
      throw new Error("WASI directory escaped its preopen");
    }
    const opened = new DataView(memory).getUint32(args[8], true);
    directories.set(opened, { hostPath, root: parent.root });
    return result;
  };

  imports.fd_close = (fd) => {
    const result = originalClose(fd);
    if (result === 0) directories.delete(fd);
    return result;
  };

  imports.fd_readdir = (fd, pointer, length, cookie, used) => {
    const result = originalRead(fd, pointer, length, cookie, used);
    if (result !== 52) return result;
    // Node's Windows WASI returns NOSYS for directory enumeration.
    const directory = directories.get(fd);
    if (!directory) return 8;
    if (cookie < 0n || cookie > BigInt(Number.MAX_SAFE_INTEGER)) return 28;
    directory.entries ??= fs
      .readdirSync(directory.hostPath, { withFileTypes: true })
      .map((entry) => {
        const name = Buffer.from(entry.name);
        const record = Buffer.alloc(24 + name.length);
        record.writeBigUInt64LE(
          fs.lstatSync(path.join(directory.hostPath, entry.name), {
            bigint: true,
          }).ino,
          8
        );
        record.writeUInt32LE(name.length, 16);
        record[20] = entry.isDirectory()
          ? 3
          : entry.isFile()
          ? 4
          : entry.isSymbolicLink()
          ? 7
          : 0;
        name.copy(record, 24);
        return record;
      });
    const start = Number(cookie);
    if (start > directory.entries.length) return 28;
    const memory = getMemory().buffer;
    const target = Buffer.from(memory, pointer, length);
    let written = 0;
    for (let index = start; index < directory.entries.length; index++) {
      const record = directory.entries[index];
      record.writeBigUInt64LE(BigInt(index + 1), 0);
      const count = Math.min(record.length, length - written);
      record.copy(target, written, 0, count);
      written += count;
      if (written === length) break;
    }
    new DataView(memory).setUint32(used, written, true);
    adaptedReads++;
    return 0;
  };
  return () => ({ adaptedReads });
}

module.exports = { addDirectoryReading };
