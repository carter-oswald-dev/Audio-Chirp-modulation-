"""
Encoder: turns text into a WAV file of chirp-modulated Baudot symbols.

Usage:
    python3 encode.py "HELLO WORLD" --repeats 20 --out message.wav

Output WAV structure (per repeat):
    [sync down-chirp] [guard silence]
    [symbol 1 up-chirp, cyclic-shifted] [guard silence]
    [symbol 2 up-chirp, cyclic-shifted] [guard silence]
    ...
    [symbol N up-chirp, cyclic-shifted] [guard silence]
  -> repeated `--repeats` times back-to-back, each repeat re-synced by its
     own leading sync chirp, so the decoder can average across repeats even
     if there's timing drift between them.

The WAV is written as 16-bit PCM at 48kHz mono — a plain, universally
compatible format to play from any phone (e.g. AirDrop it to an iPhone,
or copy to Android and play with any audio player / your WAV recorder app
on the other end).
"""

import argparse
import numpy as np
from scipy.io import wavfile

from baudot import text_to_symbols
from chirp_common import (
    SAMPLE_RATE, SYMBOL_DURATION, GUARD_SILENCE, SYNC_GUARD_SILENCE,
    N_SYMBOLS, make_base_upchirp, make_base_downchirp, cyclic_shift_chirp,
    apply_fade,
)


def build_message_waveform(text, repeats=1, amplitude=0.8, sr=SAMPLE_RATE):
    symbols = text_to_symbols(text)
    print(f"Message: {text!r}")
    print(f"Symbols ({len(symbols)} total, {len(symbols)*5} bits): {symbols}")

    base_up = make_base_upchirp(sr=sr)
    base_down = make_base_downchirp(sr=sr)

    sync_chirp = apply_fade(base_down, sr=sr)
    guard = np.zeros(int(GUARD_SILENCE * sr))
    sync_guard = np.zeros(int(SYNC_GUARD_SILENCE * sr))

    one_repeat_parts = [sync_chirp, sync_guard]
    for s in symbols:
        sym_wave = cyclic_shift_chirp(base_up, s, n_symbols=N_SYMBOLS)
        sym_wave = apply_fade(sym_wave, sr=sr)
        one_repeat_parts.append(sym_wave)
        one_repeat_parts.append(guard)
    one_repeat = np.concatenate(one_repeat_parts)

    full = np.concatenate([one_repeat] * repeats)
    full = full * amplitude  # leave headroom, avoid clipping

    repeat_duration = len(one_repeat) / sr
    total_duration = len(full) / sr
    print(f"Duration per repeat: {repeat_duration:.2f}s")
    print(f"Total repeats: {repeats}  ->  total duration: {total_duration:.1f}s "
          f"({total_duration/60:.1f} min)")

    return full, symbols


def save_wav(waveform, path, sr=SAMPLE_RATE):
    # Convert float [-1,1] to 16-bit PCM
    clipped = np.clip(waveform, -1.0, 1.0)
    pcm = (clipped * 32767).astype(np.int16)
    wavfile.write(path, sr, pcm)
    print(f"Wrote {path} ({len(pcm)/sr:.1f}s, {sr}Hz, 16-bit mono PCM)")


def main():
    ap = argparse.ArgumentParser(description="Encode text as chirp-modulated audio")
    ap.add_argument("text", help="Text to encode (A-Z, space only)")
    ap.add_argument("--repeats", type=int, default=1,
                     help="Number of times to repeat the whole message "
                          "(more repeats = more integration gain on decode, "
                          "at the cost of transmission time)")
    ap.add_argument("--amplitude", type=float, default=0.8,
                     help="Output amplitude 0-1 (headroom to avoid clipping)")
    ap.add_argument("--out", default="message.wav", help="Output WAV path")
    args = ap.parse_args()

    waveform, symbols = build_message_waveform(
        args.text, repeats=args.repeats, amplitude=args.amplitude
    )
    save_wav(waveform, args.out)


if __name__ == "__main__":
    main()
