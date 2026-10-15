# Application updates — 0.5.3

WorldRenew can check GitHub Releases, display signed release notes, and stage a verified application package. **It cannot install or restart itself yet.** The current packaging produces an unsigned Electron app bundle. No live release repository or signing public key is configured; this build makes no update requests until both are supplied by the maintainer.

## Use the update controls

Open **Application updates** in the left sidebar. Stable is the default channel; Beta also accepts newer stable versions. Version precedence follows SemVer, including numeric prerelease identifiers. Switching from Beta to Stable does not automatically downgrade an installed beta.

- **Check automatically at startup** is enabled by default. One check runs after startup, deferred while world work is active. Uncheck and save to opt out. There is no recurring/background timer after that check.
- **Download verified updates automatically** is off by default. It applies only to automatic checks; a manual check never initiates a download. Disabling startup checks also prevents automatic downloads.
- **Check for updates** works even with automatic checking disabled.
- **Download verified update** verifies and stages the candidate without extracting, opening, executing, installing, or restarting anything.
- **Show verified download** revalidates the stored signature, expiry and package hash before revealing its file in the OS file browser. It does not open the package. This also works after restarting WorldRenew. An expired manifest requires a fresh check and a maintainer-refreshed signed release.

Finish world operations and quit WorldRenew before manually installing a release. Keep the known-working app or installer. Update settings and packages live under Electron's user-data directory in `updates/`, separate from `projects/`. Updates never invoke the world worker, upgrade a Minecraft world, change compatibility gates, or select a world for processing. World operations still require their existing review and acknowledgements.

## Implemented and pending

| Capability | Status |
| --- | --- |
| Optional startup check and manual check | Implemented; disabled by absent trusted source configuration |
| Stable/Beta settings retained across restarts | Implemented |
| GitHub Releases selection and SemVer comparison | Implemented; bounded to 500 releases, errors rather than silently truncating |
| Signed release notes rendered as plain text | Implemented |
| HTTPS certificate verification and redirect validation | Implemented |
| Ed25519 signed manifest, exact size and SHA-256 verification | Required; unsigned packages are rejected |
| Streaming download, exclusive staging, retained previous packages | Implemented |
| Reverification after restart/before revealing a package | Implemented |
| Opt-in automatic downloading | Implemented; off by default |
| Installation, application replacement, automatic rollback | Not implemented; no executable-launch or restart endpoint |
| Windows installer, macOS code signing/notarization, Linux distribution packages | Pending |
| Public release hosting, real signing keys and CI publication | Pending maintainer setup |
| Live GitHub end-to-end delivery and production installer testing | Pending |
| Scheduled retry, progress/cancel UI, resuming partial downloads, cache pruning | Pending |

## Maintainer release contract

The trusted configuration is `updates/release-config.json`, bundled inside the app. The renderer cannot change the repository, keys, package URLs or filesystem paths. Configure the exact public GitHub `owner/repository` and one or more Ed25519 public keys indexed by a key ID. Never place a private key inside the checkout, app, source archive or user settings. No personal access token is needed or sent; private repositories are not supported.

Example configuration (replace the placeholder with a real exported SPKI PEM public key):

```json
{
  "repository": "OWNER/REPOSITORY",
  "publicKeys": { "release-2026": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" }
}
```

For each release, upload the platform packages and `worldrenew-update.json` under the same release tag. The latter is a JSON envelope containing `keyId`, base64 `payload`, and base64 Ed25519 `signature`. Sign the **exact payload bytes**; clients verify before interpreting them. Do not rely solely on a checksum served beside an unsigned executable.

The payload has this shape (sizes/hashes/dates below are illustrative):

```json
{
  "schemaVersion": 1,
  "repository": "OWNER/REPOSITORY",
  "tag": "v0.6.0",
  "version": "0.6.0",
  "channel": "stable",
  "publishedAt": "2026-10-14T18:00:00Z",
  "expiresAt": "2026-10-28T18:00:00Z",
  "notes": "Application fixes and release notes. No automatic world changes.",
  "packages": [{
    "platform": "darwin",
    "arch": "arm64",
    "name": "WorldRenew-darwin-arm64.zip",
    "format": "zip",
    "size": 123456789,
    "sha256": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS"
  }]
}
```

Use Node platform/architecture names, such as `darwin/arm64`, `darwin/x64`, `win32/x64`, `linux/x64`. A client requires exactly one matching package. Maximum package size is 2 GiB. Allowed container/installer extensions are zip, dmg, exe, msix, AppImage, deb and rpm; accepting a format does not implement installation for it. Package names are plain filenames, never paths or URLs. URLs are derived from the configured repository, signed release tag and filename.

Stable tags must have no prerelease suffix. Beta tags must start their prerelease identifiers with `beta`, for example `0.6.0-beta.1`, and the GitHub release must be marked prerelease. Drafts, unrelated version tags and versions at or below the running app are ignored. Signed metadata must agree with the GitHub tag/channel. A broken newest eligible release causes an error rather than a fallback to an older candidate.

Published dates may be at most five minutes ahead of the client's clock. Metadata expires within 31 days of publication. Maintain fresh signed envelopes even when no newer binary is released; otherwise clients fail closed. Clock errors can prevent updates. Expiry limits replay lifetime, but this is not a complete TUF implementation: there is no persisted repository high-water mark, threshold-signature scheme or online key revocation feed. A compromised signing key remains a release security incident.

Generate package size and SHA-256 from the **final** packaged/signed bytes, assemble the payload, then sign in a controlled release environment:

```sh
node scripts/sign-update.mjs manifest.json /secure/worldrenew-release-key.pem release-2026 worldrenew-update.json
```

The script requires an Ed25519 private key, validates every platform entry and refuses to overwrite the output. It does not upload or publish anything. Public-key rotation needs an app release that already trusts the next key before old-key removal. Test the exact release artifacts before publishing; keep the last known-working installer available.

## Security and failure behavior

The transport explicitly verifies TLS certificates, allows only `api.github.com`, `github.com`, `release-assets.githubusercontent.com` and `objects.githubusercontent.com`, rejects credentials/nondefault ports/fragments/HTTP and rechecks every redirect (maximum five). Requests have an inactivity timeout; checks have a one-minute overall timeout and downloads a fifteen-minute deadline. No world names, paths or contents are included in requests. GitHub receives ordinary network/request information.

The manifest has an independent Ed25519 signature anchored in bundled public keys. Downloads stream into a newly owned UUID `.partial` directory. Exact signed size and SHA-256 must match before the directory is promoted and the current staged receipt is atomically replaced. Partial files are never treated as installable. Ordinary failures remove only the newly owned partial directory and retain earlier verified packages. A process kill can leave a partial directory, and a crash between promotion and receipt replacement can leave an unreferenced verified directory. Neither is consumed automatically. Settings corruption disables automatic checks instead of silently restoring an opt-in.

Storage rejects symlink directories and Minecraft-save ancestors (`level.dat`). Staged files and receipts are validated independently; tampered content is rejected. The app owns fixed paths beneath user data; there is no renderer-selected output or executable path. Hostile concurrent filesystem replacement by another process with the same user privileges is outside this boundary. File flush/rename reduces partial publication but does not claim power-loss atomicity across every platform. Previous staged directories remain until manually removed while the app is closed; there is no disk-quota management yet.

The coordinator serializes update work and world operations. Startup work waits until the app is idle; an update request is refused while a world operation runs, and world requests wait for an active update request to finish. No update code terminates a worker, invokes `app.quit`, or launches an installer. App termination during a download can leave an inert partial package; it cannot partially replace the application.

## Manual rollback path

1. Keep the last known-working application or original installer before replacing WorldRenew. Staged previous downloads remain available, but they are not a backup of the currently installed app.
2. Finish all world operations, save protection plans, quit WorldRenew, and keep a copy of its user-data directory for project/settings recovery. Do not delete or move Minecraft worlds.
3. On macOS, restore the retained app bundle. On Windows, use the retained previous installer according to that installer's instructions. On Linux, use the distribution's package downgrade/reinstall procedure or restore the retained portable app.
4. Reopen the old app and verify project compatibility before further work. Future data-schema migrations must provide backward compatibility or a tested restore path. Application rollback does not undo Minecraft world changes made separately by the user.

No rollback button or unattended downgrade is claimed. Installer-specific procedures remain a release gate because this project currently packages a bare Electron application.

## Restart-time installation plan and release gates

Keep the current checker/stager; add a narrow platform adapter only once actual installers exist:

- **macOS:** sign/notarize the app and choose a supported Squirrel.Mac feed/package pipeline. The separate updater must validate the application signing identity as well as release metadata.
- **Windows:** choose and build a signed Squirrel.Windows or MSIX installer and its matching update mechanism. Validate installed-app upgrades, per-user/per-machine paths, file locking and privilege behavior.
- **Linux:** use the distribution package manager or explicitly supported portable-app helper. Electron's built-in updater does not provide Linux support.

The helper must wait for the parent process to exit, revalidate the package, replace only the installed application, retain the known-working version, and recover from interrupted replacement. It must not have world paths or invoke world processing. A restart request must be explicit, recheck the world-operation gate and unsaved plans, and never bypass normal close safeguards. Do not enable quit-time auto-install hooks until those guarantees are demonstrated.

Required packaged-build checks: real source-version → target-version upgrade for each supported OS/architecture; invalid signature/checksum; expired metadata; offline/proxy/rate-limit failures; canceled/deferred restart; world-operation blocking; locked files/low disk; helper crash at each replacement phase; relaunch; rollback with project settings; and unchanged hashes of disposable world fixtures. Release signing and installer checks must be exercised against final artifacts, not inferred from unit tests or `app.isPackaged`.

Primary references: [Electron autoUpdater platform and signing requirements](https://www.electronjs.org/docs/latest/api/auto-updater/), [GitHub Releases REST API](https://docs.github.com/en/rest/releases/releases).
