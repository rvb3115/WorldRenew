import fs from 'node:fs';
import path from 'node:path';

// Test-only observation: does not prevent closes, catch application exceptions,
// replace lifecycle methods or change the installed application payload.
export async function recordSmokeLifecycle(app, directory) {
  const file = path.join(directory, 'lifecycle.jsonl');
  const record = (event, detail = {}) => fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), origin: 'harness', event, ...detail }) + '\n');
  const child = app.process();
  record('attached', { pid: child.pid });
  child.on('exit', (code, signal) => record('process-exit', { code, signal }));
  app.on('close', () => record('application-connection-closed'));
  let stderrBytes = 0;
  child.stderr?.on('data', bytes => {
    const keep = bytes.subarray(0, Math.max(0, 256 * 1024 - stderrBytes));
    if (keep.length) fs.appendFileSync(path.join(directory, 'electron-stderr.log'), keep);
    stderrBytes += bytes.length;
  });
  await app.evaluate(({ app, BrowserWindow }, file) => {
    const fs = process.getBuiltinModule('fs');
    const emit = (event, detail = {}) => { try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), origin: 'electron', event, ...detail }) + '\n'); } catch { /* Diagnostics cannot alter application behavior. */ } };
    for (const event of ['before-quit', 'will-quit', 'quit', 'window-all-closed']) app.on(event, () => emit(event));
    app.on('child-process-gone', (_event, detail) => emit('child-process-gone', detail));
    process.on('uncaughtExceptionMonitor', error => emit('uncaught-exception', { message: error.message, stack: error.stack }));
    process.on('exit', code => emit('node-exit', { code }));
    const observe = win => {
      const id = win.id;
      for (const event of ['close', 'closed', 'unresponsive']) win.on(event, () => emit(`window-${event}`, { id }));
      win.webContents.on('render-process-gone', (_event, detail) => emit('render-process-gone', { id, ...detail }));
      win.webContents.on('destroyed', () => emit('web-contents-destroyed', { id }));
      win.webContents.on('did-fail-load', (_event, code, description) => emit('load-failed', { id, code, description }));
    };
    for (const win of BrowserWindow.getAllWindows()) observe(win);
    app.on('browser-window-created', (_event, win) => observe(win));
    emit('observers-ready', { electron: process.versions.electron, node: process.versions.node });
  }, file);
  return {
    record,
    observePage(page) {
      page.on('close', () => record('page-closed'));
      page.on('crash', () => record('page-crashed'));
      page.on('pageerror', error => record('page-error', { message: error.message }));
    }
  };
}
