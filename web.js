// Mix Auto, version web : remplace le serveur local (server.py + mixauto.py) par du calcul dans le navigateur.
// Morceaux et projets restent dans ce navigateur (IndexedDB), rien n'est envoyé.
// ponytail: le tempo est calé par la vitesse de lecture (pas de rubberband) : la tonalité bouge un peu (~0,17 demi-ton par %),
// et la transposition ±½ ton n'existe pas ici. Pour mieux : un étirement WSOLA en Worker.
(() => {
window.WEB = true;
const SR = 44100, ASR = 22050, MAX_STRETCH = 0.06, KICK_LEAD = 0.028;

// ---------- Stockage (IndexedDB) ----------
const dbp = new Promise((ok, ko) => {
  const r = indexedDB.open('mixauto', 1);
  r.onupgradeneeded = () => ['files', 'lib', 'proj'].forEach(s => r.result.createObjectStore(s));
  r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error);
});
const idb = async (store, mode, f) => {
  const db = await dbp;
  return new Promise((ok, ko) => { const tx = db.transaction(store, mode), q = f(tx.objectStore(store)); tx.oncomplete = () => ok(q.result); tx.onerror = () => ko(tx.error); });
};
const get = (s, k) => idb(s, 'readonly', o => o.get(k));
const put = (s, k, v) => idb(s, 'readwrite', o => o.put(v, k));
const del = (s, k) => idb(s, 'readwrite', o => o.delete(k));
const all = s => idb(s, 'readonly', o => o.getAll());

// ---------- Filtres à phase nulle (aller-retour) : l'enveloppe du kick ne prend aucun retard ----------
function biquad(type, f, q, sr) {
  const w = 2 * Math.PI * f / sr, a = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + a;
  const b = type === 'bp' ? [a, 0, -a] : [(1 - c) / 2, 1 - c, (1 - c) / 2];
  return [b[0] / a0, b[1] / a0, b[2] / a0, -2 * c / a0, (1 - a) / a0];
}
function filt(x, [b0, b1, b2, a1, a2]) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = v; y2 = y1; y1 = y; x[i] = y; }
}
function filtfilt(x, co) { const y = Float32Array.from(x); filt(y, co); y.reverse(); filt(y, co); return y.reverse(); }
function kickEnv(x, sr) {   // attaques du kick (40-90 Hz) : bande passante, redressée, lissée
  const e = filtfilt(x, biquad('bp', 60, 1.2, sr));
  for (let i = 0; i < e.length; i++) e[i] = Math.abs(e[i]);
  return filtfilt(e, biquad('lp', 40, 0.707, sr));
}

// ---------- Analyse (comme mixauto.analyze) ----------
async function decodeMono(blob, sr) {
  const b = await new OfflineAudioContext(1, 1, sr).decodeAudioData(await blob.arrayBuffer());
  const x = new Float32Array(b.length), n = b.numberOfChannels;
  for (let c = 0; c < n; c++) { const d = b.getChannelData(c); for (let i = 0; i < x.length; i++) x[i] += d[i] / n; }
  return x;
}
function kickGrid(on, hop, lo, hi) {   // tempo au 1/100 et premier temps : les attaques repliées sur un temps s'empilent au bon tempo
  const NB = 48, idx = [], m = on.reduce((a, v) => a + v, 0) / on.length;
  for (let i = 0; i < on.length; i++) if (on[i] > m) idx.push(i);
  const fold = (b, w = on, from = 0, to = Infinity) => {
    const beat = 60 / b, h = new Float64Array(NB);
    for (const i of idx) { const t = i * hop / ASR; if (t < from || t >= to) continue; h[Math.floor(t % beat / beat * NB)] += w[i]; }
    return h;
  };
  const sharp = b => { const h = fold(b); let mx = 0, s = 0; for (const v of h) { mx = Math.max(mx, v); s += v; } return mx / (s / NB + 1e-12); };
  let bpm = lo, best = 0;
  for (let b = lo; b < hi; b += 0.05) { const s = sharp(b); if (s > best) { best = s; bpm = b; } }
  for (let b = bpm - 0.06; b <= bpm + 0.06; b += 0.01) { const s = sharp(b); if (s > best) { best = s; bpm = b; } }
  if (bpm / 2 >= lo && sharp(bpm / 2) >= 0.9 * best) bpm /= 2;   // double tempo (même pic) : on garde le plus lent
  for (const c of [Math.round(bpm), Math.round(bpm * 2) / 2]) if (c >= lo && c <= hi && sharp(c) >= 0.85 * best) { bpm = c; break; }   // tempos ronds
  const on2 = on.map(v => v * v), H = new Float64Array(NB), end = on.length * hop / ASR;
  for (let w = 0; w < end; w += 15) {   // premier temps : passages où le kick est seul et net
    const h = fold(bpm, on2, w, w + 15); let s = 0, mx = 0; for (const v of h) { s += v; mx = Math.max(mx, v); }
    if (s > 0) { const k = (mx / (s / NB)) ** 2; for (let i = 0; i < NB; i++) H[i] += h[i] / s * k; }
  }
  let k = H.indexOf(Math.max(...H));
  const a = H[(k + NB - 1) % NB], b = H[k], c = H[(k + 1) % NB];
  if (a - 2 * b + c) k += 0.5 * (a - c) / (a - 2 * b + c);
  const beat = 60 / bpm;   // KICK_LEAD : le haut de l'enveloppe tombe après le début audible du kick (mesuré sur 3 morceaux : +18 à +40 ms)
  return { bpm: Math.round(bpm * 1000) / 1000, first_beat: (((k + 0.5) / NB * beat - KICK_LEAD) % beat + beat) % beat, tempo_mag: best };
}
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const p = i + k, q = p + h, vr = re[q] * cr - im[q] * ci, vi = re[q] * ci + im[q] * cr;
        re[q] = re[p] - vr; im[q] = im[p] - vi; re[p] += vr; im[p] += vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const camelot = (pc, minor) => `${(((minor ? pc + 3 : pc) * 7) % 12 + 7) % 12 + 1}${minor ? 'A' : 'B'}`;
function keyOf(x) {   // chroma (55 Hz - 2 kHz), mêmes trames que mixauto.analyze (2048 / 512), profils de Krumhansl
  const N = 2048, ch = new Float64Array(12), re = new Float64Array(N), im = new Float64Array(N);
  for (let s = 0; s + N <= x.length; s += 512) {
    for (let i = 0; i < N; i++) { re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))); im[i] = 0; }
    fft(re, im);
    for (let k = Math.ceil(55 * N / ASR); k < 2000 * N / ASR; k++) ch[((Math.round(12 * Math.log2(k * ASR / N / 440)) + 9) % 12 + 12) % 12] += Math.hypot(re[k], im[k]);
  }
  const corr = (a, b) => { const ma = a.reduce((s, v) => s + v) / 12, mb = b.reduce((s, v) => s + v) / 12; let n = 0, da = 0, db = 0; for (let i = 0; i < 12; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return n / Math.sqrt(da * db); };
  let best = [-2];
  for (const [minor, prof] of [[false, MAJOR], [true, MINOR]]) for (let k = 0; k < 12; k++) {
    const r = corr(prof.map((_, i) => prof[((i - k) % 12 + 12) % 12]), ch); if (r > best[0]) best = [r, k, minor];
  }
  return { key: NOTES[best[1]] + (best[2] ? 'm' : ''), camelot: camelot(best[1], best[2]) };
}
function analyzeX(x, lo = 88, hi = 176) {
  const hop = 128, e = kickEnv(x, ASR), n = Math.floor(e.length / hop), on = new Float32Array(n);
  for (let i = 1; i < n; i++) on[i] = Math.max(0, e[i * hop] - e[(i - 1) * hop]);
  const g = kickGrid(on, hop, lo, hi);
  const lp = filtfilt(x, biquad('lp', 150, 0.707, ASR)), bs = 60 / g.bpm, bass = [];   // niveau des basses à chaque temps (fondu intelligent)
  for (let t = g.first_beat; (t + bs) * ASR < x.length; t += bs) {
    let s = 0; const a = Math.round(t * ASR), z = Math.round((t + bs) * ASR); for (let i = a; i < z; i++) s += lp[i] * lp[i];
    bass.push(Math.round(10 * Math.log10(s / (z - a) + 1e-12)));
  }
  let rms = 0; for (const v of x) rms += v * v;
  return { ...g, first_beat: Math.round(g.first_beat * 1e4) / 1e4, duration: x.length / ASR, ...keyOf(x),
    rms_db: 20 * Math.log10(Math.sqrt(rms / x.length) + 1e-9), punch: on.reduce((a, v) => a + v, 0) / n * 1e3, phrase: 0, bass };
}
async function importTrack(blob, name, near, folder, id) {   // comme import_track dans server.py
  const x = await decodeMono(blob, ASR);
  let info = analyzeX(x);
  if (near) {
    let b = [0.5, 1, 2].map(k => info.bpm * k).reduce((p, c) => Math.abs(c - near) < Math.abs(p - near) ? c : p);
    if (Math.abs(b / near - 1) > MAX_STRETCH) {   // souvent une erreur x3/4 ou x5/4 : on cherche près du tempo du projet
      const r = analyzeX(x, near * (1 - MAX_STRETCH), near * (1 + MAX_STRETCH));
      if (r.tempo_mag > 0.8 * info.tempo_mag) { info = r; b = r.bpm; }
    }
    info.bpm = Math.round(b * 1000) / 1000;
  }
  Object.assign(info, { id, name: name.replace(/\.[^.]+$/, ''), file: name, folder: folder || 'Morceaux importés' });
  await put('lib', id, info);
  return info;
}

// ---------- Calage au tempo (vitesse de lecture), une rampe = un changement de vitesse par temps ----------
const OUT = new Map();   // jeton -> AudioBuffer rendu (remis à la page sans passer par un fichier)
let queue = Promise.resolve();
const oneAtATime = f => (queue = queue.then(f, f));   // un rendu à la fois : chaque morceau décodé pèse ~130 Mo
async function render(q) {
  const t = await get('lib', q.id), blob = await get('files', q.id), bpm = +q.bpm;
  const src = await new OfflineAudioContext(2, 1, SR).decodeAudioData(await blob.arrayBuffer());
  const rates = [];   // [temps du fichier rendu (s), vitesse]
  let len;
  if (q.ramp) {   // même découpage que makeMap dans index.html
    const pts = q.ramp.split(',').map(p => p.split(':').map(Number)), sb = 60 / bpm, fb = +q.fb;
    const j0 = -Math.ceil(fb / sb), n = Math.ceil((src.duration - fb) / sb) + 2 - j0, T = j => tempoOfBeat(pts, j + 0.5);
    let O = (fb + j0 * sb) * bpm / T(j0);
    rates.push([0, T(j0) / bpm]);
    for (let i = 0; i < n; i++) { O += 60 / T(j0 + i); rates.push([O, T(j0 + i + 1) / bpm]); }
    len = O;
  } else { rates.push([0, +q.tempo / bpm]); len = src.duration * bpm / +q.tempo; }
  const ac = new OfflineAudioContext(2, Math.ceil(Math.min(len, src.duration * 1.2) * SR), SR), s = ac.createBufferSource();
  s.buffer = src; rates.forEach(([at, r]) => s.playbackRate.setValueAtTime(r, Math.max(0, at)));
  s.connect(ac.destination); s.start(0);
  return ac.startRendering();
}
const AC = window.AudioContext || window.webkitAudioContext, decode = AC.prototype.decodeAudioData;
AC.prototype.decodeAudioData = function (ab, ...rest) {
  if (ab.byteLength < 64) {
    const s = new TextDecoder().decode(ab);
    if (s.startsWith('MIXWEB:')) { const b = OUT.get(s.slice(7)); OUT.delete(s.slice(7)); return Promise.resolve(b); }
  }
  return decode.call(this, ab, ...rest);
};
function profiles(buf, beats, seg, nb = 500) {   // comme beat_profiles : attaques du kick repliées sur les temps donnés
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const a = Math.floor(beats[0] * SR), z = Math.min(L.length, Math.ceil(beats.at(-1) * SR) + 1);
  const x = new Float32Array(z - a); for (let i = 0; i < x.length; i++) x[i] = (L[a + i] + R[a + i]) / 2;
  const e = kickEnv(x, SR), ng = seg ? Math.floor((beats.length - 1) / seg) + 1 : 1, h = Array.from({ length: ng }, () => new Float64Array(nb));
  let j = 0;
  for (let i = 1; i < x.length; i++) {
    const s = (a + i) / SR; if (s >= beats.at(-1)) break;
    while (beats[j + 1] <= s) j++;
    const fb = j + (s - beats[j]) / (beats[j + 1] - beats[j]), on = Math.max(0, e[i] - e[i - 1]);
    h[seg ? Math.floor(fb / seg) : 0][Math.floor(fb % 1 * nb)] += on;
  }
  return h.map(r => { const m = Math.max(...r, 1e-12); return Array.from(r, v => Math.round(v / m * 1e4) / 1e4); });
}

// ---------- Ordre auto (comme mixauto.order) ----------
const camDist = (a, b) => { const na = parseInt(a), nb = parseInt(b), d = Math.min(Math.abs(na - nb), 12 - Math.abs(na - nb)); return d + (a.slice(-1) !== b.slice(-1)); };
function order(tracks) {
  const n = tracks.length;
  tracks.forEach(t => t.energy = 0);
  for (const k of ['rms_db', 'punch']) [...tracks].sort((a, b) => a[k] - b[k]).forEach((t, r) => t.energy += r / Math.max(n - 1, 1) / 2);
  const target = i => { const x = i / Math.max(n - 1, 1); return x < 0.75 ? 0.1 + 0.9 * x / 0.75 : 1 - 0.6 * (x - 0.75) / 0.25; };
  const left = [...tracks], pick = f => { const t = left.reduce((p, c) => f(c) < f(p) ? c : p); left.splice(left.indexOf(t), 1); return t; };
  const out = [pick(t => Math.abs(t.energy - target(0)))];
  while (left.length) { const p = out.at(-1), i = out.length; out.push(pick(t => 2 * Math.abs(t.energy - target(i)) + 0.5 * Math.min(camDist(p.camelot, t.camelot), 3) + 0.1 * Math.abs(t.bpm - p.bpm))); }
  return out;
}

// ---------- Export MP3 (lamejs) ----------
const CHUNKS = new Map(), MIXES = new Map();
const loadLame = () => window.lamejs ? Promise.resolve() : new Promise((ok, ko) => {
  const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js'; s.onload = ok; s.onerror = () => ko(new Error('encodeur MP3 introuvable (connexion ?)'));
  document.head.append(s);
});
async function toMp3(parts) {
  await loadLame();
  const enc = new lamejs.Mp3Encoder(2, SR, 320), out = [], B = 1152;
  for (const p of parts) {
    const n = p.length / 2, l = new Int16Array(n), r = new Int16Array(n);
    for (let i = 0; i < n; i++) { l[i] = p[2 * i]; r[i] = p[2 * i + 1]; }
    for (let i = 0; i < n; i += B) { const m = enc.encodeBuffer(l.subarray(i, i + B), r.subarray(i, i + B)); if (m.length) out.push(m); }
    await new Promise(res => setTimeout(res));   // la page reste vivante pendant l'encodage
  }
  out.push(enc.flush());
  return new Blob(out, { type: 'audio/mpeg' });
}
const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 60000); };

// ---------- Les adresses /api/… du serveur, servies ici ----------
const J = (o, code = 200) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json' } });
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
async function route(p, q, raw, body) {
  switch (p) {
    case '/api/library': return J(await all('lib'));
    case '/api/import': { const id = newId(); await put('files', id, body); return J(await importTrack(body, q.name || 'morceau', +q.near || 0, q.folder, id)); }
    case '/api/reanalyze': { const old = await get('lib', q.id); return J(await importTrack(await get('files', q.id), old.file || old.name, +q.near, old.folder, q.id)); }
    case '/api/delete': await del('files', q.id); await del('lib', q.id); return J({ ok: true });
    case '/api/audio': {
      const b = await oneAtATime(() => render(q)), tok = newId(); OUT.set(tok, b);
      return new Response(`MIXWEB:${tok}`);
    }
    case '/api/kick': {
      const key = raw.split('&seg=')[0], hit = Object.values(BUF).find(v => v.key === key && v.buffer);
      const buf = hit ? hit.buffer : await oneAtATime(() => render(q));
      return J({ profs: profiles(buf, q.beats.split(',').map(Number), +q.seg || 0) });
    }
    case '/api/order': { const t = JSON.parse(body); return J(order(t).map(x => x.id)); }
    case '/api/projects': return J((await all('proj')).sort((a, b) => b.t - a.t).map(x => x.name));
    case '/api/project':
      if (body != null) { await put('proj', q.name, { name: q.name, data: body, t: Date.now() }); return J({ ok: true }); }
      { const r = await get('proj', q.name); return r ? new Response(r.data, { headers: { 'Content-Type': 'application/json' } }) : J({ error: 'introuvable' }, 404); }
    case '/api/export/chunk': { if (q.i === '0') CHUNKS.set(q.id, []); CHUNKS.get(q.id).push(new Int16Array(body)); return J({ ok: true }); }
    case '/api/export/finish': {
      const blob = await toMp3(CHUNKS.get(q.id)), name = `${q.name}.mp3`; CHUNKS.delete(q.id);
      MIXES.set(name, blob); download(blob, name); return J({ mp3: name });
    }
    case '/api/reveal': { const b = MIXES.get(q.name); if (b) download(b, q.name); return J({ ok: true }); }
  }
  return J({ error: 'introuvable' }, 404);
}
const orig = window.fetch.bind(window);
window.fetch = async (url, opt = {}) => {
  const u = new URL(url, location.href), i = u.pathname.indexOf('/api/');
  if (i < 0) return orig(url, opt);
  try { return await route(u.pathname.slice(i), Object.fromEntries(u.searchParams), u.search.slice(1), opt.body); }
  catch (e) { console.error(e); return J({ error: e.message }, 500); }
};
window.webFileURL = async id => URL.createObjectURL(await get('files', id));   // pré-écoute
// le navigateur peut vider ce stockage s'il manque de place : on lui demande de le garder
navigator.storage?.persist?.();
})();
