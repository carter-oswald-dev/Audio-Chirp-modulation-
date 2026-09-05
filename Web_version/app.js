(() => {
  const C = ChirpCodec;

  // ---------- Elements ----------
  const msgInput = document.getElementById('msgInput');
  const charCount = document.getElementById('charCount');
  const bpsSlider = document.getElementById('bpsSlider');
  const bpsVal = document.getElementById('bpsVal');
  const eccSlider = document.getElementById('eccSlider');
  const eccVal = document.getElementById('eccVal');
  const crcToggle = document.getElementById('crcToggle');
  const repeatsSlider = document.getElementById('repeatsSlider');
  const repeatsVal = document.getElementById('repeatsVal');
  const distInput = document.getElementById('distInput');
  const unitFt = document.getElementById('unitFt');
  const unitM = document.getElementById('unitM');
  const distNote = document.getElementById('distNote');

  const durationBig = document.getElementById('durationBig');
  const roPayload = document.getElementById('roPayload');
  const roCrc = document.getElementById('roCrc');
  const roEcc = document.getElementById('roEcc');
  const roSymbols = document.getElementById('roSymbols');
  const roSymDur = document.getElementById('roSymDur');
  const roBw = document.getElementById('roBw');
  const roGain = document.getElementById('roGain');
  const roSuggest = document.getElementById('roSuggest');

  const generateBtn = document.getElementById('generateBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const genProgress = document.getElementById('genProgress');
  const genProgressBar = document.getElementById('genProgressBar');

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileNameEl = document.getElementById('fileName');
  const knownSettingsToggle = document.getElementById('knownSettingsToggle');
  const decodeSettingsPanel = document.getElementById('decodeSettingsPanel');
  const decBpsSlider = document.getElementById('decBpsSlider');
  const decBpsVal = document.getElementById('decBpsVal');
  const decEccSlider = document.getElementById('decEccSlider');
  const decEccVal = document.getElementById('decEccVal');
  const decCrcToggle = document.getElementById('decCrcToggle');
  const decodeBtn = document.getElementById('decodeBtn');
  const decProgress = document.getElementById('decProgress');
  const decProgressBar = document.getElementById('decProgressBar');
  const corrCanvas = document.getElementById('corrCanvas');
  const resultBox = document.getElementById('resultBox');
  const resultText = document.getElementById('resultText');
  const resultMeta = document.getElementById('resultMeta');

  let unit = 'ft';
  let lastGeneratedWav = null; // { blob, url }
  let selectedFile = null;

  // ---------- Live readout calculation ----------
  function currentParams() {
    const message = (msgInput.value || '').toUpperCase();
    const bps = parseInt(bpsSlider.value, 10);
    const eccPct = parseInt(eccSlider.value, 10);
    const useCrc = crcToggle.checked;
    const repeats = parseInt(repeatsSlider.value, 10);
    return { message, bps, eccPct, useCrc, repeats };
  }

  function distanceInMeters() {
    const raw = parseFloat(distInput.value);
    if (isNaN(raw) || raw <= 0) return null;
    return unit === 'ft' ? raw * 0.3048 : raw;
  }

  // Rough, clearly-labeled physical estimate: spreading loss + assumed
  // ambient noise -> a suggested max bps that keeps a comfortable margin.
  // This mirrors the reasoning worked through by hand for this project,
  // NOT a validated universal formula -- outdoor noise/multipath vary a
  // lot, so this is a starting point, not a guarantee.
  function suggestBpsForDistance(distM) {
    if (!distM || distM <= 0) return null;
    const sourceSplAt1m = 82;      // dB SPL, rough phone-speaker assumption
    const ambientDba = 48;          // dB, rough suburban/outdoor assumption
    const noiseBandwidthHz = 4000;  // Hz, rough spread of that ambient noise
    const airAbsorptionPer100m = 1.0; // dB/100m at ~2.5kHz, rough

    const spreadingLossDb = 20 * Math.log10(Math.max(distM, 0.1));
    const airLossDb = airAbsorptionPer100m * (distM / 100);
    const splAtMic = sourceSplAt1m - spreadingLossDb - airLossDb;

    const noisePsdDbPerHz = ambientDba - 10 * Math.log10(noiseBandwidthHz);

    const targetMarginDb = 6; // comfortable decode margin

    // search candidate bps values (5 bits/symbol -> symbol duration = 5/bps)
    const candidates = [1,2,3,5,8,10,15,20,30,50,75,100,150,200,250,300];
    let best = 1;
    for (const bps of candidates) {
      const symbolDur = 5.0 / bps;
      const bw = C.BANDWIDTH; // chirp always spans full 1-4kHz regardless of rate
      const chirpGainDb = 10 * Math.log10(symbolDur * bw);
      const noiseInBwDb = noisePsdDbPerHz + 10 * Math.log10(bw);
      const rawSnrDb = splAtMic - noiseInBwDb;
      const postGainSnrDb = rawSnrDb + chirpGainDb;
      if (postGainSnrDb >= targetMarginDb) best = bps;
    }
    return best;
  }

  function fmtDuration(sec) {
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}m ${s.toFixed(0)}s`;
  }

  function updateReadout() {
    const { message, bps, eccPct, useCrc, repeats } = currentParams();
    charCount.textContent = `${message.length} chars`;
    bpsVal.textContent = `${bps} bps`;
    eccVal.textContent = `${eccPct}%`;
    repeatsVal.textContent = `${repeats}×`;

    let payloadSymbolCount = 0;
    let payloadError = null;
    try {
      payloadSymbolCount = C.textToSymbols(message).length;
    } catch (e) {
      payloadError = e.message;
    }

    const crcSymbolCount = useCrc ? 7 : 0;
    const repFactor = C.eccRepFactor(eccPct);
    const baseSymbols = payloadSymbolCount + crcSymbolCount;
    const totalSymbolsPerRepeat = baseSymbols * repFactor;

    const symbolDurSec = C.bpsToSymbolDuration(bps);
    const guardSec = symbolDurSec * C.GUARD_FRACTION;
    const syncSec = symbolDurSec; // sync chirp is same duration as a symbol
    const syncGuardSec = symbolDurSec * C.SYNC_GUARD_FRACTION;

    const perRepeatSec = syncSec + syncGuardSec + totalSymbolsPerRepeat * (symbolDurSec + guardSec);
    const totalSec = perRepeatSec * repeats;

    const chirpGainDb = 10 * Math.log10(symbolDurSec * C.BANDWIDTH);

    if (payloadError) {
      durationBig.textContent = '—';
      roPayload.textContent = payloadError;
      roPayload.parentElement.querySelector('.v').classList.add('warn');
      generateBtn.disabled = true;
    } else {
      generateBtn.disabled = message.length === 0;
      durationBig.textContent = fmtDuration(totalSec);
      roPayload.textContent = `${payloadSymbolCount} symbols (${payloadSymbolCount * 5} bits)`;
      roPayload.classList.remove('warn');
    }

    roCrc.textContent = useCrc ? `+${crcSymbolCount} symbols (+${crcSymbolCount * 5} bits)` : 'off';
    roEcc.textContent = repFactor > 1 ? `${repFactor}× repetition (+${(repFactor - 1) * 100}% overhead)` : 'off';
    roSymbols.textContent = `${totalSymbolsPerRepeat}`;
    roSymDur.textContent = `${(symbolDurSec * 1000).toFixed(1)} ms`;
    roBw.textContent = `${C.F_LOW / 1000}–${C.F_HIGH / 1000} kHz (${C.BANDWIDTH} Hz)`;
    roGain.textContent = `~${chirpGainDb.toFixed(1)} dB`;

    const distM = distanceInMeters();
    if (distM) {
      const suggestedBps = suggestBpsForDistance(distM);
      roSuggest.textContent = `~${suggestedBps} bps or slower`;
      distNote.textContent = `Rough estimate for ${unit === 'ft' ? (distM/0.3048).toFixed(distM/0.3048 < 3 ? 2 : 0) : distM.toFixed(distM < 3 ? 2 : 0)}${unit}: assumes typical phone speaker output and moderate outdoor ambient noise. Real conditions vary — treat this as a starting point.`;
    } else {
      roSuggest.textContent = '—';
      distNote.textContent = 'Enter a distance to see a suggested data rate.';
    }
  }

  [msgInput, bpsSlider, eccSlider, crcToggle, repeatsSlider, distInput].forEach(el => {
    el.addEventListener('input', updateReadout);
  });
  unitFt.addEventListener('click', () => { unit = 'ft'; unitFt.classList.add('active'); unitM.classList.remove('active'); updateReadout(); });
  unitM.addEventListener('click', () => { unit = 'm'; unitM.classList.add('active'); unitFt.classList.remove('active'); updateReadout(); });

  // ---------- Encoding ----------
  function buildMessageWaveform(params, onProgress) {
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
    let off = 0;
    const oneRepeat = new Float64Array(repeatLen);
    let ro = 0;
    for (const p of repeatParts) { oneRepeat.set(p, ro); ro += p.length; }
    for (let r = 0; r < repeats; r++) {
      full.set(oneRepeat, off);
      off += repeatLen;
      if (onProgress) onProgress((r + 1) / repeats);
    }

    // amplitude headroom
    for (let i = 0; i < full.length; i++) full[i] *= 0.85;

    return { waveform: full, sr, symbolCount: symbols.length };
  }

  function floatToWavBlob(waveform, sr) {
    const n = waveform.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++) {
      let s = Math.max(-1, Math.min(1, waveform[i]));
      view.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
      off += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
  }

  let audioCtx = null;
  function playBuffer(waveform, sr) {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = audioCtx.createBuffer(1, waveform.length, sr);
    buf.copyToChannel(Float32Array.from(waveform), 0);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start();
  }

  async function generateAndPlay() {
    const params = currentParams();
    if (!params.message) return;
    generateBtn.disabled = true;
    genProgress.classList.add('active');
    genProgressBar.style.width = '0%';

    await new Promise(r => setTimeout(r, 10)); // let UI paint

    try {
      const { waveform, sr } = buildMessageWaveform(params, (p) => {
        genProgressBar.style.width = `${Math.round(p * 100)}%`;
      });
      const blob = floatToWavBlob(waveform, sr);
      const url = URL.createObjectURL(blob);
      if (lastGeneratedWav) URL.revokeObjectURL(lastGeneratedWav.url);
      lastGeneratedWav = { blob, url };
      playBuffer(waveform, sr);
    } catch (e) {
      alert('Could not generate audio: ' + e.message);
    } finally {
      generateBtn.disabled = false;
      setTimeout(() => genProgress.classList.remove('active'), 400);
    }
  }

  function downloadWav() {
    const params = currentParams();
    if (!params.message) return;
    try {
      const { waveform, sr } = buildMessageWaveform(params);
      const blob = floatToWavBlob(waveform, sr);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const safeName = params.message.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40) || 'message';
      a.download = `${safeName}_${params.bps}bps.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) {
      alert('Could not generate audio: ' + e.message);
    }
  }

  generateBtn.addEventListener('click', generateAndPlay);
  downloadBtn.addEventListener('click', downloadWav);

  // ---------- Decode ----------
  knownSettingsToggle.addEventListener('change', () => {
    decodeSettingsPanel.style.display = knownSettingsToggle.checked ? 'block' : 'none';
  });
  decBpsSlider.addEventListener('input', () => { decBpsVal.textContent = `${decBpsSlider.value} bps`; });
  decEccSlider.addEventListener('input', () => { decEccVal.textContent = `${decEccSlider.value}%`; });

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  function handleFile(file) {
    selectedFile = file;
    fileNameEl.textContent = file.name;
    decodeBtn.disabled = false;
    resultBox.style.display = 'none';
  }

  async function decodeAudioFileToFloat64(file) {
    const arrayBuf = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuf = await ctx.decodeAudioData(arrayBuf.slice(0));
    // downmix to mono if needed
    const numCh = audioBuf.numberOfChannels;
    const len = audioBuf.length;
    const mono = new Float64Array(len);
    for (let ch = 0; ch < numCh; ch++) {
      const data = audioBuf.getChannelData(ch);
      for (let i = 0; i < len; i++) mono[i] += data[i] / numCh;
    }
    const sr = audioBuf.sampleRate;
    ctx.close();
    // resample to our reference sample rate if needed (simple linear resample)
    if (sr !== C.SAMPLE_RATE) {
      return { data: linearResample(mono, sr, C.SAMPLE_RATE), sr: C.SAMPLE_RATE };
    }
    return { data: mono, sr };
  }

  function linearResample(data, srcRate, dstRate) {
    const ratio = dstRate / srcRate;
    const outLen = Math.round(data.length * ratio);
    const out = new Float64Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const srcPos = i / ratio;
      const i0 = Math.floor(srcPos);
      const i1 = Math.min(i0 + 1, data.length - 1);
      const frac = srcPos - i0;
      out[i] = data[i0] * (1 - frac) + data[i1] * frac;
    }
    return out;
  }

  // Attempt decode at one specific (bps, repFactor) setting. Returns
  // { text, confidenceAvg, symbols, positions, corr, crcOk, crcChecked }
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
    if (positions.length === 0) {
      return { ok: false, reason: 'no-sync', positions, corr };
    }

    // Determine how many symbols per repeat to expect
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

    if (!accumulated || validRepeats === 0) {
      return { ok: false, reason: 'no-complete-repeats', positions, corr };
    }

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

    return {
      ok: true, text, avgConf, symbols: payloadSymbols, positions, corr,
      crcOk, validRepeats, totalRepeats: positions.length,
    };
  }

  function drawCorrelation(corr, sr, positions) {
    corrCanvas.style.display = 'block';
    const ctx = corrCanvas.getContext('2d');
    const w = corrCanvas.width = corrCanvas.clientWidth;
    const h = corrCanvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1f2530';
    ctx.fillRect(0, 0, w, h);
    if (!corr || corr.length === 0) return;

    const step = Math.max(1, Math.floor(corr.length / w));
    let maxVal = 0;
    for (let i = 0; i < corr.length; i += step) if (corr[i] > maxVal) maxVal = corr[i];
    if (maxVal <= 0) maxVal = 1;

    ctx.strokeStyle = '#7dd3c0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const idx = x * step;
      if (idx >= corr.length) break;
      let v = 0;
      for (let k = 0; k < step && idx + k < corr.length; k++) v = Math.max(v, corr[idx + k]);
      const y = h - (v / maxVal) * (h - 6) - 3;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (positions) {
      ctx.strokeStyle = 'rgba(240,168,104,0.6)';
      for (const p of positions) {
        const x = (p / corr.length) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }
  }

  async function decode() {
    if (!selectedFile) return;
    decodeBtn.disabled = true;
    decProgress.classList.add('active');
    decProgressBar.style.width = '10%';
    resultBox.style.display = 'none';

    try {
      const { data, sr } = await decodeAudioFileToFloat64(selectedFile);
      decProgressBar.style.width = '30%';
      await new Promise(r => setTimeout(r, 10));

      let result = null;

      if (knownSettingsToggle.checked) {
        const bps = parseInt(decBpsSlider.value, 10);
        const eccPct = parseInt(decEccSlider.value, 10);
        const repFactor = C.eccRepFactor(eccPct);
        const useCrc = decCrcToggle.checked;
        result = attemptDecode(data, sr, bps, repFactor, useCrc, null);
        decProgressBar.style.width = '90%';
      } else {
        // Auto-detect: try a candidate set of bps values, pick the one
        // with the strongest/most-consistent sync correlation, then try
        // ECC factors 1-5x (favoring one that makes CRC validate, if used).
        const candidates = [5, 1, 2, 10, 20, 50, 100, 150, 300];
        let bestBps = null, bestScore = -1, bestPositions = null;
        for (let ci = 0; ci < candidates.length; ci++) {
          const bps = candidates[ci];
          const symbolDurSec = C.bpsToSymbolDuration(bps);
          const baseDown = C.makeRealDownChirp(symbolDurSec, sr);
          const { positions, corr } = C.findSyncPositions(data, sr, baseDown, Math.max(symbolDurSec * 0.5, 0.01), 0.4);
          if (positions.length >= 2) {
            // score by peak correlation strength relative to median (rough SNR proxy)
            let peak = 0, sum = 0;
            for (const p of positions) peak = Math.max(peak, corr[p] || 0);
            const sorted = Float64Array.from(corr).sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)] || 1;
            const score = peak / Math.max(median, 1e-6);
            if (score > bestScore) { bestScore = score; bestBps = bps; bestPositions = positions; }
          }
          decProgressBar.style.width = `${30 + Math.round(40 * (ci + 1) / candidates.length)}%`;
          await new Promise(r => setTimeout(r, 0));
        }

        if (bestBps == null) {
          result = { ok: false, reason: 'no-sync' };
        } else {
          // try CRC-on first (most common default), rep factors 1..5
          let found = null;
          for (const useCrc of [true, false]) {
            for (let rep = 1; rep <= 5; rep++) {
              const attempt = attemptDecode(data, sr, bestBps, rep, useCrc, null);
              if (attempt.ok && useCrc && attempt.crcOk) { found = attempt; break; }
              if (attempt.ok && !useCrc && !found) found = attempt; // fallback candidate
            }
            if (found && found.crcOk) break;
          }
          result = found || { ok: false, reason: 'no-complete-repeats' };
        }
        decProgressBar.style.width = '95%';
      }

      showResult(result);
    } catch (e) {
      showResult({ ok: false, reason: 'error', error: e.message });
    } finally {
      decodeBtn.disabled = false;
      setTimeout(() => decProgress.classList.remove('active'), 400);
    }
  }

  function showResult(result) {
    resultBox.style.display = 'block';
    if (result.corr) drawCorrelation(result.corr, C.SAMPLE_RATE, result.positions);

    if (!result.ok) {
      resultBox.classList.add('fail');
      let msg = 'Could not find a usable signal in this recording.';
      if (result.reason === 'no-sync') msg = 'No sync chirp detected. The signal may be too weak, the recording too short, or the settings mismatched.';
      if (result.reason === 'no-complete-repeats') msg = 'A sync chirp was found but no complete message repeat could be decoded (recording may be cut off).';
      if (result.reason === 'error') msg = 'Error reading this file: ' + result.error;
      resultText.textContent = msg;
      resultMeta.textContent = '';
      return;
    }

    resultBox.classList.remove('fail');
    resultText.textContent = result.text || '(empty)';
    const bits = [];
    bits.push(`${result.validRepeats}/${result.totalRepeats} repeat(s) used`);
    bits.push(`avg confidence ${result.avgConf.toFixed(1)} dB`);
    if (result.crcOk === true) bits.push('checksum OK ✓');
    if (result.crcOk === false) bits.push('checksum MISMATCH — text may be corrupted');
    resultMeta.textContent = bits.join(' · ');
  }

  decodeBtn.addEventListener('click', decode);

  // ---------- init ----------
  updateReadout();
})();
