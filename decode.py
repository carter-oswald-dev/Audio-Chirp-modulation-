"""
Decoder: takes a recorded WAV (e.g. from iPhone Voice Memos, converted to
WAV/PCM) and recovers the original text.

This is designed to be run OFFLINE on your laptop after recording, not in
real time — matching the workflow where the phone just captures faithfully
and all the clever processing happens afterward.

Pipeline:
  1. Load audio, resample to the reference SAMPLE_RATE if needed.
  2. Find sync chirps (down-chirps) via cross-correlation against a
     reference down-chirp. This locates the start of each message repeat
     even with clock drift / arbitrary recording start offset.
  3. For each repeat found, slice out the expected symbol windows following
     the sync chirp.
  4. Dechirp each symbol window (multiply by conjugate base up-chirp) and
     take an FFT: the peak bin location directly gives the cyclic shift,
     i.e. the symbol value.
  5. Average the FFT magnitude across all repeats for each symbol position
     BEFORE picking the peak (non-coherent integration) -- this is what
     buys you SNR gain from repeating the message.
  6. Convert recovered symbols back to text via Baudot table.

Usage:
    python3 decode.py recorded.wav --expected-symbols 11
    (--expected-symbols is optional but helps validate repeat detection;
     omit it if you don't know / just want best-effort decode)
"""

import argparse
import numpy as np
from scipy.io import wavfile
from scipy import signal as sig

from baudot import symbols_to_text
from chirp_common import (
    SAMPLE_RATE, SYMBOL_DURATION, GUARD_SILENCE, SYNC_GUARD_SILENCE,
    N_SYMBOLS, SAMPLES_PER_SYMBOL, make_base_upchirp, make_base_downchirp,
    make_complex_base_upchirp, build_symbol_to_bin_table,
)


def load_audio_mono(path, target_sr=SAMPLE_RATE):
    sr, data = wavfile.read(path)
    if data.ndim > 1:
        data = data.mean(axis=1)  # downmix to mono if stereo
    data = data.astype(np.float64)
    # normalize by dtype max so we work in a consistent [-1,1]-ish range
    if np.issubdtype(np.asarray(data).dtype, np.floating):
        pass
    else:
        pass
    maxval = np.max(np.abs(data)) if np.max(np.abs(data)) > 0 else 1.0
    data = data / maxval

    if sr != target_sr:
        n_new = int(len(data) * target_sr / sr)
        data = sig.resample(data, n_new)
        sr = target_sr
    return sr, data


def find_sync_positions(data, sr, min_separation_sec=2.0, corr_threshold_ratio=0.35):
    """
    Cross-correlate the received audio against the reference down-chirp to
    find sync markers. Returns a list of sample indices (start of each
    detected sync chirp).

    corr_threshold_ratio: peaks must be at least this fraction of the
    strongest peak found, to reject spurious low-level correlations while
    still catching all real syncs even if repeats have varying SNR.
    """
    ref = make_base_downchirp(sr=sr)
    # Matched filter via correlation. Use 'valid' mode via correlate, but
    # for long recordings, np.correlate can be slow -- fftconvolve is fast.
    corr = sig.fftconvolve(data, ref[::-1], mode='valid')
    corr_env = np.abs(corr)

    peak_val = np.max(corr_env)
    if peak_val <= 0:
        return [], corr_env

    threshold = peak_val * corr_threshold_ratio
    min_sep_samples = int(min_separation_sec * sr)

    # simple greedy peak picking: find all local maxima above threshold,
    # separated by at least min_sep_samples
    candidate_idxs = np.where(corr_env > threshold)[0]
    if len(candidate_idxs) == 0:
        return [], corr_env

    peaks = []
    last_peak = -min_sep_samples
    i = 0
    while i < len(candidate_idxs):
        # find the local max within this contiguous-ish cluster
        cluster_start = candidate_idxs[i]
        cluster_end = cluster_start
        j = i
        while j + 1 < len(candidate_idxs) and candidate_idxs[j+1] - candidate_idxs[j] < sr * 0.05:
            j += 1
            cluster_end = candidate_idxs[j]
        cluster_slice = corr_env[cluster_start:cluster_end+1]
        local_peak_offset = np.argmax(cluster_slice)
        local_peak_idx = cluster_start + local_peak_offset

        if local_peak_idx - last_peak >= min_sep_samples:
            peaks.append(local_peak_idx)
            last_peak = local_peak_idx
        i = j + 1

    return peaks, corr_env


def dechirp_symbol_fft(segment, base_up_complex, sr=SAMPLE_RATE, n_symbols=N_SYMBOLS):
    """
    Dechirp one symbol-length segment and return the FULL complex-FFT
    magnitude spectrum (all n bins, since symbol info is encoded via
    circular shift and can map to any bin, not just the non-negative
    frequency half).

    The received segment is real-valued audio; we convert it to an
    analytic signal (Hilbert transform) so the multiply against the
    complex reference chirp cleanly collapses to a single tone rather
    than producing the sum+difference artifacts that plague a
    real-times-real dechirp.
    """
    n = len(base_up_complex)
    if len(segment) < n:
        segment = np.pad(segment, (0, n - len(segment)))
    else:
        segment = segment[:n]

    analytic = sig.hilbert(segment)  # real audio -> complex analytic signal
    dechirped = analytic * np.conj(base_up_complex)
    spectrum = np.abs(np.fft.fft(dechirped))
    return spectrum


def decode_wav(path, expected_symbols=None, sr_ref=SAMPLE_RATE, verbose=True):
    sr, data = load_audio_mono(path, target_sr=sr_ref)
    duration = len(data) / sr
    if verbose:
        print(f"Loaded {path}: {duration:.1f}s @ {sr}Hz")

    sync_positions, corr_env = find_sync_positions(data, sr)
    if verbose:
        print(f"Found {len(sync_positions)} sync chirp(s) at "
              f"{[round(p/sr,2) for p in sync_positions]} sec")

    if len(sync_positions) == 0:
        print("ERROR: no sync chirps detected. Check recording / SNR.")
        return None, sync_positions, corr_env

    base_up = make_base_upchirp(sr=sr)  # real chirp, used only for sync-window sizing
    base_up_complex = make_complex_base_upchirp(sr=sr)  # used for actual dechirp math
    symbol_to_bin, bin_to_symbol = build_symbol_to_bin_table(sr=sr)
    samples_per_symbol = len(base_up)
    sync_chirp_samples = samples_per_symbol  # sync chirp is the same duration as a data symbol
    guard_samples = int(GUARD_SILENCE * sr)
    sync_guard_samples = int(SYNC_GUARD_SILENCE * sr)
    step = samples_per_symbol + guard_samples

    n_syms = expected_symbols  # may be None
    accumulated_spectra = None  # list of accumulators, one per symbol position

    valid_repeats = 0
    for rep_i, sync_idx in enumerate(sync_positions):
        # sync_idx marks the START of the sync chirp; the first data symbol
        # begins after the full sync chirp PLUS its trailing guard silence.
        start = sync_idx + sync_chirp_samples + sync_guard_samples
        # If we don't know expected_symbols yet, try to infer from spacing to
        # next sync; otherwise just decode a generous max and trim later.
        if n_syms is not None:
            this_n_syms = n_syms
        else:
            if rep_i + 1 < len(sync_positions):
                available = sync_positions[rep_i+1] - start
            else:
                available = len(data) - start
            this_n_syms = max(0, available // step)

        if accumulated_spectra is None:
            accumulated_spectra = [None] * this_n_syms

        ok_repeat = True
        per_repeat_spectra = []
        for k in range(this_n_syms):
            seg_start = start + k * step
            seg_end = seg_start + samples_per_symbol
            if seg_end > len(data):
                ok_repeat = False
                break
            segment = data[seg_start:seg_end]
            spectrum = dechirp_symbol_fft(segment, base_up_complex, sr=sr)
            per_repeat_spectra.append(spectrum)

        if not ok_repeat:
            if verbose:
                print(f"  repeat {rep_i}: truncated (ran off end of recording), skipping")
            continue

        valid_repeats += 1
        for k, spectrum in enumerate(per_repeat_spectra):
            if accumulated_spectra[k] is None:
                accumulated_spectra[k] = spectrum.copy()
            else:
                accumulated_spectra[k] += spectrum  # non-coherent (magnitude) accumulation

    if verbose:
        print(f"Used {valid_repeats} of {len(sync_positions)} detected repeats "
              f"for accumulation")

    if accumulated_spectra is None or valid_repeats == 0:
        print("ERROR: no complete repeats decoded.")
        return None, sync_positions, corr_env

    # Map each accumulated spectrum's peak bin back to a symbol value 0..31
    # using the EXACT lookup table built by simulating encode+dechirp with
    # the same parameters (robust to any rounding/edge quirks, since both
    # sides of the table come from the same simulation).
    valid_bins = np.array(sorted(bin_to_symbol.keys()))

    symbols = []
    confidences = []
    for k, spectrum in enumerate(accumulated_spectra):
        # restrict search to only the bins that are valid symbol targets —
        # this rejects noise energy landing in "impossible" bins and only
        # asks "which of the 32 known-valid bins is strongest"
        candidate_mags = spectrum[valid_bins]
        best_idx = np.argmax(candidate_mags)
        peak_bin = valid_bins[best_idx]
        peak_val = candidate_mags[best_idx]
        mean_val = np.mean(candidate_mags)
        confidence_db = 10 * np.log10((peak_val + 1e-12) / (mean_val + 1e-12))

        symbol_est = bin_to_symbol[int(peak_bin)]
        symbols.append(symbol_est)
        confidences.append(confidence_db)

    if verbose:
        print(f"Recovered symbols: {symbols}")
        print(f"Per-symbol peak confidence (dB above mean spectrum floor): "
              f"{[round(c,1) for c in confidences]}")

    text = symbols_to_text(symbols)
    if verbose:
        print(f"Recovered text: {text!r}")

    return text, sync_positions, corr_env, symbols, confidences


def main():
    ap = argparse.ArgumentParser(description="Decode chirp-modulated audio to text")
    ap.add_argument("wav_path", help="Path to recorded WAV file")
    ap.add_argument("--expected-symbols", type=int, default=None,
                     help="Number of symbols per repeat, if known (helps "
                          "robustness). Omit to auto-infer from sync spacing.")
    args = ap.parse_args()

    decode_wav(args.wav_path, expected_symbols=args.expected_symbols)


if __name__ == "__main__":
    main()
