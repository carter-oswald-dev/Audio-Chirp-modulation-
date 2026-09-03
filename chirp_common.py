"""
Shared chirp-spread-spectrum (CSS) parameters and waveform generation.
This is a simplified LoRa-style scheme:

  - A base "up-chirp" sweeps linearly from f_low to f_high over T seconds.
  - Each 5-bit symbol (0-31) is encoded as a CYCLIC SHIFT of that base chirp
    in time: symbol value s -> shift the chirp's starting phase/frequency
    by s/32 of the sweep.
  - A distinct, unshifted "sync chirp" (actually a down-chirp, so it's
    trivially distinguishable from any data symbol) marks the start of
    each message repeat, giving the decoder unambiguous alignment even
    with clock drift/timing offset between the two phones.

Demodulation (in the decoder) works by multiplying the received signal by
the CONJUGATE base chirp ("dechirping"), which turns a cyclically-shifted
chirp into a pure tone whose frequency directly encodes the cyclic shift
-> an FFT peak position gives you the symbol value. This is robust to
modest timing offsets and doesn't require carrier-phase coherence.
"""

import numpy as np

# ---- Core parameters (keep encoder and decoder in lockstep) ----
SAMPLE_RATE = 48000          # Hz — matches iPhone Voice Memos lossless capture
F_LOW = 1000.0                # Hz — bottom of chirp sweep
F_HIGH = 4000.0               # Hz — top of chirp sweep
BANDWIDTH = F_HIGH - F_LOW    # Hz
SYMBOL_DURATION = 1.0         # seconds per symbol (slow + robust, per design goal)
N_SYMBOLS = 32                # 5-bit alphabet size (2^5)
GUARD_SILENCE = 0.15          # seconds of silence between symbols (helps with
                              # reverberation/multipath smearing between symbols)
SYNC_GUARD_SILENCE = 0.3      # slightly longer gap after the sync chirp

SAMPLES_PER_SYMBOL = int(SYMBOL_DURATION * SAMPLE_RATE)


def make_base_upchirp(duration=SYMBOL_DURATION, sr=SAMPLE_RATE,
                       f_low=F_LOW, f_high=F_HIGH):
    """
    Generate one base up-chirp: linear frequency sweep f_low -> f_high
    over `duration` seconds, phase-continuous (starts and ends at 0 phase
    reference), unit amplitude.
    """
    n = int(duration * sr)
    t = np.arange(n) / sr
    k = (f_high - f_low) / duration  # chirp rate, Hz/s
    # instantaneous phase = 2*pi*(f_low*t + 0.5*k*t^2)
    phase = 2 * np.pi * (f_low * t + 0.5 * k * t * t)
    return np.sin(phase)


def make_base_downchirp(duration=SYMBOL_DURATION, sr=SAMPLE_RATE,
                         f_low=F_LOW, f_high=F_HIGH):
    """Down-chirp (f_high -> f_low), used as the distinct sync marker."""
    n = int(duration * sr)
    t = np.arange(n) / sr
    k = (f_low - f_high) / duration
    phase = 2 * np.pi * (f_high * t + 0.5 * k * t * t)
    return np.sin(phase)


def cyclic_shift_chirp(base_chirp, symbol_value, n_symbols=N_SYMBOLS):
    """
    Encode `symbol_value` (0 .. n_symbols-1) as a cyclic time-shift of the
    base chirp. Shifting circularly (wrap-around) keeps every symbol
    waveform the same energy/bandwidth — only the wrap point differs.
    """
    n = len(base_chirp)
    shift_samples = int(round((symbol_value / n_symbols) * n))
    return np.roll(base_chirp, shift_samples)


def make_complex_base_upchirp(duration=SYMBOL_DURATION, sr=SAMPLE_RATE,
                               f_low=F_LOW, f_high=F_HIGH):
    """
    Complex (analytic-signal) version of the base up-chirp, used ONLY for
    the receiver's dechirp/demodulation math. Multiplying two REAL sine
    chirps together produces sum+difference frequency terms (a classic
    trig product-to-sum artifact) that corrupts the symbol readout, so the
    receiver reconstructs this complex reference internally even though
    the transmitted/recorded signal itself is real-valued audio.
    """
    n = int(duration * sr)
    t = np.arange(n) / sr
    k = (f_high - f_low) / duration
    phase = 2 * np.pi * (f_low * t + 0.5 * k * t * t)
    return np.exp(1j * phase)


def build_symbol_to_bin_table(n_symbols=N_SYMBOLS, duration=SYMBOL_DURATION,
                               sr=SAMPLE_RATE, f_low=F_LOW, f_high=F_HIGH):
    """
    Precompute the exact FFT bin (of the complex dechirp product) that each
    symbol value maps to, by simulating the encode+dechirp process directly
    rather than relying on a closed-form formula. This makes the mapping
    robust to any rounding/parameter quirks, since encoder and decoder both
    consult the SAME table (derived from the SAME parameters).

    Returns: dict {symbol_value: fft_bin_index}, and the inverse
             {fft_bin_index: symbol_value} for direct lookup on decode.
    """
    n = int(duration * sr)
    base_complex = make_complex_base_upchirp(duration, sr, f_low, f_high)
    symbol_to_bin = {}
    for s in range(n_symbols):
        shift_samples = int(round((s / n_symbols) * n))
        shifted = np.roll(base_complex, shift_samples)
        dechirped = shifted * np.conj(base_complex)
        spectrum = np.abs(np.fft.fft(dechirped))
        peak_bin = int(np.argmax(spectrum))
        symbol_to_bin[s] = peak_bin
    bin_to_symbol = {v: k for k, v in symbol_to_bin.items()}
    return symbol_to_bin, bin_to_symbol


def apply_fade(waveform, sr=SAMPLE_RATE, fade_ms=5):
    """
    Apply a short raised-cosine fade in/out to avoid clicks at symbol
    boundaries (clicks add broadband energy that can interfere with
    neighboring symbols' correlation and are just generally bad practice
    for acoustic transmission).
    """
    fade_n = int(sr * fade_ms / 1000)
    if fade_n * 2 >= len(waveform):
        return waveform
    win = np.ones(len(waveform))
    ramp = 0.5 * (1 - np.cos(np.linspace(0, np.pi, fade_n)))
    win[:fade_n] = ramp
    win[-fade_n:] = ramp[::-1]
    return waveform * win
