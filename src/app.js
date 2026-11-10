'use strict';

/* =====================================================================
   Hillhaven Poker Club timer
   ===================================================================== */

const STORE_KEY = 'hillhaven.v1';
const CLUB_NAME = 'Hillhaven Poker Club';
const DEFAULT_LEVELS = [
  [5, 5], [5, 10], [10, 20], [15, 30], [25, 50], [50, 100], [75, 150], [100, 200],
  [150, 300], [200, 400], [300, 600], [400, 800], [500, 1000], [1000, 2000], [2000, 4000], [4000, 8000],
].map(([sb, bb]) => ({ sb, bb }));

function freshRun(levelMin) {
  return {
    idx: 0, running: false, remaining: levelMin * 60000, endAt: null,
    elapsedBase: 0, runStart: null,   // play time (pauses excluded) — drives the rebuy window
    startedAt: null, stopAt: null,    // wall-clock: when the cigar was lit / when it goes out
    cutoff: null,                     // rebuy cutoff in play-time ms (null = use the default)
    ended: false,
    flags: { warnIdx: -1, rebuy: false, stop: false },
  };
}
function defaults() {
  return {
    club: CLUB_NAME,
    levelMin: 15,
    levels: DEFAULT_LEVELS.map((l) => ({ ...l })),
    stop: { on: true, time: '23:00' },
    rebuy: { on: true, min: 120 },
    opts: { sound: true, warn: true, voice: false, wake: true },
    history: [],
    run: freshRun(15),
  };
}

let S = load();

function load() {
  const d = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return d;
    const s = JSON.parse(raw);
    const out = {
      club: typeof s.club === 'string' && s.club.trim() ? s.club : d.club,
      levelMin: Math.max(1, Number(s.levelMin) || d.levelMin),
      levels: Array.isArray(s.levels) && s.levels.length ? s.levels.map((l) => ({ sb: +l.sb || 0, bb: +l.bb || 0 })) : d.levels,
      stop: { ...d.stop, ...s.stop },
      rebuy: { ...d.rebuy, ...s.rebuy },
      opts: { ...d.opts, ...s.opts },
      history: Array.isArray(s.history) ? s.history : [],
      run: { ...freshRun(Math.max(1, Number(s.levelMin) || 15)), ...s.run },
    };
    out.run.flags = { ...d.run.flags, ...(s.run && s.run.flags) };
    if (out.run.idx > out.levels.length - 1) out.run.idx = out.levels.length - 1;
    return out;
  } catch (e) { return d; }
}
function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* storage unavailable */ } }

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function levelMs() { return Math.max(1, Number(S.levelMin) || 15) * 60000; }
function cur() { return S.levels[S.run.idx]; }

/* ---------- formatting ---------- */
function fmtB(n) {
  if (n >= 1000) { const k = n / 1000; return (Number.isInteger(k) ? k : +k.toFixed(2)) + 'k'; }
  return String(n);
}
function parseB(str) {
  const m = String(str).trim().toLowerCase().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*k?$/);
  if (!m) return NaN;
  return Math.round(parseFloat(m[1]) * (/k\s*$/.test(String(str).trim().toLowerCase()) ? 1000 : 1));
}
const blindsText = (lv) => `${fmtB(lv.sb)} / ${fmtB(lv.bb)}`;
function fmtClock(ms) {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtLeft(ms) {   // "2h 14m" or "9:30"
  const t = Math.max(0, Math.ceil(ms / 1000));
  if (t >= 3600) return `${Math.floor(t / 3600)}h ${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
function fmtMin(min) {   // 120 -> "2h", 90 -> "1h 30m"
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
const fmtTimeOfDay = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
function fmtHHMM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return fmtTimeOfDay(d);
}

/* ---------- time model ---------- */
function remainingMs(now = Date.now()) { return S.run.running ? S.run.endAt - now : S.run.remaining; }
function elapsedMs(now = Date.now()) { return S.run.elapsedBase + (S.run.running ? now - S.run.runStart : 0); }
function rebuyCutoff() { return S.run.cutoff != null ? S.run.cutoff : S.rebuy.min * 60000; }
function resolveStop(from) {
  const [h, m] = S.stop.time.split(':').map(Number);
  const d = new Date(from); d.setHours(h, m, 0, 0);
  if (+d <= from) d.setDate(d.getDate() + 1);
  return +d;
}

function start() {
  const r = S.run;
  if (r.running || r.ended) return;
  unlockAudio();
  const now = Date.now();
  if (!r.startedAt) {
    r.startedAt = now;
    r.stopAt = S.stop.on ? resolveStop(now) : null;
  }
  if (r.remaining <= 0) r.remaining = levelMs();
  r.running = true; r.endAt = now + r.remaining; r.runStart = now;
  save(); requestWake(); render();
}
function pause() {
  const r = S.run;
  if (!r.running) return;
  const now = Date.now();
  r.remaining = Math.max(0, r.endAt - now);
  r.elapsedBase += now - r.runStart;
  r.running = false; r.endAt = null; r.runStart = null;
  save(); releaseWake(); render();
}
function toggle() { S.run.running ? pause() : start(); }

function setRemaining(ms) {
  if (S.run.ended) return;
  ms = Math.max(0, Math.round(ms));
  if (S.run.running) S.run.endAt = Date.now() + ms; else S.run.remaining = ms;
  if (ms > 60000) S.run.flags.warnIdx = -1;
  save(); render();
}
function adjust(delta) { setRemaining(remainingMs() + delta); }

function goTo(idx, announceIt = true) {
  if (S.run.ended) return;
  idx = clamp(idx, 0, S.levels.length - 1);
  S.run.idx = idx;
  if (S.run.running) S.run.endAt = Date.now() + levelMs(); else S.run.remaining = levelMs();
  S.run.flags.warnIdx = -1;
  save(); render();
  if (announceIt) announceLevel(false);
}

function endGame() {
  const r = S.run;
  if (r.ended) return;
  if (r.running) { r.elapsedBase += Math.max(0, (r.stopAt || Date.now()) - r.runStart); }
  r.running = false; r.endAt = null; r.runStart = null; r.ended = true;
  save(); releaseWake();
  bell(3);
  speak("Time. That's the hard stop.");
  vibrate([500, 200, 500, 200, 500]);
}

function tick() {
  const now = Date.now(), r = S.run;
  if (!r.ended) {
    if (r.running) {
      const t = r.stopAt && now >= r.stopAt ? r.stopAt : now;   // catch up only to the hard stop
      let changed = false;
      while (r.endAt - t <= 0) {
        if (r.idx < S.levels.length - 1) r.idx++;
        r.endAt += levelMs();
        r.flags.warnIdx = -1;
        changed = true;
      }
      if (r.stopAt && now >= r.stopAt) { endGame(); render(); return; }
      if (changed) { save(); announceLevel(true); }
      else if (S.opts.warn && r.flags.warnIdx !== r.idx && r.endAt - now <= 60000 && levelMs() > 60000) {
        r.flags.warnIdx = r.idx; save();
        softTick(); vibrate([150, 80, 150]);
        speak('One minute remaining.');
      }
      if (S.rebuy.on && !r.flags.rebuy && elapsedMs(now) >= rebuyCutoff()) {
        r.flags.rebuy = true; save();
        bell(1); speak('Rebuys are now closed.'); toast('Rebuys are now closed');
      }
      if (r.stopAt && !r.flags.stop && r.stopAt - now <= 15 * 60000) {
        r.flags.stop = true; save();
        softTick(); speak('Fifteen minutes to the hard stop.'); toast('15 minutes to the hard stop');
      }
    } else if (r.stopAt && now >= r.stopAt) {
      endGame();
    }
  }
  render();
}

/* ---------- sound ---------- */
let actx = null;
function unlockAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { /* no audio */ }
}
function strike(freq, when, vol = 0.5) {
  if (!actx) return;
  const t = actx.currentTime + when;
  [[1, 1], [2.76, 0.45], [5.4, 0.2]].forEach(([mult, amp]) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'sine'; o.frequency.value = freq * mult;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol * amp, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6 / mult ** 0.35);
    o.connect(g).connect(actx.destination);
    o.start(t); o.stop(t + 1.8);
  });
}
function bell(times = 1) {
  if (!S.opts.sound) return;
  for (let i = 0; i < times; i++) strike(740, i * 0.9);
}
function softTick() {
  if (!S.opts.sound || !actx) return;
  strike(1180, 0, 0.22); strike(1180, 0.28, 0.22);
}
function vibrate(p) { if (navigator.vibrate) { try { navigator.vibrate(p); } catch (e) { /* ignore */ } } }
function speak(text) {
  if (!S.opts.voice || !('speechSynthesis' in window)) return;
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.rate = 0.95; speechSynthesis.speak(u); } catch (e) { /* ignore */ }
}
function announceLevel(withBell) {
  if (withBell) { bell(1); vibrate([300, 120, 300]); }
  const lv = cur();
  setTimeout(() => speak(`Level ${S.run.idx + 1}. Blinds ${lv.sb} and ${lv.bb}.`), withBell && S.opts.sound ? 1500 : 0);
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

/* ---------- wake lock ---------- */
let wakeLock = null;
async function requestWake() {
  if (!S.opts.wake || !S.run.running || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}
function releaseWake() { try { wakeLock && wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tick(); requestWake(); } });

/* =====================================================================
   Rendering
   ===================================================================== */
const RING_R = 170, RING_C = 2 * Math.PI * RING_R;
const CIG = { x0: 40, x1: 600, ashLen: 30 };

function burnFraction(now) {
  const r = S.run;
  if (!r.startedAt) return 0;
  if (r.ended) return 1;
  if (r.stopAt) return clamp((now - r.startedAt) / (r.stopAt - r.startedAt), 0, 1);
  return clamp(elapsedMs(now) / (S.levels.length * levelMs()), 0, 1);
}

function render() {
  const now = Date.now(), r = S.run, lv = cur();
  const rem = remainingMs(now);
  document.title = S.club;
  $('club').textContent = S.club;

  // dial
  const dial = $('dial');
  dial.classList.toggle('paused', !r.running && !r.ended);
  dial.classList.toggle('ended', r.ended);
  dial.classList.toggle('warn', r.running && rem <= 60000);
  const frac = clamp(rem / levelMs(), 0, 1);
  const len = Math.max(0.001, frac * RING_C);
  $('ring').setAttribute('stroke-dasharray', `${len} ${RING_C}`);
  const ang = frac * 2 * Math.PI;
  $('fuse').setAttribute('transform', `translate(${200 + RING_R * Math.sin(ang)} ${200 - RING_R * Math.cos(ang)})`);

  const clockText = fmtClock(rem);
  $('clock').textContent = r.ended ? '0:00' : clockText;
  $('clock').classList.toggle('long', clockText.length > 5);
  if (r.ended) {
    $('lvlLabel').textContent = 'Game over';
    $('blinds').textContent = 'TIME';
    $('next').textContent = S.stop.on ? `Hard stop · ${fmtHHMM(S.stop.time)}` : '';
  } else {
    $('lvlLabel').textContent = `Level ${r.idx + 1}${!r.running ? (r.startedAt ? ' · Paused' : '') : ''}`;
    $('blinds').textContent = blindsText(lv);
    const nx = S.levels[r.idx + 1];
    $('next').textContent = nx ? `Next ${blindsText(nx)}` : 'Final level';
  }

  // controls
  const play = $('playBtn');
  play.classList.toggle('running', r.running);
  play.setAttribute('aria-label', r.running ? 'Pause' : 'Start');
  $('playIcon').innerHTML = r.running ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4v16l13-8z"/>';
  document.querySelector('.controls').classList.toggle('off', r.ended);
  $('endBanner').hidden = !(r.ended && $('sheet').hidden && $('results').hidden);

  // rebuy pill
  const rp = $('rebuyPill');
  rp.hidden = !S.rebuy.on;
  if (S.rebuy.on) {
    const cut = rebuyCutoff(), el = elapsedMs(now);
    const open = el < cut;
    rp.classList.toggle('open', open); rp.classList.toggle('closed', !open);
    $('rebuyVal').textContent = open ? 'Open' : 'Closed';
    $('rebuySub').textContent = open
      ? (r.startedAt ? `${fmtLeft(cut - el)} left` : `first ${fmtMin(Math.round(cut / 60000))} of play`)
      : 'no more rebuys';
  }
  $('stopPill').classList.toggle('soon', !!(r.stopAt && !r.ended && r.stopAt - now <= 15 * 60000));
  $('rebuyPill').parentElement.style.gridTemplateColumns = S.rebuy.on ? '' : '1fr';

  // hard stop pill
  if (!S.stop.on) {
    $('stopVal').textContent = 'None'; $('stopSub').textContent = 'tap to set';
  } else {
    $('stopVal').textContent = r.stopAt ? fmtTimeOfDay(r.stopAt) : fmtHHMM(S.stop.time);
    $('stopSub').textContent = r.ended ? 'game over' : r.stopAt ? `${fmtLeft(r.stopAt - now)} left` : 'when the clock starts';
  }

  // cigar
  const f = burnFraction(now), tip = CIG.x0 + (CIG.x1 - CIG.x0) * f;
  const cig = $('cigar'), lit = !!r.startedAt;
  cig.classList.toggle('lit', lit);
  cig.classList.toggle('burning', r.running);
  $('cBody').setAttribute('x', tip); $('cBody').setAttribute('width', CIG.x1 - tip);
  $('cFire').setAttribute('transform', `translate(${tip - CIG.x0} 0)`);
  $('cSmoke').setAttribute('transform', `translate(${CIG.x0 - 18} 28)`);
  $('cBand').style.display = tip < 490 ? '' : 'none';
  if (r.ended) cig.classList.remove('burning');
  $('capL').textContent = lit ? `Lit ${fmtTimeOfDay(r.startedAt)}` : 'Press ▶ to light up';
  $('capR').textContent = S.stop.on ? `Out ${r.stopAt ? fmtTimeOfDay(r.stopAt) : fmtHHMM(S.stop.time)}` : '';

  if (!$('sheet').hidden) highlightRow();
}

/* =====================================================================
   Main screen events
   ===================================================================== */
$('playBtn').addEventListener('click', toggle);
$('prevBtn').addEventListener('click', () => {
  const into = levelMs() - remainingMs();
  if (into > 10000 || S.run.idx === 0) goTo(S.run.idx, false); else goTo(S.run.idx - 1);
});
$('nextBtn').addEventListener('click', () => { if (S.run.idx < S.levels.length - 1) goTo(S.run.idx + 1); });
$('minusBtn').addEventListener('click', () => adjust(-60000));
$('plusBtn').addEventListener('click', () => adjust(60000));
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  if (!$('sheet').hidden || !$('results').hidden) return;
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight') $('nextBtn').click();
  else if (e.key === 'ArrowLeft') $('prevBtn').click();
});

/* ---------- dialogs ---------- */
function openDlg(id) { $(id).hidden = false; }
function closeDlg(id) { $(id).hidden = true; }
['timeDlg', 'rebuyDlg', 'stopDlg'].forEach((id) => $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeDlg(id); }));

// set time
$('clock').addEventListener('click', () => {
  if (S.run.ended) return;
  const t = Math.max(0, Math.ceil(remainingMs() / 1000));
  $('editMin').value = Math.floor(t / 60); $('editSec').value = t % 60;
  openDlg('timeDlg');
});
const dlgSeconds = () => Math.max(0, (parseInt($('editMin').value, 10) || 0) * 60 + (parseInt($('editSec').value, 10) || 0));
function setDlgSeconds(s) { s = Math.max(0, s); $('editMin').value = Math.floor(s / 60); $('editSec').value = s % 60; }
document.querySelectorAll('[data-adj]').forEach((b) => b.addEventListener('click', () => setDlgSeconds(dlgSeconds() + Number(b.dataset.adj))));
$('resetLevelTime').addEventListener('click', () => setDlgSeconds(levelMs() / 1000));
$('timeCancel').addEventListener('click', () => closeDlg('timeDlg'));
$('timeOk').addEventListener('click', () => { setRemaining(dlgSeconds() * 1000); closeDlg('timeDlg'); });

// rebuy window
function rebuyDlgText() {
  const cut = rebuyCutoff(), el = elapsedMs();
  $('rebuyDlgText').textContent = el < cut
    ? (S.run.startedAt ? `Rebuys are open for another ${fmtLeft(cut - el)} of play.` : `Rebuys will close ${fmtMin(Math.round(cut / 60000))} after the clock starts.`)
    : 'Rebuys are closed.';
}
function setCutoff(ms) {
  S.run.cutoff = Math.max(0, ms);
  S.run.flags.rebuy = elapsedMs() >= S.run.cutoff;   // no announcement for a change you made yourself
  save(); rebuyDlgText(); render();
}
$('rebuyPill').addEventListener('click', () => { rebuyDlgText(); openDlg('rebuyDlg'); });
document.querySelectorAll('[data-rb]').forEach((b) => b.addEventListener('click', () => {
  const d = Number(b.dataset.rb) * 60000, el = elapsedMs(), cut = rebuyCutoff();
  setCutoff(d > 0 ? Math.max(cut, el) + d : cut + d);
}));
$('rbCloseNow').addEventListener('click', () => setCutoff(elapsedMs()));
$('rbReset').addEventListener('click', () => { S.run.cutoff = null; S.run.flags.rebuy = elapsedMs() >= rebuyCutoff(); save(); rebuyDlgText(); render(); });
$('rbDone').addEventListener('click', () => closeDlg('rebuyDlg'));

// hard stop
$('stopPill').addEventListener('click', () => { $('stopTimeIn').value = S.stop.time; openDlg('stopDlg'); });
$('stopCancel').addEventListener('click', () => closeDlg('stopDlg'));
$('stopOk').addEventListener('click', () => {
  if (/^\d{1,2}:\d{2}$/.test($('stopTimeIn').value)) applyStop(true, $('stopTimeIn').value);
  closeDlg('stopDlg');
});
function applyStop(on, time) {
  S.stop.on = on; S.stop.time = time || S.stop.time;
  if (S.run.startedAt && !S.run.ended) { S.run.stopAt = on ? resolveStop(Date.now()) : null; S.run.flags.stop = false; }
  save(); render();
}

/* =====================================================================
   Settings
   ===================================================================== */
function openSettings() { syncSettings(); renderTable(); $('sheet').hidden = false; render(); }
function closeSettings() { $('sheet').hidden = true; render(); }
$('openSettings').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', closeSettings);

function syncSettings() {
  $('sName').value = S.club;
  $('sLevelMin').value = S.levelMin;
  $('sStopOn').checked = S.stop.on; $('sStopTime').value = S.stop.time;
  $('stopTimeRow').style.display = S.stop.on ? '' : 'none';
  $('sRebuyOn').checked = S.rebuy.on; $('sRebuyMin').value = S.rebuy.min;
  $('rebuyMinRow').style.display = S.rebuy.on ? '' : 'none';
  $('oSound').checked = S.opts.sound; $('oWarn').checked = S.opts.warn; $('oVoice').checked = S.opts.voice; $('oWake').checked = S.opts.wake;
}
$('sName').addEventListener('input', () => { S.club = $('sName').value.trim() ? $('sName').value : CLUB_NAME; save(); render(); });
$('sName').addEventListener('change', () => { if (!$('sName').value.trim()) $('sName').value = CLUB_NAME; });
$('sLevelMin').addEventListener('change', () => {
  const was = levelMs();
  S.levelMin = clamp(parseInt($('sLevelMin').value, 10) || 15, 1, 120);
  $('sLevelMin').value = S.levelMin;
  if (!S.run.startedAt) S.run.remaining = levelMs();
  else if (S.run.remaining === was) S.run.remaining = levelMs();
  save(); render();
});
$('sStopOn').addEventListener('change', () => { applyStop($('sStopOn').checked); syncSettings(); });
$('sStopTime').addEventListener('change', () => { if ($('sStopTime').value) applyStop(S.stop.on, $('sStopTime').value); });
$('sRebuyOn').addEventListener('change', () => { S.rebuy.on = $('sRebuyOn').checked; save(); syncSettings(); render(); });
$('sRebuyMin').addEventListener('change', () => {
  S.rebuy.min = clamp(parseInt($('sRebuyMin').value, 10) || 120, 1, 600);
  $('sRebuyMin').value = S.rebuy.min;
  S.run.flags.rebuy = elapsedMs() >= rebuyCutoff();
  save(); render();
});
[['oSound', 'sound'], ['oWarn', 'warn'], ['oVoice', 'voice'], ['oWake', 'wake']].forEach(([id, k]) => $(id).addEventListener('change', () => {
  S.opts[k] = $(id).checked; save();
  if (k === 'wake') (S.opts.wake ? requestWake() : releaseWake());
  if (k === 'voice' && S.opts.voice) { unlockAudio(); speak('Voice announcements on.'); }
}));
$('testSound').addEventListener('click', () => { unlockAudio(); bell(1); setTimeout(() => speak(`Blinds ${cur().sb} and ${cur().bb}.`), 1200); });

// level table
function renderTable() {
  const tb = document.querySelector('#levelTable tbody');
  tb.innerHTML = '';
  S.levels.forEach((lv, i) => {
    const tr = document.createElement('tr'); tr.dataset.i = i;
    tr.innerHTML = `<td>${i + 1}</td>
      <td><input type="text" inputmode="text" data-k="sb" value="${fmtB(lv.sb)}" autocomplete="off"></td>
      <td><input type="text" inputmode="text" data-k="bb" value="${fmtB(lv.bb)}" autocomplete="off"></td>
      <td><button class="del" aria-label="Delete level">×</button></td>`;
    tb.appendChild(tr);
  });
  $('lvlCount').textContent = `${S.levels.length} levels`;
  highlightRow();
}
function highlightRow() {
  document.querySelectorAll('#levelTable tbody tr').forEach((tr) => tr.classList.toggle('current', Number(tr.dataset.i) === S.run.idx));
}
document.querySelector('#levelTable tbody').addEventListener('change', (e) => {
  const inp = e.target.closest('input'); if (!inp) return;
  const i = Number(inp.closest('tr').dataset.i), k = inp.dataset.k, v = parseB(inp.value);
  if (Number.isFinite(v) && v > 0) S.levels[i][k] = v;
  inp.value = fmtB(S.levels[i][k]);
  save(); render();
});
document.querySelector('#levelTable tbody').addEventListener('click', (e) => {
  const del = e.target.closest('.del'); if (!del || S.levels.length <= 1) return;
  const i = Number(del.closest('tr').dataset.i);
  S.levels.splice(i, 1);
  if (i < S.run.idx) S.run.idx--; else if (S.run.idx > S.levels.length - 1) S.run.idx = S.levels.length - 1;
  save(); renderTable(); render();
});
$('addLevel').addEventListener('click', () => {
  const last = S.levels[S.levels.length - 1];
  S.levels.push({ sb: last.bb, bb: last.bb * 2 });
  save(); renderTable(); render();
});
$('resetLevels').addEventListener('click', () => {
  if (!confirm('Put the blind levels back to the club defaults?')) return;
  S.levels = DEFAULT_LEVELS.map((l) => ({ ...l }));
  if (S.run.idx > S.levels.length - 1) S.run.idx = S.levels.length - 1;
  save(); renderTable(); render();
});

// night / reset
function newNight() {
  releaseWake();
  S.run = freshRun(S.levelMin);
  save(); render();
}
$('newNight').addEventListener('click', () => {
  if (!confirm('Start a new night? The clock, rebuy window and hard stop all reset.')) return;
  newNight(); closeSettings();
});
$('resetAll').addEventListener('click', () => {
  if (!confirm('Reset every setting to the club defaults? Saved winners are kept.')) return;
  const hist = S.history;
  releaseWake();
  S = defaults(); S.history = hist; save();
  syncSettings(); renderTable(); render();
});

/* =====================================================================
   Winners
   ===================================================================== */
function openResults() { renderResults(); $('results').hidden = false; render(); }
function closeResults() { $('results').hidden = true; render(); }
$('openResults').addEventListener('click', openResults);
$('closeResults').addEventListener('click', closeResults);
$('ebWinners').addEventListener('click', openResults);
$('ebNew').addEventListener('click', () => {
  if (!confirm('Start a new night? Make sure the winners are recorded first.')) return;
  newNight();
});

function nameKey(n) { return n.trim().toLowerCase(); }
function renderResults() {
  $('tonightLabel').textContent = 'Tonight, ' + new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  // known names for quick entry
  const names = new Map();
  S.history.forEach((h) => [h.first, h.second, h.third].forEach((n) => { if (n && !names.has(nameKey(n))) names.set(nameKey(n), n); }));
  const dl = $('names'); dl.innerHTML = '';
  names.forEach((n) => { const o = document.createElement('option'); o.value = n; dl.appendChild(o); });

  // standings
  const tally = new Map();
  S.history.forEach((h) => [['first', 'w'], ['second', 's'], ['third', 't']].forEach(([f, k]) => {
    const n = h[f]; if (!n) return;
    const key = nameKey(n);
    if (!tally.has(key)) tally.set(key, { name: n, w: 0, s: 0, t: 0 });
    tally.get(key)[k]++;
  }));
  const rows = [...tally.values()].sort((a, b) => b.w - a.w || b.s - a.s || b.t - a.t || a.name.localeCompare(b.name));
  $('standingsCard').hidden = $('standingsLabel').hidden = !rows.length;
  const st = $('standings'); st.innerHTML = '';
  rows.forEach((r) => {
    const d = document.createElement('div'); d.className = 'srow';
    const n = document.createElement('span'); n.className = 'n'; n.textContent = r.name;
    const c = document.createElement('span'); c.className = 'c'; c.innerHTML = `<b>${r.w}</b> wins · ${r.s} 2nd · ${r.t} 3rd`;
    d.append(n, c); st.appendChild(d);
  });

  // history
  $('historyCard').hidden = $('historyLabel').hidden = !S.history.length;
  const hi = $('history'); hi.innerHTML = '';
  [...S.history].reverse().forEach((h) => {
    const d = document.createElement('div'); d.className = 'hrow';
    const dt = document.createElement('span'); dt.className = 'd';
    dt.textContent = new Date(h.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    const w = document.createElement('span'); w.className = 'w';
    w.textContent = [h.first && `1st ${h.first}`, h.second && `2nd ${h.second}`, h.third && `3rd ${h.third}`].filter(Boolean).join(' · ');
    const x = document.createElement('button'); x.className = 'del'; x.textContent = '×'; x.setAttribute('aria-label', 'Delete this night');
    x.addEventListener('click', () => {
      if (!confirm('Delete this night from the record?')) return;
      S.history = S.history.filter((e) => e.id !== h.id); save(); renderResults();
    });
    d.append(dt, w, x); hi.appendChild(d);
  });
}
$('saveResult').addEventListener('click', () => {
  const first = $('rFirst').value.trim(), second = $('rSecond').value.trim(), third = $('rThird').value.trim();
  if (!first && !second && !third) { toast('Enter at least a winner'); return; }
  S.history.push({ id: Date.now(), date: new Date().toISOString(), first, second, third });
  save();
  $('rFirst').value = $('rSecond').value = $('rThird').value = '';
  renderResults(); toast('Result saved');
});

/* ---------- boot ---------- */
render();
setInterval(tick, 250);
if (S.run.running) requestWake();
document.addEventListener('pointerdown', unlockAudio, { once: true });
tick();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
