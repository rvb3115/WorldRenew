# Application updates — 0.5.8

WorldRenew checks `rvb3115/WorldRenew` GitHub Releases and downloads a matching package only when its version is newer than the running app. It does not install, restart, or close the app. Current Mac and Windows test packages are unsigned; manual app replacement or the Windows installer remains the supported installation route.

## Controls and channels

Open **Application updates** in the sidebar. The panel shows the running version, selected channel, and repository. **Check for updates** never starts a download. **Download verified update** stages the package; **Show verified download** rechecks it before revealing the file. Release notes are plain text.

Stable excludes prereleases. Beta includes test/beta/RC prereleases and stable releases. Strict SemVer precedence prevents a newer local test build from being replaced by an older public release. Switching channels does not downgrade. A previously staged package that is no longer newer is also refused.

Startup checking retains its existing setting (enabled by default), is deferred during world work, and can be disabled. Automatic downloads remain off by default and require their separate opt-in. Manual checking works with startup checks disabled. Settings are stored per app profile. Hidden automated tests suppress startup network checks.

## GitHub verification

The configured source is explicitly `github-releases`. The application verifies GitHub's HTTPS API response, release ID and tag, draft/prerelease state, exact versioned package filename, target OS/architecture, asset ID, uploaded state, byte count and GitHub SHA-256 digest. Missing/ambiguous assets or digests fail closed. Mac arm64 ZIPs and Windows x64 installers are supported; a matching Windows portable package is a fallback.

Before downloading, the release is fetched again; changed assets require a new check. Downloaded bytes stream into an owned partial directory, with a 2 GiB package ceiling and exact size/hash verification. Only then is a staged receipt promoted. Failed downloads do not replace an earlier valid download. Revealing a staged GitHub download requires a fresh online release lookup and a complete local hash check, including after restart. A local unsigned receipt alone cannot authorize a package.

A GitHub SHA-256 match proves that downloaded bytes match the repository's advertised asset. It is **not** Developer ID, Authenticode or an independent publisher signature. GitHub/repository account control is part of this trust boundary. The app never removes quarantine, bypasses OS prompts, creates signing keys, or launches a downloaded executable. Existing optional Ed25519-manifest code and its regression tests remain available for a separately configured signed release pipeline; it is not silently substituted after a signed check fails.

TLS certificate checks and every redirect remain enforced. Only GitHub API/release hosts are allowed; HTTP, credentials, nonstandard ports and redirect loops are rejected. Checks inspect at most 500 releases. Storage is outside Minecraft saves and rejects unsafe/symlink locations. The updater never invokes world processing, changes compatibility gates, or includes world paths/content in network requests.

## Installation and persistent data

On macOS, install the complete app bundle in `~/Applications/WorldRenew.app` or an appropriate Applications folder. Finish operations and quit the installed copy before manually replacing it. Keep its previous bundle as a recoverable backup. `scripts/install-macos.mjs` is an explicit local helper: it verifies the staged bundle, refuses an active installed process or a downgrade, retains any old bundle under `~/Applications/WorldRenew Backups`, and replaces only app code. It is never called by the updater.

The Windows installer remains per-user, does not auto-launch, and retains app data. Native Windows upgrade execution still requires validation on Windows. A portable executable is not a persistent installation.

Settings, protection plans and templates remain in the normal Electron user-data directory (on Mac, `~/Library/Application Support/WorldRenew`) rather than inside the app bundle. Test profiles use a separate directory and are not copied over normal settings. Replacing application code does not migrate or replace Minecraft worlds.

## Remaining installation work

Automatic apply is not implemented or claimed. A safe future updater needs supported platform packaging/signing, explicit restart consent, unsaved-work and operation checks, file-lock handling, interrupted-replacement recovery, verified relaunch and rollback tests. No new signing accounts, credentials or public releases are created by these changes.
