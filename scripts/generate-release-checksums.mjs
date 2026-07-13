import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const distDir = path.join(workspace, "dist");
const artifactsDir = path.join(workspace, "artifacts");
const outputPath = path.join(distDir, "SHA256SUMS.txt");
const reportPath = path.join(artifactsDir, "release-checksums-latest.json");
const checkOnly = process.argv.includes("--check");

function buildArchName() {
  if (process.arch === "x64") return "x64";
  if (process.arch === "ia32") return "ia32";
  if (process.arch === "arm64") return "arm64";
  return process.arch;
}

function renderArtifactName(template, pkg, ext) {
  return String(template || "")
    .replaceAll("${productName}", pkg.build?.productName || pkg.productName || pkg.name || "ExploreBetter")
    .replaceAll("${name}", pkg.name || "explore-better")
    .replaceAll("${version}", pkg.version || "0.0.0")
    .replaceAll("${arch}", buildArchName())
    .replaceAll("${ext}", ext);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(workspace, "package.json"), "utf8"));
  const installerName = renderArtifactName(
    pkg.build?.nsis?.artifactName || pkg.build?.win?.artifactName || "ExploreBetter-${version}-${arch}-setup.${ext}",
    pkg,
    "exe"
  );
  const files = [
    { name: installerName, path: path.join(distDir, installerName) },
    { name: `${installerName}.blockmap`, path: path.join(distDir, `${installerName}.blockmap`) },
    { name: "latest.yml", path: path.join(distDir, "update-feed", "latest.yml") }
  ];

  const records = [];
  for (const file of files) {
    const stat = await fs.stat(file.path);
    if (!stat.isFile() || stat.size === 0) throw new Error(`Release artifact is empty: ${file.path}`);
    records.push({ ...file, size: stat.size, sha256: await hashFile(file.path) });
  }

  const expected = `${records.map((record) => `${record.sha256}  ${record.name}`).join("\n")}\n`;
  if (checkOnly) {
    const actual = await fs.readFile(outputPath, "utf8");
    if (actual !== expected) throw new Error(`${outputPath} does not match the current release artifacts`);
  } else {
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(outputPath, expected, "utf8");
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: checkOnly ? "check" : "write",
    status: "pass",
    outputPath,
    records
  };
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`${checkOnly ? "Verified" : "Wrote"} ${outputPath}`);
  for (const record of records) console.log(`${record.sha256}  ${record.name}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
