// Records which source commit produced each artifacts/*-latest.json written by a
// verify:all suite, so summary audits can flag evidence produced by different code.
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../lib/atomic-write.mjs";

const manifestName = "verify-provenance.json";
const schema = "explore-better.verify-provenance.v1";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000 });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

// verify:all passes EB_VERIFY_COMMIT/EB_VERIFY_DIRTY to its suites so every audit
// compares against the state captured once at the start of the run.
export function currentSourceState(root) {
  if (process.env.EB_VERIFY_COMMIT) {
    return { commit: process.env.EB_VERIFY_COMMIT, dirty: process.env.EB_VERIFY_DIRTY === "1" };
  }
  const commit = git(root, ["rev-parse", "HEAD"]);
  if (!commit) return { commit: null, dirty: null };
  const status = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  return { commit, dirty: status === null ? null : status.length > 0 };
}

export function strictProvenance() {
  return process.env.EB_VERIFY_STRICT === "1" || process.argv.includes("--strict");
}

async function readManifest(artifactsDir) {
  try {
    const data = JSON.parse(await fs.readFile(path.join(artifactsDir, manifestName), "utf8"));
    return data?.schema === schema && data.artifacts && typeof data.artifacts === "object" ? data : { schema, artifacts: {} };
  } catch {
    return { schema, artifacts: {} };
  }
}

// Called by verify:all after each suite with the *-latest.json files it (re)wrote.
export async function recordArtifactProvenance(artifactsDir, sinceMs, suite, state) {
  let names = [];
  try {
    names = (await fs.readdir(artifactsDir)).filter((name) => name.endsWith("-latest.json"));
  } catch {
    return [];
  }
  const written = [];
  for (const name of names) {
    const stat = await fs.stat(path.join(artifactsDir, name)).catch(() => null);
    if (stat?.isFile() && stat.mtimeMs >= sinceMs) written.push({ name, mtimeMs: stat.mtimeMs });
  }
  if (!written.length) return [];
  const manifest = await readManifest(artifactsDir);
  const recordedAt = new Date().toISOString();
  for (const { name, mtimeMs } of written) {
    manifest.artifacts[name] = { commit: state.commit, dirty: state.dirty, suite, recordedAt, mtimeMs };
  }
  await writeFileAtomic(path.join(artifactsDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  return written.map((item) => item.name);
}

// Used by summary audits: inspect(name, stat) returns null when the artifact was
// recorded at the current commit, otherwise { kind: "mismatch" | "unknown", detail }.
export async function createProvenanceTracker(root, artifactsDir) {
  const current = currentSourceState(root);
  const manifest = await readManifest(artifactsDir);
  const strict = strictProvenance();
  const mismatched = [];
  const unknown = [];
  return {
    strict,
    inspect(name, stat) {
      if (!current.commit) return null;
      const entry = manifest.artifacts[name];
      if (!entry || !entry.commit || Math.abs(Number(entry.mtimeMs) - Number(stat?.mtimeMs)) > 2) {
        const detail = `${name} has no verify:all provenance record for its current contents (written outside verify:all).`;
        unknown.push({ name, detail });
        return { kind: "unknown", detail };
      }
      if (entry.commit !== current.commit) {
        const detail = `${name} was produced at commit ${String(entry.commit).slice(0, 12)}${entry.dirty ? " (dirty)" : ""}, not the current ${current.commit.slice(0, 12)}${current.dirty ? " (dirty)" : ""}.`;
        mismatched.push({ name, commit: entry.commit, dirty: entry.dirty, suite: entry.suite, detail });
        return { kind: "mismatch", detail };
      }
      return null;
    },
    summary() {
      return { commit: current.commit, dirty: current.dirty, strict, mismatched, unknown };
    },
    warn(label) {
      if (mismatched.length) {
        console.warn(`\n!!! ${label}: ${mismatched.length} consumed artifact(s) came from a different commit${strict ? " (failing: strict provenance)" : ""}:`);
        for (const item of mismatched) console.warn(`!!!   ${item.detail}`);
      }
      if (unknown.length) {
        console.warn(`${label}: ${unknown.length} consumed artifact(s) have no verify:all provenance record: ${unknown.map((item) => item.name).join(", ")}`);
      }
    }
  };
}
