"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { performance } = require("node:perf_hooks");

const {
  backendEnvironment,
  bounded,
  exited,
  startSampler,
} = require("./run.cjs");

async function control(sampled, python) {
  const workload = `
        const {spawn}=require('node:child_process');
        process.on('message', message => {
            if(message==='go'){
                const child=spawn(process.execPath,['-e','let sum=0;for(let i=0;i<80000000;i++)sum=(sum+i)|0;setTimeout(()=>{},250)'],{stdio:'ignore'});
                let sum=0;for(let i=0;i<80000000;i++)sum=(sum+i)|0;
                child.on('exit',code=>{process.send({code,sum});process.disconnect();});
            }
        });
        process.send('ready');
    `;
  const backend = spawn(process.execPath, ["-e", workload], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
    env: backendEnvironment(),
  });
  const backendExit = exited(backend);
  let sampler;
  let stopped = false;
  try {
    await bounded(
      Promise.race([
        new Promise((resolve) => backend.once("message", resolve)),
        backendExit.then(() => {
          throw new Error("Control backend exited before ready");
        }),
      ]),
      15000,
      "Control backend readiness"
    );
    if (sampled) sampler = await startSampler(backend.pid, python);
    const resultReady = new Promise((resolve) =>
      backend.once("message", resolve)
    );
    const start = performance.now();
    backend.send("go");
    const result = await bounded(
      Promise.race([
        resultReady,
        backendExit.then((exit) => {
          throw new Error(
            `Control backend exited before result: ${JSON.stringify(exit)}`
          );
        }),
      ]),
      30000,
      "Fixed CPU control"
    );
    const elapsedMs = performance.now() - start;
    assert.equal(result.code, 0);
    assert.equal(
      (await bounded(backendExit, 5000, "Control backend exit")).code,
      0
    );
    let summary;
    if (sampler) {
      stopped = true;
      summary = await sampler.stop();
      assert.equal(summary.status, "MEASURED");
      assert(
        summary.peakSampledProcesses >= 2,
        "The actual owned descendant was not observed"
      );
      assert(summary.peakSampledTreeThreads > 0);
      assert(summary.processIntervals.some((row) => row.cpuSeconds > 0));
      assert(
        summary.threadIntervals.some(
          (row) =>
            typeof row.interval === "object" && row.interval.cpuSeconds > 0
        )
      );
      assert.equal(
        summary.finalObservedProcesses,
        0,
        "Owned process remained after cleanup"
      );
    }
    return { sampled, elapsedMs, result, summary };
  } finally {
    if (backend.exitCode === null && backend.signalCode === null)
      backend.kill();
    await bounded(backendExit, 5000, "Control failure retirement");
    if (sampler && !stopped) await sampler.stop();
  }
}

(async () => {
  const target = process.argv[2];
  if (!target || fs.existsSync(target))
    throw new Error("Provide a new control-result path");
  const results = [];
  for (const sampled of [false, true, true, false])
    results.push(await control(sampled, process.argv[3] ?? "python"));
  const baseline = (results[0].elapsedMs + results[3].elapsedMs) / 2;
  const sampled = (results[1].elapsedMs + results[2].elapsedMs) / 2;
  const receipt = {
    results,
    observedElapsedRatio: sampled / baseline,
    scope:
      "Fixed-workload ABBA observer control, not a statistically qualified overhead correction or Pyrefly measurement. Do not subtract this ratio from benchmark values.",
  };
  fs.writeFileSync(target, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      controls: 4,
      passed: 4,
      observedElapsedRatio: receipt.observedElapsedRatio,
    })
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
