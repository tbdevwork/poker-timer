'use strict';

/* ---------- Defaults ---------- */
const STORE_KEY = 'pokerTimer.v1';

const PRESETS = {
  turbo:    { startBB: 50,  min: 10, count: 16, mode: 'pct', pct: 50, fixed: 50,  ante: 'bb',   anteFrom: 4, breakEvery: 6, breakMin: 5 },
  standard: { startBB: 50,  min: 20, count: 16, mode: 'pct', pct: 40, fixed: 50,  ante: 'bb',   anteFrom: 5, breakEvery: 4, breakMin: 10 },
  deep:     { startBB: 100, min: 30, count: 18, mode: 'pct', pct: 30, fixed: 100, ante: 'bb',   anteFrom: 6, breakEvery: 4, breakMin: 15 },
};

function defaultState() {
  const gen = { ...PRESETS.standard };
  const levels = generateLevels(gen);
  return {
    gen,
    levels,
    tourney: {
      name: 'Home Game', currency: '$', buyIn: 20, startStack: 10000,
      entries: 9, players: 9, rebuys: 0, rebuyChips: 10000,
      addons: 0, addonCost: 10, addonChips: 5000,
    },
    settings: { sound: true, warn: true, warnSec: 60, countdown: true, voice: false, vibrate: true, wake: true },
    run: freshRun(levels),
  };
}

function freshRun(levels) {
  return { idx: 0, running: false, remaining: levelMs(levels[0]), endAt: null, elapsedBase: 0, runStart: null, warnedIdx: -1 };
}

/* ---------- Structure generation ---------- */
// A ladder of "nice" chip amounts: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10^k
const LADDER = (() => {
  const m = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8];
  const out = new Set();
  for (let k = 0; k <= 8; k++) for (const x of m) { const v = Math.round(x * 10 ** k); if (v >= 1) out.add(v); }
  return [...out].sort((a, b) => a - b);
})();

function niceAbove(target, prev) {
  // closest ladder value to target that is strictly greater than prev
  let best = null, bestDiff = Infinity;
  for (const v of LADDER) {
    if (v <= prev) continue;
    const d = Math.abs(v - target);
    if (d <= bestDiff) { best = v; bestDiff = d; } else if (v > target) break;
  }
  return best ?? Math.ceil(target);
}
function niceNear(target) {
  let best = LADDER[0];
  for (const v of LADDER) if (Math.abs(v - target) < Math.abs(best - target)) best = v;
  return best;
}

function generateLevels(g) {
  const levels = [];
  let bb = Math.max(1, Math.round(g.startBB));
  for (let i = 0; i < g.count; i++) {
    if (i > 0) {
      bb = g.mode === 'fixed'
        ? bb + Math.max(1, Math.round(g.fixed))
        : niceAbove(bb * (1 + g.pct / 100), bb);
    }
    const sb = Math.max(1, Math.round(bb / 2));
    let ante = 0;
    if (i + 1 >= g.anteFrom) {
      if (g.ante === 'bb') ante = bb;
      else if (g.ante === 'classic') ante = Math.max(1, niceNear(bb / 8));
    }
    levels.push({ type: 'level', sb, bb, ante, min: g.min });
    if (g.breakEvery > 0 && (i + 1) % g.breakEvery === 0 && i < g.count - 1) {
      levels.push({ type: 'break', min: g.breakMin });
    }
  }
  return levels;
}

/* ---------- State ---------- */
let S = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaultState();
      if (Array.isArray(s.levels) && s.levels.length) {
        return {
          gen: { ...d.gen, ...s.gen },
          levels: s.levels,
          tourney: { ...d.tourney, ...s.tourney },
          settings: { ...d.settings, ...s.settings },
          run: { ...d.run, ...s.run },
        };
      }
    }
  } catch (e) { /* ignore */ }
  return defaultState();
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
}

function levelMs(lv) { return Math.max(1, Number(lv?.min) || 1) * 60000; }
function cur() { return S.levels[S.run.idx]; }

/* ---------- Timer core ---------- */
function remainingMs(now = Date.now()) {
  return S.run.running ? S.run.endAt - now : S.run.remaining;
}
function elapsedMs(now = Date.now()) {
  return S.run.elapsedBase + (S.run.running ? now - S.run.runStart : 0);
}

function start() {
  if (S.run.running) return;
  unlockAudio();
  if (S.run.remaining <= 0) {
    if (S.run.idx >= S.levels.length - 1) return;
    goTo(S.run.idx + 1, false);
  }
  const now = Date.now();
  S.run.running = true;
  S.run.endAt = now + S.run.remaining;
  S.run.runStart = now;
  save(); requestWake(); render();
}
function pause() {
  if (!S.run.running) return;
  const now = Date.now();
  S.run.remaining = Math.max(0, S.run.endAt - now);
  S.run.elapsedBase += now - S.run.runStart;
  S.run.running = false;
  S.run.endAt = null; S.run.runStart = null;
  save(); releaseWake(); render();
}
function toggle() { S.run.running ? pause() : start(); }

function setRemaining(ms) {
  ms = Math.max(0, Math.round(ms));
  if (S.run.running) S.run.endAt = Date.now() + ms;
  else S.run.remaining = ms;
  if (ms > S.settings.warnSec * 1000) S.run.warnedIdx = -1;
  save(); render();
}
function adjust(deltaMs) { setRemaining(remainingMs() + deltaMs); }

function goTo(idx, announceIt = true) {
  idx = Math.max(0, Math.min(S.levels.length - 1, idx));
  S.run.idx = idx;
  const ms = levelMs(S.levels[idx]);
  if (S.run.running) S.run.endAt = Date.now() + ms;
  else S.run.remaining = ms;
  S.run.warnedIdx = -1;
  save(); render();
  if (announceIt) announce(false);
}

let lastTickSec = null;
function tick() {
  if (S.run.running) {
    const now = Date.now();
    let rem = S.run.endAt - now;
    let changed = false;
    // Catch up across as many levels as have elapsed (e.g. phone was locked)
    while (rem <= 0 && S.run.idx < S.levels.length - 1) {
      S.run.idx++;
      S.run.endAt += levelMs(S.levels[S.run.idx]);
      rem = S.run.endAt - now;
      S.run.warnedIdx = -1;
      changed = true;
    }
    if (rem <= 0) {
      // End of final level
      S.run.elapsedBase += now - S.run.runStart;
      S.run.running = false; S.run.remaining = 0; S.run.endAt = null; S.run.runStart = null;
      save(); releaseWake();
      alarm();
    } else if (changed) {
      save();
      announce(true);
    } else {
      const sec = Math.ceil(rem / 1000);
      const lv = cur();
      if (S.settings.warn && S.run.warnedIdx !== S.run.idx && rem <= S.settings.warnSec * 1000 && levelMs(lv) > S.settings.warnSec * 1000) {
        S.run.warnedIdx = S.run.idx; save();
        warning();
      }
      if (S.settings.countdown && sec <= 5 && sec >= 1 && sec !== lastTickSec) beep(880, 0.06, 0.15);
      lastTickSec = sec;
    }
  }
  render();
}

/* ---------- Audio / voice / vibration ---------- */
let actx = null;
function unlockAudio() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch (e) { /* no audio */ }
}
function beep(freq = 880, dur = 0.2, vol = 0.35, when = 0) {
  if (!actx) return;
  const t = actx.currentTime + when;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur + 0.05);
}
function alarm() {
  if (S.settings.sound) {
    for (let r = 0; r < 3; r++) {
      beep(988, 0.18, 0.5, r * 0.6);
      beep(1319, 0.3, 0.5, r * 0.6 + 0.2);
    }
  }
  vibrate([400, 150, 400, 150, 400]);
}
function warning() {
  if (S.settings.sound) { beep(660, 0.15, 0.4, 0); beep(660, 0.15, 0.4, 0.25); }
  vibrate([200, 100, 200]);
  const w = S.settings.warnSec;
  const label = w % 60 === 0 ? `${w / 60} minute${w === 60 ? '' : 's'}` : `${w} seconds`;
  speak(`${label} remaining in this ${cur().type === 'break' ? 'break' : 'level'}.`);
}
function vibrate(p) { if (S.settings.vibrate && navigator.vibrate) navigator.vibrate(p); }
function speak(text) {
  if (!S.settings.voice || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    speechSynthesis.speak(u);
  } catch (e) { /* ignore */ }
}
function announce(withAlarm) {
  if (withAlarm) alarm();
  const lv = cur();
  const text = lv.type === 'break'
    ? `Break. ${lv.min} minutes.`
    : `Level ${levelNumber(S.run.idx)}. Blinds ${lv.sb} and ${lv.bb}${lv.ante ? `. Ante ${lv.ante}` : ''}.`;
  setTimeout(() => speak(text), withAlarm && S.settings.sound ? 1900 : 0);
}

/* ---------- Wake lock ---------- */
let wakeLock = null;
async function requestWake() {
  if (!S.settings.wake || !S.run.running || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { wakeLock = null; }
}
function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { tick(); requestWake(); }
});

/* ---------- Formatting ---------- */
const $ = (id) => document.getElementById(id);
const fmtNum = (n) => Math.round(n).toLocaleString();
function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtDur(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}
function fmtMoney(n) {
  const c = S.tourney.currency || '';
  const v = Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return c + v;
}
function levelNumber(idx) {
  let n = 0;
  for (let i = 0; i <= idx && i < S.levels.length; i++) if (S.levels[i].type !== 'break') n++;
  return n;
}
const blindsText = (lv) => `${fmtNum(lv.sb)} / ${fmtNum(lv.bb)}`;

/* ---------- Main render ---------- */
function render() {
  const now = Date.now();
  const lv = cur();
  const rem = remainingMs(now);
  const isBreak = lv.type === 'break';
  document.body.classList.toggle('is-break', isBreak);

  $('tName').textContent = S.tourney.name || 'Poker Timer';
  $('levelLabel').textContent = isBreak ? 'Break' : `Level ${levelNumber(S.run.idx)}`;

  const clock = $('clock');
  clock.textContent = fmtClock(rem);
  clock.classList.toggle('paused', !S.run.running);
  clock.classList.toggle('warning', S.run.running && !isBreak && rem <= S.settings.warnSec * 1000);

  const pct = Math.min(100, Math.max(0, 100 * (1 - rem / levelMs(lv))));
  $('progressBar').style.width = pct + '%';

  if (isBreak) {
    $('blinds').textContent = 'BREAK';
    $('ante').textContent = '';
  } else {
    $('blinds').textContent = blindsText(lv);
    $('ante').textContent = lv.ante ? `Ante ${fmtNum(lv.ante)}` : '';
  }

  const nx = S.levels[S.run.idx + 1];
  let nextText = 'Final level';
  if (nx) {
    if (nx.type === 'break') {
      const after = S.levels.slice(S.run.idx + 2).find(l => l.type !== 'break');
      nextText = `Next: Break (${nx.min}m)` + (after ? ` → ${blindsText(after)}` : '');
    } else {
      nextText = `Next: ${blindsText(nx)}` + (nx.ante ? ` · ante ${fmtNum(nx.ante)}` : '');
    }
  }
  $('next').textContent = nextText;

  const play = $('playBtn');
  play.classList.toggle('running', S.run.running);
  play.setAttribute('aria-label', S.run.running ? 'Pause' : 'Start');
  $('playIcon').innerHTML = S.run.running
    ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>'
    : '<path d="M7 4v16l13-8z"/>';

  // stats
  const t = S.tourney;
  $('sPlayers').textContent = t.players;
  $('sEntries2').textContent = t.entries;
  $('sRebuys').textContent = t.rebuys;
  $('sAddons').textContent = t.addons;
  const chips = t.entries * t.startStack + t.rebuys * t.rebuyChips + t.addons * t.addonChips;
  const pool = t.entries * t.buyIn + t.rebuys * t.buyIn + t.addons * t.addonCost;
  const curBB = isBreak ? (S.levels.slice(S.run.idx).find(l => l.type !== 'break') || {}).bb : lv.bb;
  if (t.players > 0) {
    const avg = chips / t.players;
    $('sAvg').textContent = fmtNum(avg);
    $('sAvgBB').textContent = curBB ? `${Math.round(avg / curBB)} BB` : '';
  } else { $('sAvg').textContent = '–'; $('sAvgBB').textContent = ''; }
  $('sPool').textContent = fmtMoney(pool);
  $('sChips').textContent = `${fmtNum(chips)} chips`;
  $('sElapsed').textContent = fmtDur(elapsedMs(now));

  // next break
  let untilBreak = null;
  if (!isBreak) {
    let acc = rem;
    for (let i = S.run.idx + 1; i < S.levels.length; i++) {
      if (S.levels[i].type === 'break') { untilBreak = acc; break; }
      acc += levelMs(S.levels[i]);
    }
  }
  $('sBreak').textContent = isBreak ? 'Now' : untilBreak == null ? '–' : fmtDur(untilBreak + 59999);

  if (!$('sheet').hidden) highlightCurrentRow();
}

/* ---------- Main screen events ---------- */
$('playBtn').addEventListener('click', toggle);
$('prevBtn').addEventListener('click', () => {
  // If more than 10s into the level, restart it; otherwise go back a level
  const into = levelMs(cur()) - remainingMs();
  if (into > 10000 || S.run.idx === 0) goTo(S.run.idx, false);
  else goTo(S.run.idx - 1);
});
$('nextBtn').addEventListener('click', () => { if (S.run.idx < S.levels.length - 1) goTo(S.run.idx + 1); });
$('minusBtn').addEventListener('click', () => adjust(-60000));
$('plusBtn').addEventListener('click', () => adjust(60000));

document.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
  const key = b.dataset.step, d = Number(b.dataset.d), t = S.tourney;
  t[key] = Math.max(0, t[key] + d);
  if (key === 'entries') t.players = Math.max(0, t.players + d); // new entry = new player at the table
  if (key === 'players') t.players = Math.min(t.players, t.entries); // can't have more players than entries
  save(); render(); syncTournamentForm();
}));

// Keyboard (for desktop / tablets with keyboards)
document.addEventListener('keydown', (e) => {
  if (!$('sheet').hidden || !$('timeDlg').hidden) { if (e.key === 'Escape') { closeSheet(); closeTimeDlg(); } return; }
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.key === 'ArrowRight') $('nextBtn').click();
  else if (e.key === 'ArrowLeft') $('prevBtn').click();
  else if (e.key === 'ArrowUp') adjust(60000);
  else if (e.key === 'ArrowDown') adjust(-60000);
});

/* ---------- Time edit dialog ---------- */
let wasRunningBeforeEdit = false;
function openTimeDlg() {
  const total = Math.max(0, Math.ceil(remainingMs() / 1000));
  $('editMin').value = Math.floor(total / 60);
  $('editSec').value = total % 60;
  $('timeDlg').hidden = false;
}
function closeTimeDlg() { $('timeDlg').hidden = true; }
function dlgSeconds() {
  return Math.max(0, (parseInt($('editMin').value, 10) || 0) * 60 + (parseInt($('editSec').value, 10) || 0));
}
function setDlgSeconds(s) {
  s = Math.max(0, s);
  $('editMin').value = Math.floor(s / 60);
  $('editSec').value = s % 60;
}
$('clock').addEventListener('click', openTimeDlg);
document.querySelectorAll('[data-adj]').forEach(b => b.addEventListener('click', () => setDlgSeconds(dlgSeconds() + Number(b.dataset.adj))));
$('resetLevelTime').addEventListener('click', () => setDlgSeconds(levelMs(cur()) / 1000));
$('timeCancel').addEventListener('click', closeTimeDlg);
$('timeOk').addEventListener('click', () => { setRemaining(dlgSeconds() * 1000); closeTimeDlg(); });
$('timeDlg').addEventListener('click', (e) => { if (e.target === $('timeDlg')) closeTimeDlg(); });

/* ---------- Settings sheet ---------- */
function openSheet() {
  syncGenForm(); syncTournamentForm(); syncOptionsForm(); renderTable();
  $('sheet').hidden = false;
}
function closeSheet() { $('sheet').hidden = true; render(); }
$('openSettings').addEventListener('click', openSheet);
$('closeSettings').addEventListener('click', closeSheet);

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
  document.querySelectorAll('.pane').forEach(p => { p.hidden = p.dataset.pane !== tab.dataset.tab; });
}));

// Generator
const GEN_FIELDS = { gStartBB: 'startBB', gMin: 'min', gCount: 'count', gMode: 'mode', gPct: 'pct', gFixed: 'fixed', gAnte: 'ante', gAnteFrom: 'anteFrom', gBreakEvery: 'breakEvery', gBreakMin: 'breakMin' };
function syncGenForm() {
  for (const [id, k] of Object.entries(GEN_FIELDS)) $(id).value = S.gen[k];
  $('gPctWrap').hidden = S.gen.mode !== 'pct';
  $('gFixedWrap').hidden = S.gen.mode !== 'fixed';
}
for (const [id, k] of Object.entries(GEN_FIELDS)) {
  $(id).addEventListener('change', () => {
    const v = $(id).value;
    S.gen[k] = (k === 'mode' || k === 'ante') ? v : Math.max(0, Number(v) || 0);
    if (k === 'mode') syncGenForm();
    save();
  });
}
document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
  S.gen = { ...PRESETS[b.dataset.preset] };
  syncGenForm(); applyGenerated();
}));
$('generate').addEventListener('click', applyGenerated);

function applyGenerated() {
  const g = S.gen;
  g.startBB = Math.max(1, g.startBB); g.min = Math.max(1, g.min); g.count = Math.min(60, Math.max(1, g.count));
  g.pct = Math.max(1, g.pct); g.fixed = Math.max(1, g.fixed); g.breakMin = Math.max(1, g.breakMin);
  if (S.run.running || S.run.idx > 0 || elapsedMs() > 0) {
    if (!confirm('Replace the current structure? The clock will keep its current level number.')) return;
  }
  S.levels = generateLevels(g);
  structureChanged();
  syncGenForm();
}

function structureChanged() {
  if (S.run.idx > S.levels.length - 1) S.run.idx = S.levels.length - 1;
  // If paused and the current level's full length was showing, keep it in sync with edits
  save(); renderTable(); render();
}

// Level table
function renderTable() {
  const tb = document.querySelector('#levelTable tbody');
  tb.innerHTML = '';
  let n = 0;
  S.levels.forEach((lv, i) => {
    const tr = document.createElement('tr');
    tr.dataset.i = i;
    if (lv.type === 'break') {
      tr.className = 'break-row';
      tr.innerHTML = `<td>☕</td><td colspan="3" class="break-label">Break</td>
        <td><input type="number" inputmode="numeric" min="1" data-k="min" value="${lv.min}"></td>
        <td><button class="del" aria-label="Delete">×</button></td>`;
    } else {
      n++;
      tr.innerHTML = `<td>${n}</td>
        <td><input type="number" inputmode="numeric" min="0" data-k="sb" value="${lv.sb}"></td>
        <td><input type="number" inputmode="numeric" min="0" data-k="bb" value="${lv.bb}"></td>
        <td><input type="number" inputmode="numeric" min="0" data-k="ante" value="${lv.ante}"></td>
        <td><input type="number" inputmode="numeric" min="1" data-k="min" value="${lv.min}"></td>
        <td><button class="del" aria-label="Delete">×</button></td>`;
    }
    tb.appendChild(tr);
  });
  highlightCurrentRow();
}
function highlightCurrentRow() {
  document.querySelectorAll('#levelTable tbody tr').forEach(tr => tr.classList.toggle('current', Number(tr.dataset.i) === S.run.idx));
}
document.querySelector('#levelTable tbody').addEventListener('change', (e) => {
  const inp = e.target.closest('input'); if (!inp) return;
  const i = Number(inp.closest('tr').dataset.i), k = inp.dataset.k;
  const lv = S.levels[i];
  let v = Math.max(0, Number(inp.value) || 0);
  if (k === 'min') v = Math.max(1, v);
  const oldMs = levelMs(lv);
  lv[k] = v;
  if (k === 'bb' && lv.sb > v) lv.sb = Math.round(v / 2);
  // Changing the length of the current level shifts its remaining time by the same amount
  if (k === 'min' && i === S.run.idx) {
    const delta = levelMs(lv) - oldMs;
    setRemaining(Math.max(0, remainingMs() + delta));
  }
  save(); renderTable(); render();
});
document.querySelector('#levelTable tbody').addEventListener('click', (e) => {
  const del = e.target.closest('.del'); if (!del) return;
  if (S.levels.length <= 1) return;
  const i = Number(del.closest('tr').dataset.i);
  S.levels.splice(i, 1);
  if (i < S.run.idx) S.run.idx--;
  else if (i === S.run.idx) { S.run.idx = Math.min(S.run.idx, S.levels.length - 1); goTo(S.run.idx, false); }
  structureChanged();
});
$('addLevel').addEventListener('click', () => {
  const last = [...S.levels].reverse().find(l => l.type !== 'break') || { bb: 50, ante: 0, min: S.gen.min };
  const bb = S.gen.mode === 'fixed' ? last.bb + S.gen.fixed : niceAbove(last.bb * (1 + S.gen.pct / 100), last.bb);
  const ante = last.ante ? (last.ante === last.bb ? bb : Math.max(1, niceNear(bb / 8))) : 0;
  S.levels.push({ type: 'level', sb: Math.round(bb / 2), bb, ante, min: last.min });
  structureChanged();
});
$('addBreak').addEventListener('click', () => {
  S.levels.push({ type: 'break', min: S.gen.breakMin || 10 });
  structureChanged();
});

// Tournament form
const T_FIELDS = { tNameIn: 'name', tCurrency: 'currency', tBuyIn: 'buyIn', tStack: 'startStack', tEntries: 'entries', tPlayers: 'players', tRebuys: 'rebuys', tRebuyChips: 'rebuyChips', tAddons: 'addons', tAddonCost: 'addonCost', tAddonChips: 'addonChips' };
function syncTournamentForm() { for (const [id, k] of Object.entries(T_FIELDS)) $(id).value = S.tourney[k]; }
for (const [id, k] of Object.entries(T_FIELDS)) {
  $(id).addEventListener('input', () => {
    const v = $(id).value;
    S.tourney[k] = (k === 'name' || k === 'currency') ? v : Math.max(0, Number(v) || 0);
    save(); render();
  });
}

// Options form
const O_FIELDS = { oSound: 'sound', oWarn: 'warn', oCountdown: 'countdown', oVoice: 'voice', oVibrate: 'vibrate', oWake: 'wake' };
function syncOptionsForm() {
  for (const [id, k] of Object.entries(O_FIELDS)) $(id).checked = !!S.settings[k];
  $('oWarnSec').value = S.settings.warnSec;
}
for (const [id, k] of Object.entries(O_FIELDS)) {
  $(id).addEventListener('change', () => {
    S.settings[k] = $(id).checked; save();
    if (k === 'wake') S.settings.wake ? requestWake() : releaseWake();
    if (k === 'voice' && S.settings.voice) { unlockAudio(); speak('Voice announcements on.'); }
  });
}
$('oWarnSec').addEventListener('change', () => { S.settings.warnSec = Math.max(5, Number($('oWarnSec').value) || 60); save(); });
$('testSound').addEventListener('click', () => { unlockAudio(); alarm(); announce(false); });
$('resetClock').addEventListener('click', () => {
  if (!confirm('Restart the clock from level 1? Elapsed time resets too.')) return;
  releaseWake();
  S.run = freshRun(S.levels); save(); renderTable(); render();
});
$('resetAll').addEventListener('click', () => {
  if (!confirm('Reset structure, tournament info and options to defaults?')) return;
  releaseWake();
  S = defaultState(); save();
  syncGenForm(); syncTournamentForm(); syncOptionsForm(); renderTable(); render();
});

/* ---------- Boot ---------- */
render();
setInterval(tick, 200);
if (S.run.running) requestWake();
// iOS needs a user gesture before audio can play; unlock on first touch anywhere
document.addEventListener('pointerdown', unlockAudio, { once: true });

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
