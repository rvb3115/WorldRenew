// Stable identity is essential: later manual installers must find the same app.
export const appId = 'app.worldrenew.desktop';
export function installerConfig({ version, electronVersion, output }) {
  return {
    appId, productName: 'WorldRenew', electronVersion,
    directories: { output },
    artifactName: `WorldRenew-${version}-windows-x64-setup-local-test.exe`,
    npmRebuild: false, forceCodeSigning: false, publish: null,
    win: { signAndEditExecutable: false },
    nsis: {
      oneClick: true, perMachine: false, allowElevation: false,
      allowToChangeInstallationDirectory: false,
      deleteAppDataOnUninstall: false, runAfterFinish: false,
      createDesktopShortcut: true, createStartMenuShortcut: true,
      shortcutName: 'WorldRenew', uninstallDisplayName: 'WorldRenew',
    },
  };
}
