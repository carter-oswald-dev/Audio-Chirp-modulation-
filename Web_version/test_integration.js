// Integration test: exercises the SAME encode/decode logic that lives in
// app.js (copied here since app.js expects a DOM), to catch bugs at the
// boundary between encoding and decoding before trusting it in a real browser
// (which isn't available in this sandbox to test directly).

const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync('./chirp-codec.js', 'utf8') + '\nthis.ChirpCodec = ChirpCodec;';
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const C = sandbox.ChirpCodec;

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; }
  else console.log('OK:', msg);
}

// ---- copied from app.js: buildMessageWaveform ----
function buildMessageWaveform(params) {
  const { message, bps, eccPct, useCrc, repeats } = params;
  const sr = C.SAMPLE_RATE;
  const symbolDurSec = C.bpsToSymbolDuration(bps);

  let symbols = C.textToSymbols(message);
  if (useCrc) {
    const bytes = C.textToBytes(message);
    const crc = C.crc32(bytes);
    symbols = symbols.concat(C.crc32ToSymbols(crc));
  }
  const repFactor = C.eccRepFactor(eccPct);
  symbols = C.applyRepetition(symbols, repFactor);

  const baseUp = C.makeRealUpChirp(symbolDurSec, sr);
  const baseDown = C.makeRealDownChirp(symbolDurSec, sr);
  const syncChirp = C.applyFade(baseDown, sr, 5);
  const guardN = Math.round(symbolDurSec * C.GUARD_FRACTION * sr);
  const syncGuardN = Math.round(symbolDurSec * C.SYNC_GUARD_FRACTION * sr);
  const guard = new Float64Array(guardN);
  const syncGuard = new Float64Array(syncGuardN);

  const repeatParts = [syncChirp, syncGuard];
  for (const s of symbols) {
    repeatParts.push(C.applyFade(C.cyclicShift(baseUp, s, C.N_SYMBOLS), sr, 5));
    repeatParts.push(guard);
  }
  const repeatLen = repeatParts.reduce((a, p) => a + p.length, 0);

  const totalLen = repeatLen * repeats;
  const full = new Float64Array(totalLen);
  const oneRepeat = new Float64Array(repeatLen);
  let ro = 0;
  for (const p of repeatParts) { oneRepeat.set(p, ro); ro += p.length; }
  let off = 0;
  for (let r = 0; r < repeats; r++) { full.set(oneRepeat, off); off += repeatLen; }
  for (let i = 0; i < full.length; i++) full[i] *= 0.85;
  return { waveform: full, sr, symbolCount: symbols.length };
}

// ---- copied from app.js: attemptDecode ----
function attemptDecode(data, sr, bps, repFactor, useCrc, expectedPayloadLen) {
  const symbolDurSec = C.bpsToSymbolDuration(bps);
  const baseUp = C.makeRealUpChirp(symbolDurSec, sr);
  const baseDown = C.makeRealDownChirp(symbolDurSec, sr);
  const refComplex = C.makeComplexUpChirp(symbolDurSec, sr);
  const { binToSymbol, nPow2 } = C.buildSymbolToBinTable(symbolDurSec, sr);
  const validBins = Object.keys(binToSymbol).map(Number).sort((a, b) => a - b);

  const symN = baseUp.length;
  const guardN = Math.round(symbolDurSec * C.GUARD_FRACTION * sr);
  const syncGuardN = Math.round(symbolDurSec * C.SYNC_GUARD_FRACTION * sr);
  const step = symN + guardN;

  const { positions, corr } = C.findSyncPositions(data, sr, baseDown, Math.max(symbolDurSec * 0.5, 0.01), 0.35);
  if (positions.length === 0) return { ok: false, reason: 'no-sync', positions, corr };

  let nSymsPerRepeat = expectedPayloadLen != null ? (expectedPayloadLen * repFactor) : null;

  let accumulated = null;
  let validRepeats = 0;
  for (let ri = 0; ri < positions.length; ri++) {
    const start = positions[ri] + symN + syncGuardN;
    let thisN = nSymsPerRepeat;
    if (thisN == null) {
      const available = (ri + 1 < positions.length) ? (positions[ri + 1] - start) : (data.length - start);
      thisN = Math.max(0, Math.floor(available / step));
    }
    if (accumulated === null) {
      accumulated = new Array(thisN);
      for (let k = 0; k < thisN; k++) accumulated[k] = null;
    }
    let ok = true;
    const perRepeatSpectra = [];
    for (let k = 0; k < thisN; k++) {
      const segStart = start + k * step;
      const segEnd = segStart + symN;
      if (segEnd > data.length) { ok = false; break; }
      const segment = data.subarray(segStart, segEnd);
      const demod = C.iqDemodulate(segment, refComplex);
      const re = new Float64Array(nPow2);
      const im = new Float64Array(nPow2);
      re.set(demod.re); im.set(demod.im);
      C.fft(re, im);
      const mags = new Float64Array(nPow2);
      for (let i = 0; i < nPow2; i++) mags[i] = re[i]*re[i] + im[i]*im[i];
      perRepeatSpectra.push(mags);
    }
    if (!ok) continue;
    validRepeats++;
    for (let k = 0; k < thisN; k++) {
      if (accumulated[k] === null) accumulated[k] = perRepeatSpectra[k].slice();
      else for (let i = 0; i < accumulated[k].length; i++) accumulated[k][i] += perRepeatSpectra[k][i];
    }
  }

  if (!accumulated || validRepeats === 0) return { ok: false, reason: 'no-complete-repeats', positions, corr };

  const rawSymbols = [];
  const confidences = [];
  for (const spectrum of accumulated) {
    if (!spectrum) continue;
    let bestVal = -1, bestBin = validBins[0];
    let sum = 0;
    for (const b of validBins) {
      sum += spectrum[b];
      if (spectrum[b] > bestVal) { bestVal = spectrum[b]; bestBin = b; }
    }
    const mean = sum / validBins.length;
    const confDb = 10 * Math.log10((bestVal + 1e-12) / (mean + 1e-12));
    rawSymbols.push(binToSymbol[bestBin]);
    confidences.push(confDb);
  }

  const { symbols: dataSymbols, confidences: dataConf } = C.undoRepetitionMajorityVote(rawSymbols, repFactor, confidences);

  let payloadSymbols = dataSymbols;
  let crcOk = null;
  if (useCrc && dataSymbols.length >= 7) {
    payloadSymbols = dataSymbols.slice(0, dataSymbols.length - 7);
    const crcSymbols = dataSymbols.slice(dataSymbols.length - 7);
    const receivedCrc = C.symbolsToCrc32(crcSymbols);
    const text = C.symbolsToText(payloadSymbols);
    const computedCrc = C.crc32(C.textToBytes(text));
    crcOk = (receivedCrc === computedCrc);
  }

  const text = C.symbolsToText(payloadSymbols);
  const avgConf = dataConf ? dataConf.reduce((a, b) => a + b, 0) / dataConf.length : 0;

  return { ok: true, text, avgConf, symbols: payloadSymbols, positions, corr, crcOk, validRepeats, totalRepeats: positions.length };
}

// ================= TESTS =================

// Test A: basic round trip, no CRC, no ECC, "known settings" mode
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: false, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = attemptDecode(waveform, sr, params.bps, 1, false, null);
  assert(result.ok && result.text === 'HELLOWORLD', `basic round trip: ${JSON.stringify(result.ok ? result.text : result.reason)}`);
}

// Test B: with CRC, no ECC
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: true, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = attemptDecode(waveform, sr, params.bps, 1, true, null);
  assert(result.ok && result.text === 'HELLOWORLD' && result.crcOk === true,
    `CRC round trip: ok=${result.ok} text=${result.text} crcOk=${result.crcOk}`);
}

// Test C: with ECC (50% -> 3x), no CRC
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 50, useCrc: false, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const repFactor = C.eccRepFactor(params.eccPct);
  const result = attemptDecode(waveform, sr, params.bps, repFactor, false, null);
  assert(result.ok && result.text === 'HELLOWORLD', `ECC round trip: ${JSON.stringify(result.ok ? result.text : result.reason)}`);
}

// Test D: CRC + ECC together
{
  const params = { message: 'HELLOWORLD', bps: 10, eccPct: 75, useCrc: true, repeats: 4 };
  const { waveform, sr } = buildMessageWaveform(params);
  const repFactor = C.eccRepFactor(params.eccPct);
  const result = attemptDecode(waveform, sr, params.bps, repFactor, true, null);
  assert(result.ok && result.text === 'HELLOWORLD' && result.crcOk === true,
    `CRC+ECC round trip @ 10bps: ok=${result.ok} text=${result.text} crcOk=${result.crcOk}`);
}

// Test E: high bps (300 - the fast end of the slider)
{
  const params = { message: 'HI', bps: 300, eccPct: 0, useCrc: true, repeats: 5 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = attemptDecode(waveform, sr, params.bps, 1, true, null);
  assert(result.ok && result.text === 'HI' && result.crcOk === true,
    `300bps round trip: ok=${result.ok} text=${result.text} crcOk=${result.crcOk}`);
}

// Test F: low bps (1 - the slow end of the slider)
{
  const params = { message: 'HI', bps: 1, eccPct: 0, useCrc: false, repeats: 2 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = attemptDecode(waveform, sr, params.bps, 1, false, null);
  assert(result.ok && result.text === 'HI', `1bps round trip: ok=${result.ok} text=${result.text}`);
}

// Test G: robustness with injected white noise at moderate SNR
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: true, repeats: 5 };
  const { waveform, sr } = buildMessageWaveform(params);
  const signalRms = Math.sqrt(waveform.reduce((a,b)=>a+b*b,0)/waveform.length);
  const targetSnrDb = -15;
  const noiseRms = signalRms / Math.pow(10, targetSnrDb/20);
  const noisy = new Float64Array(waveform.length);
  // simple gaussian-ish noise via sum of uniforms (Irwin-Hall approx)
  function gaussApprox() {
    let s = 0; for (let i=0;i<6;i++) s += Math.random();
    return (s - 3) / 3;
  }
  for (let i=0;i<waveform.length;i++) noisy[i] = waveform[i] + gaussApprox()*noiseRms;
  const result = attemptDecode(noisy, sr, params.bps, 1, true, null);
  assert(result.ok && result.text === 'HELLOWORLD',
    `noisy (-15dB SNR) round trip: ok=${result.ok} text=${result.ok?result.text:result.reason} crcOk=${result.crcOk}`);
}

// Test H: leading silence before message (arbitrary recording start offset)
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: false, repeats: 2 };
  const { waveform, sr } = buildMessageWaveform(params);
  const leadIn = new Float64Array(sr * 7); // 7s of silence
  const full = new Float64Array(leadIn.length + waveform.length);
  full.set(leadIn, 0);
  full.set(waveform, leadIn.length);
  const result = attemptDecode(full, sr, params.bps, 1, false, null);
  assert(result.ok && result.text === 'HELLOWORLD', `leading silence round trip: ok=${result.ok} text=${result.ok?result.text:result.reason}`);
}

console.log('\nDone.');

// ---- copied from app.js: auto-detect logic ----
function autoDetectDecode(data, sr) {
  const candidates = [5, 1, 2, 10, 20, 50, 100, 150, 300];
  let bestBps = null, bestScore = -1;
  for (let ci = 0; ci < candidates.length; ci++) {
    const bps = candidates[ci];
    const symbolDurSec = C.bpsToSymbolDuration(bps);
    const baseDown = C.makeRealDownChirp(symbolDurSec, sr);
    const { positions, corr } = C.findSyncPositions(data, sr, baseDown, Math.max(symbolDurSec * 0.5, 0.01), 0.4);
    if (positions.length >= 2) {
      let peak = 0;
      for (const p of positions) peak = Math.max(peak, corr[p] || 0);
      const sorted = Float64Array.from(corr).sort((a,b)=>a-b);
      const median = sorted[Math.floor(sorted.length / 2)] || 1;
      const score = peak / Math.max(median, 1e-6);
      if (score > bestScore) { bestScore = score; bestBps = bps; }
    }
  }
  if (bestBps == null) return { ok: false, reason: 'no-sync' };
  let found = null;
  for (const useCrc of [true, false]) {
    for (let rep = 1; rep <= 5; rep++) {
      const attempt = attemptDecode(data, sr, bestBps, rep, useCrc, null);
      if (attempt.ok && useCrc && attempt.crcOk) { found = attempt; break; }
      if (attempt.ok && !useCrc && !found) found = attempt;
    }
    if (found && found.crcOk) break;
  }
  return found || { ok: false, reason: 'no-complete-repeats', bestBps };
}

// Test I: auto-detect with default settings (5bps, no ecc, with crc) - the
// most common case a user would hit if they forget to note their settings.
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: true, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = autoDetectDecode(waveform, sr);
  assert(result.ok && result.text === 'HELLOWORLD' && result.crcOk === true,
    `auto-detect default settings: ok=${result.ok} text=${result.ok?result.text:result.reason} crcOk=${result.crcOk}`);
}

// Test J: auto-detect with a non-default rate + ECC
{
  const params = { message: 'HELLOWORLD', bps: 20, eccPct: 50, useCrc: true, repeats: 4 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = autoDetectDecode(waveform, sr);
  assert(result.ok && result.text === 'HELLOWORLD' && result.crcOk === true,
    `auto-detect 20bps+ecc50%: ok=${result.ok} text=${result.ok?result.text:result.reason} crcOk=${result.crcOk} bestBps=${result.bestBps}`);
}

// Test K: auto-detect with no CRC at all (should still fall back sanely)
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: false, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = autoDetectDecode(waveform, sr);
  assert(result.ok && result.text === 'HELLOWORLD',
    `auto-detect no-CRC fallback: ok=${result.ok} text=${result.ok?result.text:result.reason}`);
}

console.log('\nAuto-detect tests done.');
