const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/';
const PIPER = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/';
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/esm/ort.wasm.min.js';
import { createPiperPhonemize } from 'https://cdn.jsdelivr.net/npm/@diffusionstudio/vits-web@1.0.3/dist/piper-DeOu3H9E.js';

const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/hu/hu_HU';
const VOICES = { anna: 'anna/medium/hu_HU-anna-medium', imre: 'imre/medium/hu_HU-imre-medium' };

ort.env.wasm.wasmPaths = ORT;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

const post = (m) => self.postMessage(m);
let phWasm, phData;               // cached phonemizer binaries
const sessions = {};              // voice -> {session, cfg}

// ---------- OPFS cache ----------
async function dir() { return (await navigator.storage.getDirectory()).getDirectoryHandle('piper', { create: true }); }
async function cacheGet(name) { try { return await (await (await dir()).getFileHandle(name)).getFile(); } catch { return null; } }
async function cachePut(name, blob) {
  try { const w = await (await (await dir()).getFileHandle(name, { create: true })).createWritable(); await w.write(blob); await w.close(); } catch (e) { console.warn(e); }
}
async function stored() {
  const out = [];
  for (const v of Object.keys(VOICES)) if (await cacheGet(VOICES[v].split('/').pop() + '.onnx')) out.push(v);
  return out;
}
async function fetchCached(url, onProg) {
  const name = url.split('/').pop();
  const hit = await cacheGet(name); if (hit) return hit;
  const r = await fetch(url); if (!r.ok) throw new Error('Letöltési hiba: ' + r.status);
  const total = +r.headers.get('Content-Length') || 0, rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onProg && onProg(got, total); }
  const blob = new Blob(parts); await cachePut(name, blob); return blob;
}

async function loadVoice(v) {
  if (sessions[v]) return sessions[v];
  const base = `${HF}/${VOICES[v]}.onnx`;
  const cfg = JSON.parse(await (await fetchCached(base + '.json')).text());
  const model = await fetchCached(base, (g, t) => post({ type: 'download', loaded: g, total: t || 63201294 }));
  const session = await ort.InferenceSession.create(await model.arrayBuffer(), { executionProviders: ['wasm'] });
  return (sessions[v] = { session, cfg });
}

async function phonemize(text, espeakVoice) {
  phWasm ??= await (await fetch(PIPER + 'piper_phonemize.wasm')).arrayBuffer();
  phData ??= await (await fetch(PIPER + 'piper_phonemize.data')).arrayBuffer();
  return new Promise(async (res, rej) => {
    const mod = await createPiperPhonemize({
      wasmBinary: phWasm,
      getPreloadedPackage: () => phData,
      locateFile: (f) => PIPER + f,
      print: (l) => { try { res(JSON.parse(l).phoneme_ids); } catch (e) { rej(e); } },
      printErr: (l) => console.warn(l),
    });
    mod.callMain(['-l', espeakVoice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  });
}

// mondatokra bontás, majd max ~350 karakteres csomagok
function chunks(text) {
  const out = [];
  for (const para of text.split(/\n\s*\n|\r?\n/)) {
    const p = para.trim(); if (!p) continue;
    const sents = p.match(/[^.!?…]+[.!?…]+["”»)\]]*\s*|[^.!?…]+$/g) || [p];
    let buf = '';
    for (const s of sents) {
      if ((buf + s).length > 350 && buf) { out.push({ t: buf.trim(), pause: 0.18 }); buf = ''; }
      buf += s;
    }
    if (buf.trim()) out.push({ t: buf.trim(), pause: 0.45 });
  }
  return out;
}

async function synth({ text, voice, tempo }) {
  const { session, cfg } = await loadVoice(voice);
  const sr = cfg.audio.sample_rate, inf = cfg.inference;
  const scales = new ort.Tensor('float32', [inf.noise_scale, inf.length_scale / tempo, inf.noise_w]);
  const parts = chunks(text), out = []; let len = 0, gain = 0;
  for (let i = 0; i < parts.length; i++) {
    post({ type: 'progress', done: i, total: parts.length });
    const ids = await phonemize(parts[i].t, cfg.espeak.voice);
    const feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales,
    };
    const f = (await session.run(feeds)).output.data;
    if (!gain) { let pk = 0; for (let j = 0; j < f.length; j++) pk = Math.max(pk, Math.abs(f[j])); gain = pk > 0.01 ? Math.min(4, 0.85 / pk) : 1; }
    // azonnal 16 bites mintákká alakítjuk (fele annyi memória), lágy limiterrel
    const pad = Math.round(sr * parts[i].pause), a = new Int16Array(f.length + pad);
    for (let j = 0; j < f.length; j++) {
      let s = f[j] * gain;
      if (s > 0.95) s = 0.95 + 0.05 * Math.tanh((s - 0.95) / 0.05); else if (s < -0.95) s = -0.95 + 0.05 * Math.tanh((s + 0.95) / 0.05);
      a[j] = s * 32767;
    }
    out.push(a); len += a.length;
  }
  const pcm = new Int16Array(len); let o = 0; for (const a of out) { pcm.set(a, o); o += a.length; }
  post({ type: 'progress', done: parts.length, total: parts.length });
  return { pcm, sr };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.cmd === 'stored') post({ type: 'stored', voices: await stored() });
    if (data.cmd === 'synth') { const r = await synth(data); self.postMessage({ type: 'done', ...r }, [r.pcm.buffer]); }
  } catch (e) { post({ type: 'error', message: e.message || String(e) }); }
};
