/* Paths stay in the main process; the renderer supplies only an inspected digest. */
(() => {
  const $ = id => document.getElementById(id), api = window.worldrenew, dialog = $('recovery-dialog');
  let review = null, working = false;
  const phaseNames = {
    'backing-up': 'Interrupted while making a backup',
    'creating-working-copy': 'Interrupted while making the test copy',
    'removing-records': 'Interrupted while preparing terrain',
    'validating': 'Interrupted during validation',
    'validated-test-copy': 'Completed regeneration export',
    'failed-working-copy-discarded': 'Export stopped; working copy discarded'
  };
  function status(message, error = false) { $('recovery-status').textContent = message; $('recovery-status').classList.toggle('error', error); }
  function controls() {
    for (const id of ['recovery-close', 'recovery-choose', 'recovery-reveal']) $(id).disabled = working;
    $('recovery-refresh').disabled = working || !review;
    $('recovery-closed').disabled = working || !review?.recoverable;
    $('recovery-restore').disabled = working || !review?.recoverable || !$('recovery-closed').checked;
  }
  function render(value) {
    review = value; $('recovery-closed').checked = false;
    $('recovery-review').hidden = !value; $('recovery-details').replaceChildren(); $('recovery-blockers').replaceChildren();
    $('recovery-directory').textContent = value?.directory ?? 'No export folder chosen.';
    if (value) {
      const labels = { verified: 'Backup verified', unavailable: 'No completed backup available', invalid: 'Backup could not be verified' };
      $('recovery-state').textContent = labels[value.backupState] ?? 'Backup unavailable';
      $('recovery-state').dataset.state = value.backupState;
      const fields = [['Export', phaseNames[value.status] ?? value.status ?? 'Unknown'], ['Backup', value.backup ?? 'Unavailable']];
      if (value.recoverable) fields.push(['Contents', `${value.files.toLocaleString()} files · ${(value.bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`]);
      for (const [label, text] of fields) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = text; $('recovery-details').append(dt, dd); }
      for (const blocker of value.blockers ?? []) { const li = document.createElement('li'); li.textContent = blocker; $('recovery-blockers').append(li); }
    }
    controls();
  }
  async function run(action, message, success) {
    if (working) return;
    working = window.recoveryBusy = true; document.body.classList.add('busy'); controls(); status(message);
    try {
      const response = await action(); if (response.error) throw new Error(response.error.message);
      if (response.result) success(response.result); else status('Folder choice canceled.');
    } catch (error) { render(null); status(error.message, true); }
    finally { working = window.recoveryBusy = false; document.body.classList.remove('busy'); controls(); }
  }
  function checked(value) {
    render(value); $('recovery-result').hidden = $('recovery-reveal').hidden = true;
    status(value.recoverable ? 'Backup verified. Confirm it is closed to create a separate recovered copy.' : 'Recovery is blocked. Keep this export folder unchanged.');
  }
  $('recovery-open').addEventListener('click', () => {
    if (document.body.classList.contains('busy') || window.transferBusy || window.templateBusy) return;
    dialog.showModal(); controls();
  });
  $('recovery-close').addEventListener('click', () => { if (!working) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (working) event.preventDefault(); });
  $('recovery-choose').addEventListener('click', () => run(() => api.openRecovery(), 'Checking the retained backup…', checked));
  $('recovery-refresh').addEventListener('click', () => run(() => api.refreshRecovery(), 'Verifying the backup again…', checked));
  $('recovery-closed').addEventListener('change', controls);
  $('recovery-restore').addEventListener('click', () => {
    if (!review?.recoverable || !$('recovery-closed').checked) return;
    const reviewDigest = review.reviewDigest;
    run(() => api.restoreRecovery({ reviewDigest, confirmedClosed: true }), 'Rechecking the backup and creating a recovered copy…', result => {
      render(null); $('recovery-result').textContent = result.world; $('recovery-result').hidden = $('recovery-reveal').hidden = false;
      status('Recovered copy created and verified. The retained backup is unchanged. Minecraft load testing has not been performed.');
    });
  });
  $('recovery-reveal').addEventListener('click', () => run(() => api.revealRecovery(), 'Opening the recovered copy location…', () => status('Recovered copy shown in your file browser.')));
  api.onProgress(value => { if (working) status(`${value.phase}${Number.isFinite(value.completed) && Number.isFinite(value.total) ? ` · ${value.completed.toLocaleString()} / ${value.total.toLocaleString()}` : ''}`); });
})();
