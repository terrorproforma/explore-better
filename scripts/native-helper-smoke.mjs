import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const root = process.cwd();
const helperPath = path.join(root, "native", "bin", process.platform === "win32" ? "explore-better-fs.exe" : "explore-better-fs");

async function main() {
  await fs.access(helperPath);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "explore-better-native-"));
  const sample = path.join(fixture, "sample.txt");
  await fs.writeFile(sample, "native allocation\n");
  await fs.mkdir(path.join(fixture, "folder"));
  const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "progress") return;
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  const request = (value) => new Promise((resolve, reject) => {
    pending.set(value.id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ version: 1, ...value })}\n`);
    setTimeout(() => {
      if (pending.delete(value.id)) reject(new Error(`Native request ${value.id} timed out.`));
    }, 10000).unref();
  });
  try {
    const hello = await request({ id: "hello", op: "hello" });
    const allocated = await request({ id: "allocated", op: "allocated-size", path: sample });
    const volume = await request({ id: "volume", op: "volume-info", path: fixture });
    const listed = await request({ id: "list", op: "enumerate", path: fixture });
    const scanned = await request({ id: "scan", op: "scan-tree", path: fixture });
    const cancelTarget = request({ id: "cancel-target", op: "scan-tree", path: fixture, maxEntries: 500000 });
    const cancelStarted = performance.now();
    const canceled = await request({ id: "cancel", op: "cancel", targetId: "cancel-target" });
    const cancelResponseMs = performance.now() - cancelStarted;
    await cancelTarget.catch(() => null);
    if (!hello.ok || hello.data.protocolVersion !== 1) throw new Error("Native protocol negotiation failed.");
    if (!allocated.ok || allocated.data.logicalBytes !== 18 || allocated.data.allocatedBytes < 18) throw new Error("Allocated-size response is invalid.");
    if (process.platform === "win32" && allocated.data.allocationAccuracy !== "exact") throw new Error("Windows allocation must be labeled exact.");
    if (!volume.ok || Number(volume.data.clusterSize) <= 0) throw new Error("Volume geometry is missing.");
    if (!listed.ok || listed.data.returned !== 2) throw new Error("Directory enumeration returned the wrong entries.");
    if (!scanned.ok || scanned.data.files !== 1 || scanned.data.folders !== 1) throw new Error("Tree scan returned the wrong totals.");
    if (!canceled.ok || canceled.data.canceled !== "cancel-target" || cancelResponseMs > 150) throw new Error(`Cancellation acknowledgement took ${cancelResponseMs.toFixed(1)} ms.`);
    const report = { generatedAt: new Date().toISOString(), helperPath, hello: hello.data, allocated: allocated.data, volume: volume.data, enumeration: { returned: listed.data.returned }, scan: { files: scanned.data.files, folders: scanned.data.folders }, cancellation: { responseMs: Math.round(cancelResponseMs * 10) / 10 } };
    await fs.mkdir(path.join(root, "artifacts"), { recursive: true });
    await fs.writeFile(path.join(root, "artifacts", "native-helper-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Native helper: protocol v${hello.data.protocolVersion}, ${hello.data.platform}/${hello.data.architecture}`);
    console.log(`Allocated: ${allocated.data.logicalBytes} logical, ${allocated.data.allocatedBytes} exact bytes, cluster ${volume.data.clusterSize}`);
    console.log(`Cancellation acknowledgement: ${cancelResponseMs.toFixed(1)} ms`);
    console.log("Native helper: 6 pass, 0 fail");
  } finally {
    child.stdin.end();
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await fs.rm(fixture, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
