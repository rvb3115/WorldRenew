(() => {
  const get = id => document.getElementById(id), api = window.worldrenew;
  const controls = ['update-save', 'update-check', 'update-download', 'update-reveal', 'update-auto-check', 'update-auto-download', 'update-channel'];
  let latest, running = false;
  function render(s) {
    latest = s;
    document.querySelector('.version').textContent = s.currentVersion;
    get('updates-panel').querySelector('summary').textContent = s.release ? 'Application updates · Available' : 'Application updates';
    get('update-version').textContent = `Running ${s.currentVersion} · ${s.settings.channel==='beta'?'Beta / test previews':'Stable'} · ${s.source}`;
    get('update-auto-check').checked = s.settings.automaticChecks;
    get('update-auto-download').checked = s.settings.automaticDownloads;
    get('update-channel').value = s.settings.channel;
    get('update-status').textContent = s.message || (s.configured ? 'Ready to check for updates.' : 'Release source and signing key are not configured.');
    get('update-notes').textContent = s.release?.notes || 'No verified release notes available.';
    get('update-download').disabled = !s.release || s.running;
  }
  async function run(action) {
    if (running) return;
    running = true; controls.forEach(id => { get(id).disabled = true; });
    get('update-status').textContent = 'Working…';
    try {
      const response = await action();
      if (response.error) throw new Error(response.error.message);
      render(response.result);
    } catch (error) {
      const fresh = await api.updateStatus();
      if (fresh.result) render(fresh.result);
      get('update-status').textContent = error.message;
    }
    finally {
      running = false; controls.forEach(id => { get(id).disabled = false; });
      get('update-download').disabled = !latest?.release || latest?.running;
    }
  }
  get('update-save').onclick = () => {
    const value = { automaticChecks: get('update-auto-check').checked, automaticDownloads: get('update-auto-download').checked, channel: get('update-channel').value };
    run(() => api.updateSettings(value));
  };
  get('update-check').onclick = () => run(() => api.checkUpdates());
  get('update-download').onclick = () => run(() => api.downloadUpdate());
  get('update-reveal').onclick = () => run(() => api.revealUpdate());
  get('updates-panel').addEventListener('toggle', () => { if (get('updates-panel').open) run(() => api.updateStatus()); });
  api.onUpdateStatus(s => { if (!running) render(s); });
  run(() => api.updateStatus());
})();
