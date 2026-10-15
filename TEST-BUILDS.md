# Unsigned test builds

The immediate release target is one existing WorldRenew application distributed as:

- **Windows x64:** `WorldRenew-0.5.3-windows-x64-portable.exe`, a single-file portable launcher. No installer or administrator rights are required. It extracts its application into a temporary directory; settings still live in the user's normal WorldRenew application-data directory.
- **Apple Silicon macOS:** `WorldRenew-0.5.3-macos-arm64.app.zip`, containing the complete `WorldRenew.app`. Extract it, then move the app to Applications or run it from a chosen folder.

These testing builds have no trusted publisher signature. Windows is unsigned; macOS uses only a local ad-hoc seal so its renamed bundle is internally valid, without a developer certificate, identity or notarization. Windows or macOS may display an unidentified-publisher warning. Only open a build you obtained from this project's intended download and whose checksum matches. If macOS blocks the app, use its normal **System Settings → Privacy & Security → Open Anyway** flow after attempting to open it; do not disable system security globally. See [Apple’s opening guidance](https://support.apple.com/en-us/102445). These packages are not signed/notarized public releases or proof of Minecraft gameplay compatibility.

No Node.js, Java runtime, mod, account, signing key or updater setup is needed to launch the app. Open a **copy** of a Minecraft Java world for testing. No build or smoke-test command uses an original world. App installation never upgrades or regenerates a world automatically.

## GitHub Actions downloads

`.github/workflows/test-builds.yml` builds on pushes to main/feature branches and test tags, pull requests into main, and manual dispatch. It uses native Windows x64 and macOS arm64 runners with Node 24, a locked dependency install, the combined engine/independent QA suite, and tests of the packaged distributions. Signing credentials and updater hosting are not prerequisites.

Each successful job uploads its download, SHA-256 sidecar, `build-info.json` and `smoke-results.json`. The **Exact artifact download link** step writes the actual URL returned by GitHub's upload action to the run summary. The Windows and macOS links are separate. GitHub artifact downloads require repository access/sign-in and expire after 30 days. Diagnostic artifacts are retained for 14 days and contain test reports/screenshots/logs, not save folders.

A failed test prevents the download artifact from being presented as a tested build. Diagnostic evidence still uploads on failure. No workflow publishes a release, uses a signing certificate, modifies a repository branch, or configures automatic updates. The macOS build applies and verifies its local ad-hoc seal before archiving. It has only `contents: read` permission and uses pinned official action commits.

Public source and experimental downloads are published at https://github.com/rvb3115/WorldRenew. Check the Actions tab for actual native execution results; workflow configuration alone is not a passing result. Historical local builds were produced before a remote was available.

## Reproduce locally

From the existing repository root:

```sh
npm ci
node qa/run.mjs --full
npm run build:test:macos       # macOS host; creates the Apple Silicon ZIP
npm run test:packaged         # on an Apple Silicon Mac, tests the extracted ZIP
```

On Windows x64:

```sh
npm ci
node qa/run.mjs --full
npm run build:test:windows
npm run test:packaged
```

Outputs are in `artifacts/macos-arm64/` and `artifacts/windows-x64/`. `dist/` contains the corresponding unpacked runtime apps. Neither directory is committed. The build script retains the current `@electron/packager` pipeline and locked Electron checksums. Windows adds a pinned `electron-builder` portable wrapper around that prepackaged app, then extracts its payload without running it and compares every packaged application file by SHA-256; it does not replace the application or framework. Each packager invocation owns an isolated temporary directory so parallel targets do not clean up each other’s files. macOS applies a local ad-hoc seal and uses `ditto` to preserve the app's framework symlinks and executable permissions in ZIP.

Cross-building the Windows executable on macOS can produce a download, but **does not test Windows execution**. The native Windows workflow separately tests the unpacked app's full desktop workflows and launches the final portable EXE, opens an unchanged synthetic world, and verifies clean shutdown. The macOS workflow extracts the actual ZIP and tests that extracted app, including arm64 architecture and executable modes. Both exercise 3D/Nether roof previews and the isolated-copy/archive workflow. Tests use separate temporary app profiles and disposable synthetic saves; successful byte preservation does not certify farms, portal connectivity, gameplay or seamless blending.

`build-info.json` identifies the Git commit, dirty-tree state, platform, timestamp, size and SHA-256. `smoke-results.json` is created only after native packaged tests pass. Checksums establish download integrity; they are not publisher signatures.

## Automatic-update roadmap

The existing optional checker/stager remains in the app with no live repository/key configured. Unsigned test downloads do not enter its signed update feed, and no automatic installation runs. Installer/updater signing, restart-time replacement and rollback testing remain later release work, documented in [UPDATES.md](UPDATES.md). None of those gates prevents these explicitly unsigned testing builds.

Build references: [GitHub native runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [artifact download output](https://github.com/actions/upload-artifact#outputs), [electron-builder portable target](https://www.electron.build/v26/docs/nsis/#portable).
