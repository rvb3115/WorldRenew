import test from 'node:test';
import assert from 'node:assert/strict';
import { installerConfig, appId } from '../scripts/installer-config.mjs';
test('installer identity is stable across upgrades and keeps persistent templates/settings', () => {
  const old = installerConfig({ version: '0.5.3', electronVersion: '44.4.5', output: '/temporary' });
  const next = installerConfig({ version: '0.5.5-test.1', electronVersion: '44.4.5', output: '/temporary' });
  assert.equal(appId, 'app.worldrenew.desktop'); assert.equal(old.appId, next.appId); assert.equal(old.productName, next.productName);
  assert.equal(next.nsis.deleteAppDataOnUninstall, false); assert.equal(next.nsis.perMachine, false); assert.equal(next.nsis.allowElevation, false);
  assert.equal(next.nsis.createStartMenuShortcut, true); assert.equal(next.nsis.createDesktopShortcut, true);
  assert.equal(next.nsis.runAfterFinish, false); assert.equal(next.publish, null); assert.equal(next.forceCodeSigning, false);
  assert.match(next.artifactName, /setup-local-test\.exe$/);
});
