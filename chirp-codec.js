/*
 * Chirp-spread-spectrum acoustic data codec.
 *
 * Faithful port of a validated Python prototype (LoRa-style CSS):
 *   - 5-bit Baudot (ITA2) text encoding
 *   - each 5-bit symbol -> a cyclically time-shifted linear chirp
 *   - a distinct down-chirp marks the start of each message repeat
 *   - decode = correlate for sync, then "dechirp" (multiply by the
 *     conjugate of an analytic reference chirp) + FFT peak-picking
 *
 * New vs. the Python prototype: variable symbol rate (1-300bps),
 * optional repetition-code error correction (0-100%), optional CRC32.
 */

const ChirpCodec = (() => {

  // ---------- Baudot (ITA2), letters-shift subset ----------
  const ITA2_LETTERS = {
    0b00000: '\x00', 0b00011: 'A', 0b11001: 'B', 0b01110: 'C', 0b01001: 'D',
    0b00001: 'E', 0b01101: 'F', 0b11010: 'G', 0b10100: 'H', 0b00110: 'I',
    0b01011: 'J', 0b01111: 'K', 0b10010: 'L', 0b11100: 'M', 0b01100: 'N',
    0b11000: 'O', 0b10110: 'P', 0b10111: 'Q', 0b01010: 'R', 0b00101: 'S',
    0b10000: 'T', 0b00111: 'U', 0b11110: 'V', 0b10011: 'W', 0b11101: 'X',
    0b10101: 'Y', 0b10001: 'Z', 0b00100: ' ', 0b01000: '\n', 0b00010: '\r',
  };
  const CHAR_TO_CODE = {};
  for (const k in ITA2_LETTERS) CHAR_TO_CODE[ITA2_LETTERS[k]] = parseInt(k);

  function textToSymbols(text) {
    text = text.toUpperCase();
    const symbols = [];
    for (const ch of text) {
      if (!(ch in CHAR_TO_CODE)) {
        throw new Error(`Character "${ch}" isn't supported (A-Z, space only).`);
      }
      symbols.push(CHAR_TO_CODE[ch]);
    }
    return symbols;
  }

  function symbolsToText(symbols) {
    return symbols.map(s => ITA2_LETTERS.hasOwnProperty(s) ? ITA2_LETTERS[s] : '\uFFFD').join('');
  }

  // ---------- CRC32 (standard poly 0xEDB88320) ----------
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Pack a string's char codes into bytes for CRC purposes (simple 1-byte/char,
  // fine since Baudot alphabet is a small subset of ASCII).
  function textToBytes(text) {
    const b = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 0xFF;
    return b;
  }

  // CRC32 (32 bits) packed as 7 Baudot symbols (5 bits each = 35 bits, using 32 + 3 pad bits)
  function crc32ToSymbols(crc) {
    // 32 bits -> chunks of 5 bits, MSB first, padded to 35 bits (7 symbols)
    const bits = [];
    for (let i = 31; i >= 0; i--) bits.push((crc >>> i) & 1);
    while (bits.length % 5 !== 0) bits.push(0);
    const symbols = [];
    for (let i = 0; i < bits.length; i += 5) {
      let v = 0;
      for (let j = 0; j < 5; j++) v = (v << 1) | bits[i + j];
      symbols.push(v);
    }
    return symbols; // 7 symbols
  }

  function symbolsToCrc32(symbols) {
    // inverse of crc32ToSymbols: 7 symbols -> 35 bits -> take top 32
    let bits = [];
    for (const s of symbols) {
      for (let j = 4; j >= 0; j--) bits.push((s >> j) & 1);
    }
    bits = bits.slice(0, 32);
    let crc = 0;
    for (let i = 0; i < 32; i++) crc = (crc << 1) | bits[i];
    return crc >>> 0;
  }

  // ---------- Repetition-code error correction ----------
  // ecc percentage (0-100) -> repetition factor 1x-5x, majority-vote decoded.
  function eccRepFactor(eccPercent) {
    return 1 + Math.round((eccPercent / 100) * 4); // 1..5
  }

  function applyRepetition(symbols, repFactor) {
    if (repFactor <= 1) return symbols.slice();
    const out = [];
    for (const s of symbols) {
      for (let i = 0; i < repFactor; i++) out.push(s);
    }
    return out;
  }

  function undoRepetitionMajorityVote(symbols, repFactor, confidences) {
    if (repFactor <= 1) return { symbols: symbols.slice(), confidences: confidences ? confidences.slice() : null };
    const outSymbols = [];
    const outConf = [];
    for (let i = 0; i < symbols.length; i += repFactor) {
      const chunk = symbols.slice(i, i + repFactor);
      const counts = new Map();
      for (const c of chunk) counts.set(c, (counts.get(c) || 0) + 1);
      let best = chunk[0], bestCount = -1;
      for (const [val, cnt] of counts.entries()) {
        if (cnt > bestCount) { best = val; bestCount = cnt; }
      }
      outSymbols.push(best);
      if (confidences) {
        const chunkConf = confidences.slice(i, i + repFactor);
        outConf.push(chunkConf.reduce((a, b) => a + b, 0) / chunkConf.length);
      }
    }
    return { symbols: outSymbols, confidences: confidences ? outConf : null };
  }

  // ---------- Chirp waveform parameters ----------
  const SAMPLE_RATE = 48000;
  const F_LOW = 1000.0;
  const F_HIGH = 4000.0;
  const BANDWIDTH = F_HIGH - F_LOW;
  const N_SYMBOLS = 32;
  const GUARD_FRACTION = 0.15;      // guard silence as a fraction of symbol duration
  const SYNC_GUARD_FRACTION = 0.30;

  function bpsToSymbolDuration(bps) {
    // 5 bits/symbol (Baudot); duration in seconds
    return 5.0 / bps;
  }

  function makeRealUpChirp(durationSec, sr) {
    const n = Math.round(durationSec * sr);
    const k = (F_HIGH - F_LOW) / durationSec;
    const wave = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const phase = 2 * Math.PI * (F_LOW * t + 0.5 * k * t * t);
      wave[i] = Math.sin(phase);
    }
    return wave;
  }

  function makeRealDownChirp(durationSec, sr) {
    const n = Math.round(durationSec * sr);
    const k = (F_LOW - F_HIGH) / durationSec;
    const wave = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const phase = 2 * Math.PI * (F_HIGH * t + 0.5 * k * t * t);
      wave[i] = Math.sin(phase);
    }
    return wave;
  }

  // Complex analytic up-chirp reference (cos + j*sin), used for I/Q
  // demodulation on the receive side: multiplying a REAL received signal
  // by (cos, -sin) of this reference forms a complex baseband signal
  // directly, with no need for a full-signal Hilbert transform (which has
  // an ambiguity exactly at the half-length cyclic shift / Nyquist-adjacent
  // case). This is standard I/Q demodulation, same principle as radio
  // receivers use to recover a complex baseband signal from real RF.
  function makeComplexUpChirp(durationSec, sr) {
    const n = Math.round(durationSec * sr);
    const k = (F_HIGH - F_LOW) / durationSec;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const phase = 2 * Math.PI * (F_LOW * t + 0.5 * k * t * t);
      re[i] = Math.cos(phase);
      im[i] = Math.sin(phase);
    }
    return { re, im, n };
  }

  // I/Q demodulate a real-valued segment against the complex reference
  // chirp, producing a complex baseband signal ready for FFT peak-picking.
  // demod(t) = rx(t) * conj(reference(t)) = rx(t) * (cos(phase) - j sin(phase))
  function iqDemodulate(realSegment, refComplex) {
    const n = refComplex.n;
    const outRe = new Float64Array(n);
    const outIm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const rx = realSegment[i];
      outRe[i] = rx * refComplex.re[i];
      outIm[i] = -rx * refComplex.im[i];
    }
    return { re: outRe, im: outIm };
  }

  function cyclicShift(wave, symbolValue, nSymbols) {
    const n = wave.length;
    const shift = Math.round((symbolValue / nSymbols) * n);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      out[(i + shift) % n] = wave[i];
    }
    return out;
  }

  function applyFade(wave, sr, fadeMs) {
    const fadeN = Math.floor(sr * fadeMs / 1000);
    const n = wave.length;
    if (fadeN * 2 >= n) return wave;
    const out = Float64Array.from(wave);
    for (let i = 0; i < fadeN; i++) {
      const w = 0.5 * (1 - Math.cos(Math.PI * i / fadeN));
      out[i] *= w;
      out[n - 1 - i] *= w;
    }
    return out;
  }

  // ---------- FFT (iterative radix-2, in-place on typed arrays) ----------
  // Requires length to be a power of 2. We zero-pad up to next pow2.
  function nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function fft(re, im) {
    const n = re.length;
    // bit-reversal permutation
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let j = 0; j < len / 2; j++) {
          const uRe = re[i + j], uIm = im[i + j];
          const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm;
          const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe;
          re[i + j] = uRe + vRe;
          im[i + j] = uIm + vIm;
          re[i + j + len / 2] = uRe - vRe;
          im[i + j + len / 2] = uIm - vIm;
          const nextRe = curRe * wRe - curIm * wIm;
          const nextIm = curRe * wIm + curIm * wRe;
          curRe = nextRe; curIm = nextIm;
        }
      }
    }
  }

  // Build the exact symbol->bin lookup table by simulating encode+I/Q-demod,
  // mirroring the validated Python prototype's approach (robust to any
  // parameter rounding quirks since both directions derive from the same
  // simulation, and free of the Hilbert-transform Nyquist ambiguity that
  // affects an exact half-length cyclic shift).
  function buildSymbolToBinTable(durationSec, sr) {
    const baseReal = makeRealUpChirp(durationSec, sr);
    const refComplex = makeComplexUpChirp(durationSec, sr);
    const n = refComplex.n;
    const nPow2 = nextPow2(n);
    const symbolToBin = {};
    const binToSymbol = {};
    for (let s = 0; s < N_SYMBOLS; s++) {
      const shifted = cyclicShift(baseReal, s, N_SYMBOLS);
      const demod = iqDemodulate(shifted, refComplex);
      const re = new Float64Array(nPow2);
      const im = new Float64Array(nPow2);
      re.set(demod.re);
      im.set(demod.im);
      fft(re, im);
      let bestBin = 0, bestMag = -1;
      for (let i = 0; i < nPow2; i++) {
        const mag = re[i] * re[i] + im[i] * im[i];
        if (mag > bestMag) { bestMag = mag; bestBin = i; }
      }
      symbolToBin[s] = bestBin;
      binToSymbol[bestBin] = s;
    }
    return { symbolToBin, binToSymbol, nPow2 };
  }

  // ---------- FFT-based cross-correlation (for sync chirp detection) ----------
  // Computes correlation(signal, kernel) via FFT: pad both to a common
  // power-of-2 length, multiply signal's FFT by kernel's conjugated FFT,
  // inverse FFT. Returns a real-valued correlation magnitude array the
  // same length as (signal.length), representing correlation at each
  // possible starting alignment of the kernel within the signal.
  function fftCorrelate(signal, kernel) {
    const n = signal.length;
    const m = kernel.length;
    const outLen = n + m - 1;
    const nPow2 = nextPow2(outLen);

    const sigRe = new Float64Array(nPow2);
    const sigIm = new Float64Array(nPow2);
    sigRe.set(signal);

    // time-reverse the kernel for correlation (convolution with reversed
    // kernel = correlation), matching scipy.signal.fftconvolve(sig, kernel[::-1])
    const kerRe = new Float64Array(nPow2);
    const kerIm = new Float64Array(nPow2);
    for (let i = 0; i < m; i++) kerRe[i] = kernel[m - 1 - i];

    fft(sigRe, sigIm);
    fft(kerRe, kerIm);

    const prodRe = new Float64Array(nPow2);
    const prodIm = new Float64Array(nPow2);
    for (let i = 0; i < nPow2; i++) {
      prodRe[i] = sigRe[i] * kerRe[i] - sigIm[i] * kerIm[i];
      prodIm[i] = sigRe[i] * kerIm[i] + sigIm[i] * kerRe[i];
    }

    // inverse FFT via conjugate trick
    for (let i = 0; i < nPow2; i++) prodIm[i] = -prodIm[i];
    fft(prodRe, prodIm);
    for (let i = 0; i < nPow2; i++) prodRe[i] = prodRe[i] / nPow2;

    // 'valid'-mode equivalent: the correlation output aligned so that
    // result[i] = correlation when kernel starts at signal index i,
    // for i in [0, n-m]. fftconvolve full output has length n+m-1;
    // the valid-mode slice starts at index (m-1).
    const validLen = n - m + 1;
    const result = new Float64Array(Math.max(0, validLen));
    for (let i = 0; i < validLen; i++) {
      result[i] = Math.abs(prodRe[i + m - 1]);
    }
    return result;
  }

  // Find sync chirp positions in a long recording via matched filtering.
  // Returns an array of sample indices where a sync chirp was detected,
  // each at least minSeparationSec apart, restricted to peaks that are at
  // least corrThresholdRatio of the strongest peak found (rejects spurious
  // low-level correlations while still catching every real sync even if
  // repeats have varying SNR across the recording).
  function findSyncPositions(signal, sr, syncKernel, minSeparationSec, corrThresholdRatio) {
    minSeparationSec = minSeparationSec || 1.0;
    corrThresholdRatio = corrThresholdRatio || 0.35;

    const corr = fftCorrelate(signal, syncKernel);
    let peakVal = 0;
    for (let i = 0; i < corr.length; i++) if (corr[i] > peakVal) peakVal = corr[i];
    if (peakVal <= 0) return { positions: [], corr };

    const threshold = peakVal * corrThresholdRatio;
    const minSepSamples = Math.round(minSeparationSec * sr);

    const positions = [];
    let lastPeak = -minSepSamples;
    let i = 0;
    while (i < corr.length) {
      if (corr[i] > threshold) {
        // walk to the end of this contiguous-ish cluster (allow small gaps < 50ms)
        let clusterStart = i;
        let clusterEnd = i;
        let j = i;
        const gapTol = Math.round(sr * 0.05);
        while (j + 1 < corr.length) {
          // find next sample above threshold within gapTol
          let next = -1;
          for (let g = 1; g <= gapTol && j + g < corr.length; g++) {
            if (corr[j + g] > threshold) { next = j + g; break; }
          }
          if (next === -1) break;
          j = next;
          clusterEnd = j;
        }
        // local peak within cluster
        let localPeakIdx = clusterStart, localPeakVal = corr[clusterStart];
        for (let k = clusterStart; k <= clusterEnd; k++) {
          if (corr[k] > localPeakVal) { localPeakVal = corr[k]; localPeakIdx = k; }
        }
        if (localPeakIdx - lastPeak >= minSepSamples) {
          positions.push(localPeakIdx);
          lastPeak = localPeakIdx;
        }
        i = clusterEnd + 1;
      } else {
        i++;
      }
    }
    return { positions, corr };
  }

  return {
    SAMPLE_RATE, F_LOW, F_HIGH, BANDWIDTH, N_SYMBOLS,
    GUARD_FRACTION, SYNC_GUARD_FRACTION,
    textToSymbols, symbolsToText,
    crc32, textToBytes, crc32ToSymbols, symbolsToCrc32,
    eccRepFactor, applyRepetition, undoRepetitionMajorityVote,
    bpsToSymbolDuration,
    makeRealUpChirp, makeRealDownChirp, makeComplexUpChirp, iqDemodulate,
    cyclicShift, applyFade,
    fft, nextPow2, buildSymbolToBinTable,
    fftCorrelate, findSyncPositions,
  };
})();
