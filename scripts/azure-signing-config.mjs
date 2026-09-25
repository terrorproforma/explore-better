// Optional Microsoft Artifact Signing (formerly Trusted Signing) configuration for
// electron-builder. Local and unconfigured builds stay unsigned: signing is enabled
// only when the release workflow exports every EXPLORE_BETTER_AZURE_SIGNING_* value.
// Credentials never pass through here; electron-builder's Invoke-TrustedSigning call
// authenticates through DefaultAzureCredential (the Azure CLI session that
// azure/login creates from a short-lived GitHub OIDC token in CI).

export const azureSigningEnvironment = Object.freeze({
  endpoint: "EXPLORE_BETTER_AZURE_SIGNING_ENDPOINT",
  codeSigningAccountName: "EXPLORE_BETTER_AZURE_SIGNING_ACCOUNT",
  certificateProfileName: "EXPLORE_BETTER_AZURE_SIGNING_PROFILE",
  publisherName: "EXPLORE_BETTER_AZURE_SIGNING_PUBLISHER_NAME"
});

export const artifactSigningTimestampUrl = "http://timestamp.acs.microsoft.com";

const endpointPattern = /^https:\/\/[a-z0-9]+\.codesigning\.azure\.net\/?$/;
// Account: 3-24 alphanumerics/hyphens starting with a letter. Profile: 5-100.
const accountPattern = /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/;
const profilePattern = /^[A-Za-z][A-Za-z0-9-]{3,98}[A-Za-z0-9]$/;

// Returns null when signing is not configured, the electron-builder configuration
// fragment when it is fully configured, and throws when it is only partly configured
// so a release can never silently fall back to an unsigned build.
export function azureSigningConfig(env = process.env) {
  const values = Object.fromEntries(
    Object.entries(azureSigningEnvironment).map(([key, name]) => [key, String(env[name] ?? "").trim()])
  );
  const provided = Object.entries(values).filter(([, value]) => value);
  if (provided.length === 0) return null;
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => azureSigningEnvironment[key]);
  if (missing.length) {
    throw new Error(`Azure Artifact Signing is partly configured. Set ${missing.join(", ")} or unset every EXPLORE_BETTER_AZURE_SIGNING_* value.`);
  }
  if (!endpointPattern.test(values.endpoint)) {
    throw new Error(`${azureSigningEnvironment.endpoint} must be a regional https://<region>.codesigning.azure.net/ endpoint.`);
  }
  if (!accountPattern.test(values.codeSigningAccountName) || values.codeSigningAccountName.includes("--")) {
    throw new Error(`${azureSigningEnvironment.codeSigningAccountName} is not a valid Artifact Signing account name.`);
  }
  if (!profilePattern.test(values.certificateProfileName) || values.certificateProfileName.includes("--")) {
    throw new Error(`${azureSigningEnvironment.certificateProfileName} is not a valid certificate profile name.`);
  }
  if (/[\r\n'"]/.test(values.publisherName)) {
    throw new Error(`${azureSigningEnvironment.publisherName} must be the certificate subject CN (or DN) on one line without quotes.`);
  }
  return {
    // Fail the build instead of producing a partly signed release.
    forceCodeSigning: true,
    win: {
      azureSignOptions: {
        endpoint: values.endpoint.endsWith("/") ? values.endpoint : `${values.endpoint}/`,
        codeSigningAccountName: values.codeSigningAccountName,
        certificateProfileName: values.certificateProfileName,
        // Written to app-update.yml: electron-updater then refuses updates that are
        // not signed by this publisher. Only signed builds may carry it, and every
        // release after the first signed one must be signed by the same subject.
        publisherName: values.publisherName,
        fileDigest: "SHA256",
        timestampRfc3161: artifactSigningTimestampUrl,
        timestampDigest: "SHA256"
      },
      // node-pty's bundled OpenConsole.exe already carries Microsoft's signature;
      // keep it rather than re-signing it as Explore Better. Every other .exe in the
      // app (the desktop executable, resources/native helpers, elevate.exe) and the
      // NSIS installer and uninstaller are signed.
      signExts: ["!OpenConsole.exe"]
    }
  };
}
