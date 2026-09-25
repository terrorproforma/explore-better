# Code Signing

Explore Better releases are built by `.github/workflows/release.yml`. Until the owner
finishes the steps below, every release is unsigned, exactly as before. Once the
repository variables exist, the next `v*` tag builds, signs and verifies everything
without further changes to the repository.

## What the pipeline does

| Situation | Job that runs | Result |
| --- | --- | --- |
| No `AZURE_SIGNING_*` repository variable | `build` | Unsigned installer, warn-only Authenticode report (today's behaviour) |
| Any `AZURE_SIGNING_*` variable set, tag push | `build (signed)` | Signed release, or a failed run. It never falls back to unsigned |
| Any `AZURE_SIGNING_*` variable set, manual run on a branch | `build` | Unsigned test build. Nothing is published |

The signed job:

1. checks that all seven variables are set, then runs `npm ci`, `npm audit` and the
   pre-packaging build **before** any Azure credential exists on the runner;
2. signs in with `azure/login` using GitHub OIDC. There is no client secret. Azure
   trusts only the `release-signing` GitHub environment;
3. runs electron-builder with `win.azureSignOptions` (`scripts/azure-signing-config.mjs`,
   passed in by `scripts/run-electron-builder.mjs`). electron-builder signs, with a
   SHA-256 digest and an RFC 3161 timestamp from `http://timestamp.acs.microsoft.com`:
   `Explore Better.exe` (which also runs the terminal broker), the packaged copies of
   `explore-better-fs.exe` and `ExploreBetterMcp.exe` (the committed `native/bin` files
   are never modified), `elevate.exe`, the uninstaller and the installer. The helpers
   are listed in `package.json` as a directory `extraResources` entry because
   electron-builder copies single-file entries without signing them.
   `forceCodeSigning` fails the build if any signature fails. node-pty's
   `OpenConsole.exe` keeps its existing Microsoft signature;
4. clears the Azure session, then builds `latest.yml`, `SHA256SUMS.txt` and the MCP
   bundle from the signed files. The MCPB bundles the signed sidecar;
5. runs `npm run verify:production-signing` in strict mode. The release fails unless
   the installer, the app executable and both helpers carry a trusted, timestamped
   signature from `AZURE_SIGNING_PUBLISHER_NAME`, and the MCPB sidecar hash matches
   the signed copy.

The build signs inside electron-builder rather than in a later job because the order
matters: helpers and the app executable are signed before NSIS embeds them, and
installer hashes are computed after signing. The trade-off is `id-token: write` in a
job that runs npm-installed code. It is limited to tag builds that use the
tag-restricted environment, and the credential only permits signing. The comment above
`build-signed` in the workflow gives the full reasoning.

## Owner steps after identity validation completes

These steps use PowerShell with Azure CLI (the `artifact-signing` extension) and an
authenticated `gh`. Replace the values in angle brackets. Do not commit any of these
values or paste them into issues.

### 1. Create the Public Trust certificate profile

Find the identity validation ID in the portal: **explorebettersigning** >
**Identity validations** > your validation > **Identity validation Id**. Then run:

```powershell
$rg = "explore-better-signing-rg"; $account = "explorebettersigning"; $profileName = "ExploreBetterPublic"
az artifact-signing certificate-profile create -g $rg --account-name $account -n $profileName --profile-type PublicTrust --identity-validation-id <identity-validation-id>
az artifact-signing certificate-profile show -g $rg --account-name $account -n $profileName
```

You can also create the profile in the portal under **Certificate profiles** > **Create** >
**Public Trust**. Write down the certificate subject **CN** exactly as it appears in the
portal (for an individual, this is the validated legal name). That CN is the publisher
name.

### 2. Create the signing identity (no secret)

```powershell
$appId = az ad app create --display-name "explore-better-release-signing" --query appId -o tsv
$spId = az ad sp create --id $appId --query id -o tsv
@{
  name        = "github-release-signing"
  issuer      = "https://token.actions.githubusercontent.com"
  subject     = "repo:terrorproforma/explore-better:environment:release-signing"
  audiences   = @("api://AzureADTokenExchange")
  description = "Explore Better tagged releases via the release-signing environment"
} | ConvertTo-Json | Set-Content -Encoding utf8 fic.json
az ad app federated-credential create --id $appId --parameters fic.json
Remove-Item fic.json
```

The subject names the environment rather than `ref:refs/tags/v*` for two reasons.
Standard Entra federated credentials only match exact subjects, so they have no tag
wildcard. And once a job declares an environment, GitHub puts
`environment:<name>` in the token subject instead of the ref.

### 3. Grant only the signing role

The role is scoped to the one certificate profile:

```powershell
$sub = az account show --query id -o tsv
az role assignment create --assignee-object-id $spId --assignee-principal-type ServicePrincipal `
  --role "Artifact Signing Certificate Profile Signer" `
  --scope "/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.CodeSigning/codeSigningAccounts/$account/certificateProfiles/$profileName"
```

### 4. Create the tag-restricted GitHub environment

```powershell
gh api -X PUT repos/terrorproforma/explore-better/environments/release-signing `
  -F "deployment_branch_policy[protected_branches]=false" -F "deployment_branch_policy[custom_branch_policies]=true"
gh api -X POST repos/terrorproforma/explore-better/environments/release-signing/deployment-branch-policies -f name="v*" -f type=tag
```

Optional: add yourself as a required reviewer on the environment (**Settings** >
**Environments** > **release-signing**), and add a tag ruleset so that only you can
create `v*` tags.

### 5. Set the repository variables

None of these values is a secret. They must be repository variables, not environment
variables, because the workflow reads them to choose which build job runs. Setting any
`AZURE_SIGNING_*` variable turns signing on for the next tag, so set all seven
together:

```powershell
gh variable set AZURE_CLIENT_ID --body $appId
gh variable set AZURE_TENANT_ID --body (az account show --query tenantId -o tsv)
gh variable set AZURE_SUBSCRIPTION_ID --body $sub
gh variable set AZURE_SIGNING_ENDPOINT --body "https://eus.codesigning.azure.net/"
gh variable set AZURE_SIGNING_ACCOUNT --body $account
gh variable set AZURE_SIGNING_PROFILE --body $profileName
gh variable set AZURE_SIGNING_PUBLISHER_NAME --body "<certificate subject CN>"
```

### 6. Release and confirm

Bump the version, push the `v*` tag and confirm that **build (signed)** runs.
`production-signing-latest.md`, attached to the draft release, should show every
signing check as PASS. On a clean Windows machine, open the installer's
**Properties** > **Digital Signatures**, or run
`Get-AuthenticodeSignature .\ExploreBetter-<version>-x64-setup.exe`.

Optional rehearsal before tagging: give your own user the Signer role on the profile,
run `az login`, set the four `EXPLORE_BETTER_AZURE_SIGNING_*` environment variables
(endpoint, account, profile, publisher name), and run `npm run package:installer`.
Local builds stay unsigned whenever those variables are unset.

## After the first signed release

- Signed builds write `publisherName` into `app-update.yml`, and electron-updater then
  rejects any update that is not signed by that publisher. **Every release after the
  first signed one must be signed with the same subject.** Do not delete the variables
  or let validation lapse. If the subject must change (for example, moving to an
  organization identity), plan a transition release first.
- Unsigned builds never set `publisherName`, so updating from today's unsigned
  releases to the first signed release works.
- electron-builder 27 replaces `win.azureSignOptions` with `win.sign` (`type: "azure"`).
  `npm run verify:azure-signing-config` validates against the installed
  electron-builder schema and will fail on that upgrade until
  `scripts/azure-signing-config.mjs` is migrated.

## Alternative: SignPath Foundation

[SignPath Foundation](https://signpath.org/) signs accepted MIT-licensed projects for
free. The certificate names SignPath Foundation as the publisher, and signing requests
go through `signpath/github-action-submit-signing-request` against artifacts built on
GitHub-hosted runners. That fits a sign-after-build flow, so this project would need two
signing rounds: the unpacked app and helpers first, then electron-builder
`--prepackaged` to build and sign the installer. None of this is wired up. Use it only
if the Artifact Signing validation fails.
