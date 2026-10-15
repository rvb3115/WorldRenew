# Installed WorldRenew for Windows

The earlier `*-portable.exe` is a self-contained portable launcher. Its bundled application extracts into temporary storage on each launch and is cleaned up on exit. This is not evidence of downloading the app again: the runtime is embedded in the executable. The portable build remains available as an optional distribution.

The new `*-setup-local-test.exe` is a full offline NSIS installer. It installs WorldRenew persistently for the current user in `%LOCALAPPDATA%\Programs\WorldRenew`, with Start menu and desktop shortcuts pointing to the installed executable. Launch WorldRenew from either shortcut after installation. No administrator rights, account or separate runtime download is required.

Subsequent setup files use the same `app.worldrenew.desktop` identity and installation directory, replacing application files. Close WorldRenew before installing an update. Settings, protection plans, saved selection boundaries and the new local template library live separately in `%APPDATA%\WorldRenew`. Normal upgrade and uninstall preserve that profile. Imported and exported files elsewhere are untouched. Do not store personal files inside the installer-managed application directory.

If you used the old portable app with its default profile, the installed application uses that same profile. Existing external `.wrbuild` files remain where you saved them; Import copies them into the new local library. Retain any custom `WORLDRENEW_USER_DATA` override to continue using its profile. Portable-to-installed profile reuse requires native Windows acceptance testing.

Build with `npm run build:installer:windows`. The script reuses the existing Electron packaging pipeline, verifies packaged source freshness, checks installer identity/preservation defines and verifies every embedded application file against the packaged app. It never publishes, installs or launches the Windows installer. The output includes SHA-256 and policy/payload reports. The setup file is unsigned.

This adapts the earlier isolated local installer work without changing its files or artifacts. Run `scripts/test-installer-windows.ps1` only in a disposable Windows account/VM, with previous and new installers. It refuses an existing installation/profile, checks a stable installation path, actual shortcuts, repeated direct app launch, upgrade preservation and uninstall preservation. Native installation/upgrade/uninstall and Windows launch are **not verified by cross-building on a Mac**. No installer is run on the user's machine by the build process.

macOS continues to use an app ZIP: quit WorldRenew, extract and move/replace `WorldRenew.app` in Applications. Its persistent profile and templates remain in `~/Library/Application Support/WorldRenew`, outside the app bundle. Mac and Windows ship identical application code and features.
