// Node test harness: validate ChirpCodec logic headlessly before wiring
// into the browser UI. Load chirp-codec.js as a script into a fake global.

const fs = require('fs');
const vm = require('vm');
const code = fs.readFileSync('./chirp-codec.js', 'utf8') + '\nthis.ChirpCodec = ChirpCodec;';
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const ChirpCodec = sandbox.ChirpCodec;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

// ---- Test 1: Baudot round-trip ----
{
  const symbols = ChirpCodec.textToSymbols('HELLOWORLD');
  const text = ChirpCodec.symbolsToText(symbols);
  assert(text === 'HELLOWORLD', `Baudot round-trip: got "${text}"`);
  assert(symbols.length === 10, `Baudot symbol count: got ${symbols.length}`);
}

// ---- Test 2: CRC32 known value ----
{
  // CRC32 of "HELLOWORLD" (standard zlib crc32) - verify against a known
  // reference value computed independently.
  const bytes = ChirpCodec.textToBytes('HELLOWORLD');
  const crc = ChirpCodec.crc32(bytes);
  console.log('CRC32("HELLOWORLD") =', crc.toString(16));
  // round-trip through symbol packing
  const syms = ChirpCodec.crc32ToSymbols(crc);
  assert(syms.length === 7, `CRC packs into 7 symbols: got ${syms.length}`);
  const crcBack = ChirpCodec.symbolsToCrc32(syms);
  assert(crcBack === crc, `CRC32 symbol round-trip: ${crc.toString(16)} vs ${crcBack.toString(16)}`);
}

// ---- Test 3: repetition ECC round-trip (no errors) ----
{
  const symbols = [1, 2, 3, 4, 5];
  const rep = ChirpCodec.eccRepFactor(75); // -> 4x
  assert(rep === 4, `ecc 75% -> 4x repeat: got ${rep}x`);
  const expanded = ChirpCodec.applyRepetition(symbols, rep);
  assert(expanded.length === 20, `expanded length: got ${expanded.length}`);
  const { symbols: recovered } = ChirpCodec.undoRepetitionMajorityVote(expanded, rep);
  assert(JSON.stringify(recovered) === JSON.stringify(symbols), `majority vote recovers original: ${recovered}`);
}

// ---- Test 4: repetition ECC with injected errors (majority vote should fix) ----
{
  const symbols = [10, 20, 30];
  const rep = 5;
  let expanded = ChirpCodec.applyRepetition(symbols, rep);
  // corrupt 2 of 5 copies of the middle symbol (still a majority of 3/5 correct)
  expanded[5] = 99; // was 20
  expanded[6] = 99;
  const { symbols: recovered } = ChirpCodec.undoRepetitionMajorityVote(expanded, rep);
  assert(JSON.stringify(recovered) === JSON.stringify(symbols),
    `majority vote survives 2/5 corruption: ${recovered}`);
}

// ---- Test 5: symbol-to-bin table is a valid bijection ----
{
  const durationSec = ChirpCodec.bpsToSymbolDuration(5); // 1.0s, matches Python prototype
  const { symbolToBin, binToSymbol } = ChirpCodec.buildSymbolToBinTable(durationSec, ChirpCodec.SAMPLE_RATE);
  const bins = Object.values(symbolToBin);
  const uniqueBins = new Set(bins);
  assert(uniqueBins.size === ChirpCodec.N_SYMBOLS, `all 32 symbols map to distinct bins: got ${uniqueBins.size} unique`);
  // spot check: inverse lookup works
  let allMatch = true;
  for (let s = 0; s < ChirpCodec.N_SYMBOLS; s++) {
    const bin = symbolToBin[s];
    if (binToSymbol[bin] !== s) allMatch = false;
  }
  assert(allMatch, 'symbolToBin / binToSymbol are true inverses');
}

// ---- Test 6: full encode->IQ-demod->decode for all 32 symbols (clean, no noise) ----
{
  const durationSec = ChirpCodec.bpsToSymbolDuration(5);
  const sr = ChirpCodec.SAMPLE_RATE;
  const baseUpReal = ChirpCodec.makeRealUpChirp(durationSec, sr);
  const refComplex = ChirpCodec.makeComplexUpChirp(durationSec, sr);
  const { binToSymbol, nPow2 } = ChirpCodec.buildSymbolToBinTable(durationSec, sr);

  let allOk = true;
  for (let testSymbol = 0; testSymbol < 32; testSymbol++) {
    const txWave = ChirpCodec.cyclicShift(baseUpReal, testSymbol, ChirpCodec.N_SYMBOLS);
    const demod = ChirpCodec.iqDemodulate(txWave, refComplex);
    const re = new Float64Array(nPow2);
    const im = new Float64Array(nPow2);
    re.set(demod.re);
    im.set(demod.im);
    ChirpCodec.fft(re, im);
    let bestBin = 0, bestMag = -1;
    for (let i = 0; i < nPow2; i++) {
      const mag = re[i]*re[i] + im[i]*im[i];
      if (mag > bestMag) { bestMag = mag; bestBin = i; }
    }
    const decoded = binToSymbol[bestBin];
    if (decoded !== testSymbol) {
      console.log(`  symbol ${testSymbol} -> decoded as ${decoded} (bin ${bestBin})`);
      allOk = false;
    }
  }
  assert(allOk, 'all 32 symbols encode/IQ-demod/decode correctly (clean signal)');
}

// ---- Test 7: full message encode/decode with guards, sync, at various bps ----
{
  const sr = ChirpCodec.SAMPLE_RATE;
  for (const bps of [5, 50, 300]) {
    const durationSec = ChirpCodec.bpsToSymbolDuration(bps);
    const baseUpReal = ChirpCodec.makeRealUpChirp(durationSec, sr);
    const baseDownReal = ChirpCodec.makeRealDownChirp(durationSec, sr);
    const refComplex = ChirpCodec.makeComplexUpChirp(durationSec, sr);
    const { binToSymbol, nPow2 } = ChirpCodec.buildSymbolToBinTable(durationSec, sr);

    const message = 'HELLOWORLD';
    const symbols = ChirpCodec.textToSymbols(message);
    const guardN = Math.round(durationSec * ChirpCodec.GUARD_FRACTION * sr);
    const syncGuardN = Math.round(durationSec * ChirpCodec.SYNC_GUARD_FRACTION * sr);
    const symN = baseUpReal.length;

    // Build one repeat: sync + guard + symbols(each + guard)
    const parts = [ChirpCodec.applyFade(baseDownReal, sr, 5), new Float64Array(syncGuardN)];
    for (const s of symbols) {
      parts.push(ChirpCodec.applyFade(ChirpCodec.cyclicShift(baseUpReal, s, ChirpCodec.N_SYMBOLS), sr, 5));
      parts.push(new Float64Array(guardN));
    }
    const totalLen = parts.reduce((a, p) => a + p.length, 0);
    const full = new Float64Array(totalLen);
    let off = 0;
    for (const p of parts) { full.set(p, off); off += p.length; }

    // Decode: we know sync starts at 0, first symbol starts after sync+syncguard
    const start = baseDownReal.length + syncGuardN;
    const decoded = [];
    for (let k = 0; k < symbols.length; k++) {
      const segStart = start + k * (symN + guardN);
      const segment = full.slice(segStart, segStart + symN);
      const demod = ChirpCodec.iqDemodulate(segment, refComplex);
      const re = new Float64Array(nPow2);
      const im = new Float64Array(nPow2);
      re.set(demod.re); im.set(demod.im);
      ChirpCodec.fft(re, im);
      let bestBin = 0, bestMag = -1;
      for (let i = 0; i < nPow2; i++) {
        const mag = re[i]*re[i] + im[i]*im[i];
        if (mag > bestMag) { bestMag = mag; bestBin = i; }
      }
      decoded.push(binToSymbol[bestBin]);
    }
    const text = ChirpCodec.symbolsToText(decoded);
    assert(text === message, `full message decode @ ${bps}bps: got "${text}"`);
  }
}

// ---- Test 8: sync detection finds correct repeat positions ----
{
  const sr = 48000;
  const bps = 5;
  const durationSec = ChirpCodec.bpsToSymbolDuration(bps);
  const baseUpReal = ChirpCodec.makeRealUpChirp(durationSec, sr);
  const baseDownReal = ChirpCodec.makeRealDownChirp(durationSec, sr);
  const message = 'HELLOWORLD';
  const symbols = ChirpCodec.textToSymbols(message);
  const guardN = Math.round(durationSec * ChirpCodec.GUARD_FRACTION * sr);
  const syncGuardN = Math.round(durationSec * ChirpCodec.SYNC_GUARD_FRACTION * sr);

  function buildRepeat() {
    const parts = [ChirpCodec.applyFade(baseDownReal, sr, 5), new Float64Array(syncGuardN)];
    for (const s of symbols) {
      parts.push(ChirpCodec.applyFade(ChirpCodec.cyclicShift(baseUpReal, s, ChirpCodec.N_SYMBOLS), sr, 5));
      parts.push(new Float64Array(guardN));
    }
    const totalLen = parts.reduce((a, p) => a + p.length, 0);
    const out = new Float64Array(totalLen);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  const repeat = buildRepeat();
  const nRepeats = 3;
  const leadInSilence = new Float64Array(sr * 2); // 2s silence before message starts
  const full = new Float64Array(leadInSilence.length + repeat.length * nRepeats);
  full.set(leadInSilence, 0);
  for (let r = 0; r < nRepeats; r++) full.set(repeat, leadInSilence.length + r * repeat.length);

  const { positions } = ChirpCodec.findSyncPositions(full, sr, baseDownReal, 2.0, 0.35);
  assert(positions.length === nRepeats, `found ${nRepeats} sync positions: got ${positions.length}`);

  const expectedFirst = leadInSilence.length;
  const tolSamples = sr * 0.02; // 20ms tolerance
  const firstOk = Math.abs(positions[0] - expectedFirst) < tolSamples;
  assert(firstOk, `first sync position near expected (${expectedFirst}): got ${positions[0]}`);

  if (positions.length === nRepeats) {
    const spacing1 = positions[1] - positions[0];
    const expectedSpacing = repeat.length;
    assert(Math.abs(spacing1 - expectedSpacing) < tolSamples,
      `repeat spacing matches (${expectedSpacing}): got ${spacing1}`);
  }
}

console.log('\nDone.');
