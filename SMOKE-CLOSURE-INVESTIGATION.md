# Installed 3D smoke closure — 2026-10-16

**Classification: unresolved original closure; no demonstrated application regression.** Six instrumented repetitions passed, but these passes do not establish the cause of the original event.

## Original observation

The installed 0.5.12-test.1 preview smoke failed at 17:13:17 UTC while waiting for the disjoint Overworld preview after returning from the Nether. Playwright reported `Target page, context or browser has been closed`. The preceding desktop and recovery smokes passed. The failed run retained its three earlier screenshots but no process-exit, renderer-crash or close-order diagnostics.

Retained macOS logs identify the failed instance as PID 84432. LaunchServices recorded `exitStatus=0` at 17:13:17.348505 UTC. There was no matching new WorldRenew diagnostic crash report in the user or system diagnostic-report directories. This evidence does not identify who initiated closure and does not rule out a renderer failure followed by harness cleanup. The harness's existing `finally` block calls `app.close()`, so a clean final application exit is insufficient to classify the earlier page loss.

The system log query used explicit `+0000` start/end offsets. The Mac's local zone was CDT; `log show --timezone UTC` controls displayed timestamps, not interpretation of an unqualified input time. Earlier empty queries with unqualified times are excluded from the conclusions.

## Bounded reproduction

Six consecutive runs used the unchanged installed app, fresh generated worlds and isolated profiles. Each exercised all nine preview checks, including the original Nether-to-disjoint-Overworld transition. All six passed in approximately 3.7 seconds each. Each recorded exit code 0 with no signal, after `harness-close-request`; none recorded an earlier close, renderer crash, main exception or process exit.

The normal profile's 321 entries and installed application payload hash were unchanged. No user world was opened. The installed payload remains SHA-256 `2e1679fc7681047320adf242a38961a3481d544df47ae2238682aad58192af34` from application commit `5fb7d972be90846918a043c04386b145b7491839`.

## Change and remaining uncertainty

Added test-only lifecycle capture to `scripts/smoke-preview-location.mjs`, using `scripts/smoke-lifecycle.mjs`. Future runs retain timestamps for harness cleanup, Electron quit/window events, renderer/child-process loss, uncaught-exception monitoring, page close/crash and child exit code/signal, plus bounded Electron stderr. The observers do not prevent closure, catch application exceptions or replace lifecycle methods. Failed diagnostic setup also reaches harness cleanup.

No production code was changed, no speculative fix was applied and no new app was installed for this investigation. The installed binary and existing build artifacts are unchanged. The original event remains neither a verified harness defect nor a verified application crash. If it recurs, compare the captured event order before `harness-close-request`; do not treat the later cleanup exit as its cause.

Local evidence is retained under `work/closure-investigation/`: `report.json`, `repetitions.json`, six run logs, corrected UTC system logs and profile/payload preservation results. Each run's fixture directory contains `lifecycle.jsonl`, `results.json` and screenshots. These local logs and profiles are not included in source commits or application packages.
