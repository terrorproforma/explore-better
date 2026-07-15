# Explore Better Distribution Checklist

Last reviewed: 2026-07-15

Quick progress view: [GitHub distribution readiness issue #1](https://github.com/terrorproforma/explore-better/issues/1)

This is the durable owner-and-project checklist for making Explore Better a
trusted, discoverable Windows product. Check an item only when its exit
condition is satisfied. Credentials, identity documents, private keys, banking
details, and tax information must stay in the relevant provider account or an
encrypted secret store.

## Progress

| # | Distribution track | Status | Owner action remaining |
|---|---|---|---|
| 1 | Code signing and SmartScreen trust | IN PROGRESS | Select an eligible signing route and complete its identity or project attestation |
| 2 | Publisher identity and brand ownership | NOT STARTED | Choose the legal publisher and decide whether to register a business or trademark |
| 3 | Microsoft Store publication | NOT STARTED | Open and verify the correct Partner Center developer account |
| 4 | Domain and public support identity | NOT STARTED | Purchase the final domain and own the support mailboxes |
| 5 | Legal documents and product commitments | NOT STARTED | Approve the final licence, privacy, terms, warranty, security, and support positions |
| 6 | Payments, tax, and pricing | NOT STARTED | Complete KYC, banking, tax, pricing, and refund decisions where applicable |
| 7 | Search, marketplace, and launch accounts | NOT STARTED | Verify account ownership and accept each platform's publisher terms |
| 8 | Physical release certification | NOT STARTED | Supply the second PC, standard-user profile, devices, and network locations |

Overall: **0 / 8 complete**. Active track: **1 - Code signing and SmartScreen trust**.

## 1. Code Signing And SmartScreen Trust

Status: **IN PROGRESS - Microsoft Artifact Signing route selected**

Current facts:

- The public installer and bundled executables are not Authenticode-signed.
- [Microsoft Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
  can be provisioned mostly through Azure CLI, but
  Public Trust identity validation must be completed in the Azure portal.
- Public Trust currently accepts organizations in the US, Canada, EU, and UK,
  and individual developers in the US and Canada. Private Trust does not solve
  public-download trust.
- The publisher is US-based and therefore meets the current Public Trust regional
  requirement, subject to Microsoft's identity validation.
- This machine has a verified per-user installation of Azure CLI 2.88.0 and the
  Artifact Signing CLI extension 1.0.0. SignTool is not yet installed.
- Azure authentication is the next setup boundary; no subscription resource has
  been created or modified yet.
- Explore Better is public under the MIT licence, so SignPath Foundation's free
  [open-source signing program](https://signpath.org/) is a credible alternative
  if its project review accepts the application.

Owner-only actions:

- [x] Confirm an eligible publisher country: United States.
- [x] Choose the primary route: Microsoft Artifact Signing Public Trust.
- [ ] Select individual or organization when completing the identity request.
- [ ] Complete the provider's identity validation or open-source project application.
- [ ] Accept provider agreements and charges, if any.
- [ ] Store provider credentials in Azure/GitHub secrets; never commit or message them.

Project actions after the provider route exists:

- [ ] Add a public code-signing policy and named release roles when required.
- [ ] Sign the Electron app, installer, uninstaller, native filesystem helper, terminal broker, and MCP sidecar.
- [ ] Timestamp every signature and fail release builds when any required PE file is unsigned.
- [ ] Verify signatures on a clean Windows machine and publish signature evidence with the release.
- [ ] Replace the website and README unsigned-preview warning with the verified publisher name.

Exit condition: every public executable has a valid trusted and timestamped
Authenticode signature, the release workflow enforces that requirement, and a
clean Windows machine displays the intended verified publisher.

## 2. Publisher Identity And Brand Ownership

Owner-only actions:

- [ ] Choose the permanent public publisher name.
- [ ] Decide whether the publisher is a person or legal organization.
- [ ] Decide whether to register a business and/or Explore Better trademark.
- [ ] Complete any registration, payment, and ownership attestations.

Project actions: make the publisher name consistent across executable metadata,
signatures, Store listing, website, copyright notices, policies, and support.

Exit condition: one approved publisher identity is used consistently everywhere.

## 3. Microsoft Store Publication

Owner-only actions:

- [ ] Create the appropriate individual or company Partner Center account.
- [ ] Complete Microsoft identity or company verification.
- [ ] Accept Store agreements and provide tax or payout details if required.
- [ ] Reserve the Explore Better product name.

Project actions: produce the Store package, listing copy, screenshots, privacy
links, certification answers, submission automation, and update process.

Exit condition: Explore Better is certified, publicly installable from Microsoft
Store, and its update path has been tested.

## 4. Domain And Public Support Identity

Owner-only actions:

- [ ] Purchase the selected domain in an owner-controlled registrar account.
- [ ] Create and monitor `support@`, `security@`, and the chosen general-contact mailbox.
- [ ] Decide which owner or business contact details are public.

Project actions: configure DNS, GitHub Pages, HTTPS, redirects, canonical URLs,
mail authentication, and the website/support links.

Exit condition: the canonical HTTPS domain and public support addresses work and
remain under owner-controlled billing and recovery accounts.

## 5. Legal Documents And Product Commitments

Owner-only actions:

- [ ] Approve the final software licence posture.
- [ ] Approve privacy, terms, warranty disclaimer, and security policy.
- [ ] Approve supported platforms, response expectations, and support lifecycle.
- [ ] Confirm that all public claims about telemetry and data handling are accurate.

Project actions: draft, publish, version, and link the approved documents from
the app, website, repository, installer, Store, and MCP documentation.

Exit condition: every distribution surface links to the same approved policies.

## 6. Payments, Tax, And Pricing

Owner-only actions:

- [ ] Decide whether Explore Better remains free, accepts donations, or offers paid tiers.
- [ ] Create the relevant merchant or payout accounts.
- [ ] Complete KYC, tax, banking, pricing, regional availability, and refund settings.

Project actions: implement only the approved purchase/donation links and document
entitlements without exposing financial credentials.

Exit condition: the chosen commercial model is legally configured and its full
payment/refund flow has been tested, or the owner records a permanent free-only decision.

## 7. Search, Marketplace, And Launch Accounts

Owner-only actions:

- [ ] Verify ownership in Google Search Console and Bing Webmaster Tools.
- [ ] Own the official marketplace and community publisher profiles.
- [ ] Accept each platform's publisher terms and authorize public launch posts.

Project actions: submit sitemaps, configure verification records, prepare and
publish package manifests, and maintain consistent launch assets and descriptions.

Exit condition: search ownership is verified and every chosen distribution profile
points to the canonical site and verified download.

## 8. Physical Release Certification

Owner-only actions:

- [ ] Provide a second Windows 11 machine and clean standard-user profile.
- [ ] Connect and unlock representative USB and MTP devices.
- [ ] Provide a real mapped drive and UNC share for release testing.
- [ ] Perform any identity-bound UAC or account sign-in action that automation cannot.

Project actions: run the packaged acceptance matrix, capture evidence, verify
installation/update/uninstall, and resolve all release-blocking defects.

Exit condition: the signed packaged release passes on two Windows 11 machines,
including standard-user, device, network, recovery, terminal, MCP, and Explorer
integration workflows.
