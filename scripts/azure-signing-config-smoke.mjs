// Proves the optional Azure Artifact Signing plumbing without credentials, network
// access, or signing: unconfigured builds keep today's configuration, partial
// configuration is refused, and a full configuration resolves through electron-builder's
// own config loader and schema validation with the intended signing options.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactSigningTimestampUrl, azureSigningConfig, azureSigningEnvironment } from "./azure-signing-config.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Load the package entry first so its internal circular imports initialise in order.
require(path.join(root, "node_modules", "app-builder-lib"));
const { getConfig, validateConfiguration } = require(path.join(root, "node_modules", "app-builder-lib", "out", "util", "config", "config.js"));
const { WinPackager } = require(path.join(root, "node_modules", "app-builder-lib", "out", "winPackager.js"));
const { DebugLogger } = require(path.join(root, "node_modules", "builder-util", "out", "DebugLogger.js"));

const full = {
  [azureSigningEnvironment.endpoint]: "https://eus.codesigning.azure.net",
  [azureSigningEnvironment.codeSigningAccountName]: "explorebettersigning",
  [azureSigningEnvironment.certificateProfileName]: "fixture-profile",
  [azureSigningEnvironment.publisherName]: "Fixture Publisher"
};
const unrelated = { PATH: process.env.PATH, EXPLORE_BETTER_SIGNING_SUBJECT: "ignored here" };

assert.equal(azureSigningConfig({}), null);
assert.equal(azureSigningConfig(unrelated), null);
assert.equal(azureSigningConfig(Object.fromEntries(Object.values(azureSigningEnvironment).map((name) => [name, "  "]))), null);
for (const name of Object.values(azureSigningEnvironment)) {
  const partial = { ...full, [name]: "" };
  assert.throws(() => azureSigningConfig(partial), new RegExp(`partly configured.*${name}`), `missing ${name} must be refused`);
}
for (const [name, value, pattern] of [
  [azureSigningEnvironment.endpoint, "http://eus.codesigning.azure.net/", /regional/],
  [azureSigningEnvironment.endpoint, "https://eus.codesigning.azure.net.example.com/", /regional/],
  [azureSigningEnvironment.codeSigningAccountName, "1account", /account name/],
  [azureSigningEnvironment.codeSigningAccountName, "bad--name", /account name/],
  [azureSigningEnvironment.certificateProfileName, "abc", /certificate profile/],
  [azureSigningEnvironment.publisherName, "Fixture' Publisher", /one line without quotes/]
]) {
  assert.throws(() => azureSigningConfig({ ...full, [name]: value }), pattern, `${name}=${value}`);
}

const signing = azureSigningConfig(full);
assert.deepEqual(signing, {
  forceCodeSigning: true,
  win: {
    azureSignOptions: {
      endpoint: "https://eus.codesigning.azure.net/",
      codeSigningAccountName: "explorebettersigning",
      certificateProfileName: "fixture-profile",
      publisherName: "Fixture Publisher",
      fileDigest: "SHA256",
      timestampRfc3161: artifactSigningTimestampUrl,
      timestampDigest: "SHA256"
    },
    signExts: ["!OpenConsole.exe"]
  }
});

// electron-builder's own loader: the unconfigured build is exactly package.json's
// "build" field, and the signing parent adds only the signing keys.
const debugLogger = new DebugLogger(false);
const baseline = await getConfig(root, null, null);
await validateConfiguration(baseline, debugLogger);
assert.equal(baseline.win.azureSignOptions, undefined);
assert.equal(baseline.win.signExts, undefined);
assert.equal(baseline.forceCodeSigning, undefined);
assert.equal(baseline.win.publisherName, undefined);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "eb-signing-smoke-"));
try {
  const parent = path.join(temp, "electron-builder.signing.json");
  await fs.writeFile(parent, JSON.stringify(signing));
  const signed = await getConfig(root, null, { extends: `file:${parent}` });
  await validateConfiguration(signed, debugLogger);
  assert.deepEqual(signed.win.azureSignOptions, signing.win.azureSignOptions);
  assert.deepEqual(signed.win.signExts, ["!OpenConsole.exe"]);
  assert.equal(signed.forceCodeSigning, true);
  const strip = (config) => {
    const copy = structuredClone(config);
    delete copy.extends;
    delete copy.forceCodeSigning;
    delete copy.win.azureSignOptions;
    delete copy.win.signExts;
    return copy;
  };
  assert.deepEqual(strip(signed), strip(baseline), "Signing must not change any other packaging option.");

  // electron-builder only runs its signing transformer for extraResources copied as a
  // directory; a single-file entry is copied verbatim and would ship unsigned.
  const extraResources = signed.extraResources.map((item) => (typeof item === "string" ? { from: item } : item));
  assert(!extraResources.some((item) => /\.(exe|dll)$/i.test(item.from)), "List executables through a directory extraResources entry so they are signed.");
  const nativeResources = extraResources.find((item) => item.from === "native/bin" && item.to === "native");
  assert.deepEqual(nativeResources?.filter, ["explore-better-fs.exe", "ExploreBetterMcp.exe"]);

  // electron-builder decides per file whether to sign; keep Microsoft's OpenConsole.exe signature.
  const shouldSign = (file) => WinPackager.prototype.shouldSignFile.call({ platformSpecificBuildOptions: signed.win }, file);
  assert.equal(shouldSign(path.join("resources", "native", "explore-better-fs.exe")), true);
  assert.equal(shouldSign(path.join("resources", "native", "ExploreBetterMcp.exe")), true);
  assert.equal(shouldSign("Explore Better.exe"), true);
  assert.equal(shouldSign(path.join("resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "conpty", "OpenConsole.exe")), false);

  // The wrapper refuses a partial configuration before invoking electron-builder.
  const partialEnv = { ...process.env, ...full, [azureSigningEnvironment.certificateProfileName]: "" };
  const refused = spawnSync(process.execPath, [path.join(root, "scripts", "run-electron-builder.mjs"), "--dir"], {
    cwd: root, env: partialEnv, encoding: "utf8", windowsHide: true, timeout: 30000
  });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /partly configured/);
} finally {
  const resolved = path.resolve(temp);
  assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith("eb-signing-smoke-"));
  await fs.rm(resolved, { recursive: true, force: true });
}

console.log("Azure signing config smoke passed: unconfigured builds unchanged, partial/invalid configuration refused, full configuration validated by electron-builder with timestamped SHA-256 Artifact Signing, publisherName, and forceCodeSigning.");
