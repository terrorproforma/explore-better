import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const workspace = process.cwd();
const args = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    return separator === -1
      ? [argument.replace(/^--/, ""), "true"]
      : [argument.slice(0, separator).replace(/^--/, ""), argument.slice(separator + 1)];
  })
);

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
  const version = pkg.version;
  const installer = `ExploreBetter-${version}-x64-setup.exe`;
  const installerPath = path.resolve(workspace, args.get("installer") || path.join("dist", installer));
  const suppliedChecksum = args.get("checksum");
  const suppliedSize = args.get("size-mib");
  const stat = await fs.stat(installerPath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Installer is missing or empty: ${installerPath}`);

  const sha256 = suppliedChecksum || (await hashFile(installerPath));
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error("The installer SHA-256 must contain exactly 64 hexadecimal characters");
  const sizeMiB = suppliedSize ? Number(suppliedSize) : Math.round((stat.size / 1024 / 1024) * 10) / 10;
  if (!Number.isFinite(sizeMiB) || sizeMiB <= 0) throw new Error("The installer size must be a positive number");

  const release = { version, installer, sizeMiB, sha256: sha256.toLowerCase() };
  const releasePath = path.join(workspace, "site", "release.json");
  await fs.writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`, "utf8");

  const homepagePath = path.join(workspace, "site", "index.html");
  const homepage = await fs.readFile(homepagePath, "utf8");
  const updated = homepage
    .replace(/(<code data-checksum>)[^<]+(<\/code>)/, `$1${release.sha256}$2`)
    .replace(
      /(<p class="download-facts">Windows x64 \/ )[0-9.]+( MiB \/ Per-user installer \/ GitHub Release<\/p>)/,
      `$1${release.sizeMiB}$2`
    );
  if (updated === homepage || !updated.includes(release.sha256)) {
    throw new Error("Homepage release fields were not updated; check the download markup selectors");
  }
  await fs.writeFile(homepagePath, updated, "utf8");

  console.log(`Updated website release metadata for v${version}`);
  console.log(`${release.sha256}  ${release.installer}`);
  console.log(`${release.sizeMiB} MiB`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
