'use strict';

// Anonymous installation / daily-active counts only. Independent of error diagnostics.
// No account or renderer data.
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { persistentInstallationId } = require('./sentry-report.js');
const { sharedDataDir } = require('./profiles.js');
const ENDPOINT = 'https://workdaddy.dev/api/track';
const RETRY_MS = 6 * 3600000;
const usageDay = (time) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);

function sendUsage(body, signal) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    let timer;
    const finish = (result) => { clearTimeout(timer); resolve(result); };
    const req = https.request(ENDPOINT, { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      // Never follow redirects or read/log the response body. A Pages fallback
      // page is not an acknowledgement from the collector.
      finish({ status: res.headers['x-workdaddy-usage'] === '1' ? res.statusCode : 0 });
      res.destroy();
    });
    timer = setTimeout(() => { finish({ status: 0 }); req.destroy(); }, 5000);
    timer.unref();
    req.on('error', () => finish({ status: 0 }));
    req.end(data);
  });
}

function createUsageReporter(options) {
  const dir = options.dataDir || process.env.WBSWITCH_SHARED_DATA_DIR || sharedDataDir();
  const file = path.join(dir, 'usage-state.json');
  const lock = path.join(dir, '.usage-report.lock');
  const now = options.now || Date.now;
  const getId = options.installationId || persistentInstallationId;
  const send = options.send || sendUsage;
  let pending = null, controller = null;

  async function attempt() {
    const id = getId();
    if (!id) return; // An ephemeral ID would inflate the installation count.
    let locked = false, temp = '';
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // CN and AI share identity AND quota. A crashed process leaves an empty
      // lock directory; a live request has a five-second total timeout.
      try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true; }
      catch (error) {
        if (error.code !== 'EEXIST' || Date.now() - fs.statSync(lock).mtimeMs < 60000) return;
        fs.rmdirSync(lock);
        fs.mkdirSync(lock, { mode: 0o700 }); locked = true;
      }
      const time = now(), day = usageDay(time);
      let state = { day, attempts: 0, lastAttempt: 0, sent: false };
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!/^\d{4}-\d{2}-\d{2}$/.test(saved.day) || !Number.isInteger(saved.attempts)
          || saved.attempts < 0 || saved.attempts > 3 || !Number.isFinite(saved.lastAttempt)
          || typeof saved.sent !== 'boolean') return;
        if (saved.day >= day) state = saved;
      } catch (error) { if (error.code !== 'ENOENT') return; }
      if (state.sent || state.attempts >= 3 || (state.attempts && time - state.lastAttempt < RETRY_MS)) return;
      const save = () => {
        temp = `${file}.tmp.${process.pid}`;
        fs.writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600 });
        // No blocking retry loop: telemetry must not delay local app operations.
        fs.renameSync(temp, file);
        temp = '';
      };
      state.attempts++; state.lastAttempt = time;
      save(); // Persist the attempt BEFORE sending, including across restarts.
      controller = new AbortController();
      const result = await send({ installationId: id, profile: options.profile,
        version: options.version, platform: process.platform, arch: process.arch,
        osRelease: os.release().slice(0, 80) }, controller.signal);
      if (result && result.status === 204) { state.sent = true; save(); }
    } catch (_) {
      // Offline, full disk, locked state or exhausted free quota: skip silently.
    } finally {
      controller = null;
      if (temp) try { fs.unlinkSync(temp); } catch (_) {}
      if (locked) try { fs.rmdirSync(lock); } catch (_) {}
    }
  }
  return {
    report() {
      if (!pending) pending = attempt().finally(() => { pending = null; });
      return pending;
    },
    cancel() { if (controller) controller.abort(); },
  };
}

module.exports = { createUsageReporter, usageDay };
