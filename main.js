const $ = (id) => document.getElementById(id);
const MAX = 100000;
const VOICES = [
  { id: 'anna', n: 'Anna', d: 'női hang' },
  { id: 'imre', n: 'Imre', d: 'férfi hang' },
];
const I = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 20h14"/></svg>',
};
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

let voice = ls.get('voice') || 'anna'; if (!VOICES.find((v) => v.id === voice)) voice = 'anna';
let installed = [], busy = false, cur = null, peaks = [];
const hist = [];
const audio = new Audio();
const worker = new Worker('/tts.worker.js', { type: 'module' });

function toast(m, err) { const t = $('toast'); t.textContent = m; t.className = 'toast show' + (err ? ' err' : ''); clearTimeout(t._t); t._t = setTimeout(() => (t.className = 'toast'), err ? 6000 : 2600); }
function setStat(s, m) { $('dot').className = 'dot ' + s; $('stat').textContent = m; }
const fmt = (s) => { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const esc = (s) => s.replace(/[<&"]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '"': '&quot;' }[c]));

function renderVoices() {
  $('voices').innerHTML = VOICES.map((v) => `<button class="voice ${v.id === voice ? 'on' : ''}" data-v="${v.id}">
    <span class="tag ${installed.includes(v.id) ? 'ok' : ''}">${installed.includes(v.id) ? '● letöltve' : '63 MB'}</span>
    <div class="av">${v.n[0]}</div><div class="n">${v.n}</div><div class="d">${v.d}</div></button>`).join('');
  document.querySelectorAll('.voice').forEach((b) => (b.onclick = () => { voice = b.dataset.v; ls.set('voice', voice); renderVoices(); }));
}

// ---------- szöveg ----------
const txt = $('txt');
txt.value = ls.get('draft') || '';
function counts() {
  const n = txt.value.length, w = (txt.value.trim().match(/\S+/g) || []).length;
  $('cnt').textContent = n.toLocaleString('hu-HU') + ' / 100 000';
  $('cnt').classList.toggle('full', n >= MAX);
  $('est').textContent = w ? '≈ ' + fmt(w / 2.2 / +$('tp').value) + ' hanganyag' : '';
}
txt.addEventListener('input', () => { counts(); ls.set('draft', txt.value); });
$('clr').onclick = () => { txt.value = ''; ls.set('draft', ''); counts(); txt.focus(); };
$('paste').onclick = async () => {
  try { txt.value = (txt.value + (await navigator.clipboard.readText())).slice(0, MAX); counts(); ls.set('draft', txt.value); }
  catch { toast('A vágólap nem olvasható – használd a Ctrl+V-t'); }
};
// ---------- szövegfájl betöltése (gomb + ráhúzás) ----------
async function loadFile(file) {
  if (!file) return;
  if (!/\.(txt|md|text|srt|csv)$/i.test(file.name) && !file.type.startsWith('text/')) return toast('Csak szöveges fájl (.txt, .md) tölthető be.', true);
  const buf = await file.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(buf);
  if (t.includes('\uFFFD')) t = new TextDecoder('windows-1250').decode(buf);   // régi magyar Windows-kódolás
  t = t.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (t.length > MAX) toast(`A fájl ${t.length.toLocaleString('hu-HU')} karakteres – az első 100 000 karakter került be.`, true);
  txt.value = t.slice(0, MAX); counts(); ls.set('draft', txt.value);
  if (t.length <= MAX) toast(`Betöltve: ${file.name}`);
}
$('open').onclick = () => $('file').click();
$('file').onchange = (e) => { loadFile(e.target.files[0]); e.target.value = ''; };
const ed = document.querySelector('.editor');
['dragenter', 'dragover'].forEach((ev) => ed.addEventListener(ev, (e) => { e.preventDefault(); ed.classList.add('drop'); }));
['dragleave', 'drop'].forEach((ev) => ed.addEventListener(ev, (e) => { e.preventDefault(); ed.classList.remove('drop'); }));
ed.addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));

function rng(el, out, f, cb) {
  const u = () => { el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min)) * 100 + '%'); $(out).textContent = f(+el.value); cb && cb(); };
  el.addEventListener('input', u); u();
}
rng($('tp'), 'tpv', (v) => v.toFixed(2) + '×', counts);
let volT;
rng($('vl'), 'vlv', (v) => v + '%', () => { clearTimeout(volT); volT = setTimeout(applyVolume, 120); });

// ---------- WAV ----------
function toWav(pcm, sr, gain) {
  const n = pcm.length, h = new DataView(new ArrayBuffer(44));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) h.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); h.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); h.setUint32(16, 16, true);
  h.setUint16(20, 1, true); h.setUint16(22, 1, true); h.setUint32(24, sr, true); h.setUint32(28, sr * 2, true);
  h.setUint16(32, 2, true); h.setUint16(34, 16, true); w(36, 'data'); h.setUint32(40, n * 2, true);
  if (Math.abs(gain - 1) < 0.001) return new Blob([h.buffer, pcm], { type: 'audio/wav' });
  const d = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = (pcm[i] / 32767) * gain;
    if (s > 0.95) s = 0.95 + 0.05 * Math.tanh((s - 0.95) / 0.05); else if (s < -0.95) s = -0.95 + 0.05 * Math.tanh((s + 0.95) / 0.05);
    d[i] = s * 32767;
  }
  return new Blob([h.buffer, d], { type: 'audio/wav' });
}
function computePeaks(pcm) {
  const N = 180, step = Math.max(1, Math.floor(pcm.length / N)), p = [];
  for (let i = 0; i < N; i++) { let m = 0; for (let j = i * step; j < (i + 1) * step && j < pcm.length; j += 16) m = Math.max(m, Math.abs(pcm[j])); p.push(m); }
  const mx = Math.max(...p, 0.01); return p.map((x) => x / mx);
}
function fname(text, v) {
  const s = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s-]/g, '').trim().split(/\s+/).slice(0, 6).join('_').toLowerCase() || 'felolvasas';
  return `${s}_${v}.wav`;
}
function setClip(c, play) {
  cur = c; peaks = c.peaks;
  if (c.url) URL.revokeObjectURL(c.url);
  c.url = URL.createObjectURL(toWav(c.pcm, c.sr, +$('vl').value / 100));
  audio.src = c.url; $('dl').href = c.url; $('dl').download = c.name;
  $('dur').textContent = fmt(c.dur); $('player').classList.add('show'); draw();
  if (play) audio.play();
}
function applyVolume() {
  if (!cur) return;
  const t = audio.currentTime, wasPlaying = !audio.paused;
  setClip(cur, false);
  audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; if (wasPlaying) audio.play(); }, { once: true });
}

// ---------- worker ----------
let pending = null;
worker.onmessage = ({ data: m }) => {
  if (m.type === 'stored') { installed = m.voices; renderVoices(); setStat('ok', 'Kész'); }
  if (m.type === 'download') {
    const pct = Math.round((m.loaded / m.total) * 100);
    $('goT').textContent = `Hang letöltése – ${pct}% (csak egyszer)`; $('bar').style.width = pct + '%';
  }
  if (m.type === 'progress') {
    $('goT').textContent = m.total > 1 ? `Generálás… ${m.done} / ${m.total}` : 'Generálás…';
    $('bar').style.width = (m.done / m.total) * 100 + '%';
  }
  if (m.type === 'done') pending && pending.res(m);
  if (m.type === 'error') pending && pending.rej(new Error(m.message));
};
worker.onerror = (e) => { pending && pending.rej(new Error(e.message || 'Worker hiba')); };

async function generate() {
  const text = txt.value.trim();
  if (!text) return toast('Előbb írj be szöveget.');
  if (busy) return;
  busy = true; $('go').disabled = true; $('go').classList.add('busy'); $('bar').style.width = '0';
  setStat('busy', 'Dolgozik…'); $('goT').textContent = 'Előkészítés…';
  const t0 = performance.now();
  try {
    const r = await new Promise((res, rej) => { pending = { res, rej }; worker.postMessage({ cmd: 'synth', text, voice, tempo: +$('tp').value }); });
    const c = { pcm: r.pcm, sr: r.sr, dur: r.pcm.length / r.sr, text, v: voice, name: fname(text, voice), peaks: computePeaks(r.pcm) };
    hist.unshift(c); renderHist(); setClip(c, true);
    if (!installed.includes(voice)) { installed.push(voice); renderVoices(); }
    setStat('ok', `Kész · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) { toast('Hiba: ' + e.message, true); setStat('err', 'Hiba történt'); }
  finally { pending = null; busy = false; $('go').disabled = false; $('go').classList.remove('busy'); $('goT').textContent = 'Felolvasás'; $('bar').style.width = '0'; }
}
$('go').onclick = generate;
addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); generate(); }
  if (e.code === 'Space' && document.activeElement !== txt && cur && !e.target.matches('button,input')) { e.preventDefault(); toggle(); }
});

// ---------- lejátszó ----------
function draw() {
  const c = $('cv'), dpr = devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const N = peaks.length, bw = w / N, prog = audio.duration ? audio.currentTime / audio.duration : 0;
  const grad = g.createLinearGradient(0, 0, w, 0); grad.addColorStop(0, '#2f8fff'); grad.addColorStop(1, '#57c7ff');
  for (let i = 0; i < N; i++) {
    const bh = Math.max(3, peaks[i] * (h - 8)), on = i / N < prog;
    g.fillStyle = on ? grad : 'rgba(140,190,240,.16)';
    g.shadowColor = on ? 'rgba(87,199,255,.85)' : 'transparent'; g.shadowBlur = on ? 8 : 0;
    g.beginPath(); g.roundRect(i * bw + bw * 0.22, (h - bh) / 2, bw * 0.56, bh, 2); g.fill();
  }
  $('cur').textContent = fmt(audio.currentTime);
}
function toggle() { audio.paused ? audio.play() : audio.pause(); }
$('pp').onclick = toggle;
audio.onplay = audio.onpause = audio.onended = () => { $('pp').innerHTML = audio.paused ? I.play : I.pause; draw(); };
$('pp').innerHTML = I.play;
(function loop() { if (!audio.paused) draw(); requestAnimationFrame(loop); })();
$('cv').onclick = (e) => { if (!audio.duration) return; const r = e.target.getBoundingClientRect(); audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; draw(); };
addEventListener('resize', () => peaks.length && draw());

function renderHist() {
  $('hist').hidden = !hist.length;
  $('hl').innerHTML = hist.map((h, i) => `<div class="item"><button class="ib" data-i="${i}" title="Lejátszás">${I.play}</button>
    <div class="t">${esc(h.text)}</div><div class="m">${VOICES.find((v) => v.id === h.v).n} · ${fmt(h.dur)}</div>
    <button class="ib" data-d="${i}" title="Letöltés">${I.dl}</button></div>`).join('');
  document.querySelectorAll('#hl [data-i]').forEach((b) => (b.onclick = () => setClip(hist[+b.dataset.i], true)));
  document.querySelectorAll('#hl [data-d]').forEach((b) => (b.onclick = () => {
    const h = hist[+b.dataset.d], a = document.createElement('a');
    a.href = URL.createObjectURL(toWav(h.pcm, h.sr, +$('vl').value / 100)); a.download = h.name; a.click();
  }));
}

renderVoices(); counts();
worker.postMessage({ cmd: 'stored' });
