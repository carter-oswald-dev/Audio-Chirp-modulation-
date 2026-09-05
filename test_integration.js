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

// ---- copied from app.js: buildMessageWaveform (now includes header) ----
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

  // Header: fixed 5bps, sent once at the very start
  const headerDurSec = C.bpsToSymbolDuration(C.HEADER_BPS);
  const headerBaseUp = C.makeRealUpChirp(headerDurSec, sr);
  const headerBaseDown = C.makeRealDownChirp(headerDurSec, sr);
  const headerSyncChirp = C.applyFade(headerBaseDown, sr, 5);
  const headerGuardN = Math.round(headerDurSec * C.GUARD_FRACTION * sr);
  const headerSyncGuardN = Math.round(headerDurSec * C.SYNC_GUARD_FRACTION * sr);
  const headerGuard = new Float64Array(headerGuardN);
  const headerSyncGuard = new Float64Array(headerSyncGuardN);
  const headerSymbols = C.headerToSymbols(bps, eccPct, useCrc, repeats);
  const headerParts = [headerSyncChirp, headerSyncGuard];
  for (const s of headerSymbols) {
    headerParts.push(C.applyFade(C.cyclicShift(headerBaseUp, s, C.N_SYMBOLS), sr, 5));
    headerParts.push(headerGuard);
  }
  const headerLen = headerParts.reduce((a, p) => a + p.length, 0);

  const totalLen = headerLen + repeatLen * repeats;
  const full = new Float64Array(totalLen);
  let off = 0;
  for (const p of headerParts) { full.set(p, off); off += p.length; }
  const oneRepeat = new Float64Array(repeatLen);
  let ro = 0;
  for (const p of repeatParts) { oneRepeat.set(p, ro); ro += p.length; }
  for (let r = 0; r < repeats; r++) { full.set(oneRepeat, off); off += repeatLen; }
  for (let i = 0; i < full.length; i++) full[i] *= 0.85;
  return { waveform: full, sr, symbolCount: symbols.length, headerLen };
}

// ---- copied from app.js: decodeHeader ----
function decodeHeader(data, sr) {
  const symbolDurSec = C.bpsToSymbolDuration(C.HEADER_BPS);
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
  if (positions.length === 0) return { ok: false, reason: 'no-header-sync', positions, corr };

  const headerSyncPos = positions[0];
  const start = headerSyncPos + symN + syncGuardN;

  const symbols = [];
  for (let k = 0; k < C.HEADER_SYMBOLS; k++) {
    const segStart = start + k * step;
    const segEnd = segStart + symN;
    if (segEnd > data.length) return { ok: false, reason: 'header-truncated', positions, corr };
    const segment = data.subarray(segStart, segEnd);
    const demod = C.iqDemodulate(segment, refComplex);
    const re = new Float64Array(nPow2);
    const im = new Float64Array(nPow2);
    re.set(demod.re); im.set(demod.im);
    C.fft(re, im);
    let bestBin = validBins[0], bestMag = -1;
    for (const b of validBins) {
      const mag = re[b]*re[b] + im[b]*im[b];
      if (mag > bestMag) { bestMag = mag; bestBin = b; }
    }
    symbols.push(binToSymbol[bestBin]);
  }

  const header = C.symbolsToHeader(symbols);
  if (!C.isPlausibleHeader(header)) return { ok: false, reason: 'header-implausible', header, positions, corr };

  const headerEndSample = start + C.HEADER_SYMBOLS * step;
  return { ok: true, header, headerEndSample, headerSyncPos, positions, corr };
}

// ---- copied from app.js: attemptDecode (now with searchStartSample) ----
function attemptDecode(data, sr, bps, repFactor, useCrc, expectedPayloadLen, searchStartSample) {
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

  const searchData = searchStartSample ? data.subarray(searchStartSample) : data;
  const { positions: rawPositions, corr } = C.findSyncPositions(searchData, sr, baseDown, Math.max(symbolDurSec * 0.5, 0.01), 0.35);
  const positions = searchStartSample ? rawPositions.map(p => p + searchStartSample) : rawPositions;
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

// ---- copied from app.js: full decode flow (header-first) ----
function fullDecode(data, sr) {
  const headerResult = decodeHeader(data, sr);
  if (!headerResult.ok) {
    return { ok: false, reason: headerResult.reason || 'no-header-sync' };
  }
  const { bps, eccPercent, useCrc, repeats } = headerResult.header;
  const repFactor = C.eccRepFactor(eccPercent);
  const result = attemptDecode(data, sr, bps, repFactor, useCrc, null, headerResult.headerEndSample);
  if (result.ok) result.headerInfo = { bps, eccPercent, useCrc, repeats };
  return result;
}

// ================= TESTS =================
// Test A: basic round trip, no CRC, no ECC -- settings recovered from header
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: false, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = fullDecode(waveform, sr);
  assert(result.ok && result.text === 'HELLOWORLD', `basic round trip: ${JSON.stringify(result.ok ? result.text : result.reason)}`);
  assert(result.ok && result.headerInfo && result.headerInfo.bps === 5 && result.headerInfo.eccPercent === 0 && result.headerInfo.useCrc === false && result.headerInfo.repeats === 3,
    `header correctly recovered: ${JSON.stringify(result.headerInfo)}`);
}

// Test B: with CRC, no ECC
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: true, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = fullDecode(waveform, sr);
  assert(result.ok && result.text === 'HELLOWORLD' && result.crcOk === true,
    `CRC round trip: ok=${result.ok} text=${result.text} crcOk=${result.crcOk}`);
}

// Test C: with ECC (50% -> 3x), no CRC
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 50, useCrc: false, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = fullDecode(waveform, sr);
  assert(result.ok && result.text === 'HELLOWORLD', `ECC round trip: ${JSON.stringify(result.ok ? result.text : result.reason)}`);
  assert(result.ok && result.headerInfo.eccPercent === 50, `header ECC% recovered: ${result.headerInfo && result.headerInfo.eccPercent}`);
}

// Test D: CRC + ECC together, non-default rate
{
  const params = { message: 'HELLOWORLD', bps: 10, eccPct: 75, useCrc: true, repeats: 4 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = fullDecode(waveform, sr);
  assert(result.ok && result.text === 'HELLOWORLD' && result.crcOk === true,
    `CRC+ECC round trip @ 10bps: ok=${result.ok} text=${result.text} crcOk=${result.crcOk}`);
  assert(result.ok && result.headerInfo.bps === 10 && result.headerInfo.repeats === 4,
    `header rate+repeats recovered: ${JSON.stringify(result.headerInfo)}`);
}

// Test E: high bps (300 - the fast end of the slider) -- header itself
// always stays at 5bps regardless, only the payload speeds up
{
  const params = { message: 'HI', bps: 300, eccPct: 0, useCrc: true, repeats: 5 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = fullDecode(waveform, sr);
  assert(result.ok && result.text === 'HI' && result.crcOk === true,
    `300bps round trip: ok=${result.ok} text=${result.text} crcOk=${result.crcOk}`);
}

// Test F: low bps (1 - the slow end of the slider)
{
  const params = { message: 'HI', bps: 1, eccPct: 0, useCrc: false, repeats: 2 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = fullDecode(waveform, sr);
  assert(result.ok && result.text === 'HI', `1bps round trip: ok=${result.ok} text=${result.text}`);
}

// Test G: robustness with injected white noise at moderate SNR (header AND
// payload both need to survive the noise now, not just the payload)
{
  const params = { message: 'HELLOWORLD', bps: 5, eccPct: 0, useCrc: true, repeats: 5 };
  const { waveform, sr } = buildMessageWaveform(params);
  const signalRms = Math.sqrt(waveform.reduce((a,b)=>a+b*b,0)/waveform.length);
  const targetSnrDb = -15;
  const noiseRms = signalRms / Math.pow(10, targetSnrDb/20);
  const noisy = new Float64Array(waveform.length);
  function gaussApprox() {
    let s = 0; for (let i=0;i<6;i++) s += Math.random();
    return (s - 3) / 3;
  }
  for (let i=0;i<waveform.length;i++) noisy[i] = waveform[i] + gaussApprox()*noiseRms;
  const result = fullDecode(noisy, sr);
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
  const result = fullDecode(full, sr);
  assert(result.ok && result.text === 'HELLOWORLD', `leading silence round trip: ok=${result.ok} text=${result.ok?result.text:result.reason}`);
}

// Test I: header sync is never mistaken for the payload sync (regression
// test for the exact bug class this refactor could introduce -- searching
// for the payload sync starting from sample 0 instead of after the header
// could, in principle, re-detect the header's own down-chirp)
{
  const params = { message: 'HELLOWORLD', bps: 50, eccPct: 0, useCrc: true, repeats: 3 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = fullDecode(waveform, sr);
  assert(result.ok && result.totalRepeats === 3,
    `payload sync count excludes header sync: expected 3 repeats, got ${result.ok ? result.totalRepeats : result.reason}`);
}

// Test J: a header with an implausible/garbage decode (pure noise, no real
// transmission) is correctly rejected rather than proceeding to decode junk
{
  const sr = C.SAMPLE_RATE;
  const pureNoise = new Float64Array(sr * 10);
  for (let i = 0; i < pureNoise.length; i++) pureNoise[i] = (Math.random() - 0.5) * 0.1;
  const result = fullDecode(pureNoise, sr);
  assert(result.ok === false, `pure noise correctly rejected: ok=${result.ok} reason=${result.reason}`);
}

// Test K: repeats count at the upper boundary (31, the 5-bit max)
{
  const params = { message: 'HI', bps: 100, eccPct: 0, useCrc: false, repeats: 31 };
  const { waveform, sr } = buildMessageWaveform(params);
  const result = fullDecode(waveform, sr);
  assert(result.ok && result.text === 'HI' && result.headerInfo.repeats === 31,
    `repeats=31 boundary: ok=${result.ok} text=${result.ok?result.text:result.reason} repeats=${result.ok?result.headerInfo.repeats:'?'}`);
}

console.log('\nDone.');
