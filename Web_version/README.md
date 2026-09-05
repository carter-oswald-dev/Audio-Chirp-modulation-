# Acoustic Link

Send short text messages through the air as sound. One phone plays a WAV file
through its speaker; another phone records it with its microphone; this page
recovers the text afterward — entirely in your browser, nothing uploaded
anywhere.

Built on chirp-spread-spectrum modulation (the same family of technique used
by LoRa radios and GPS): text becomes 5-bit Baudot code, each symbol becomes
a cyclically time-shifted chirp, and a distinct down-sweep marks the start of
each repeat so the decoder can find its place in a recording that starts at
an arbitrary time.

## Try it

Open `index.html` in a browser — no build step, no server required for local
use (though decoding requires loading it via `http://` rather than
`file://` in some browsers, due to Web Audio API restrictions; use the
`python3 -m http.server` trick below if you hit that).

## Deploy to GitHub Pages

1. Create a new GitHub repository (or use an existing one).
2. Add these three files to the repository root:
   - `index.html`
   - `app.js`
   - `chirp-codec.js`
3. Commit and push.
4. In the repo's **Settings → Pages**, set the source to your default branch
   (root folder).
5. GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`
   within a minute or two.

## Local testing before deploying

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/` in a browser.

## Files

| File              | Purpose                                                        |
|-------------------|-----------------------------------------------------------------|
| `index.html`      | UI layout and styling                                          |
| `chirp-codec.js`  | Core DSP: Baudot encoding, CRC32, chirp modulation/demodulation, FFT, sync correlation |
| `app.js`          | Wires the UI to the codec: live readout, WAV encode/playback/download, WAV decode with auto-detection |
| `test_codec.js`   | Node.js unit tests for the codec (run with `node test_codec.js`) |
| `test_integration.js` | Node.js end-to-end tests mirroring the app's actual encode/decode logic (run with `node test_integration.js`) |

The two test files aren't needed for the site to function — they're
developer tools for verifying the DSP logic. You can leave them out of the
GitHub Pages deployment if you'd rather keep the published site to just the
three core files, or leave them in; they won't be linked from `index.html`
either way.

## Notes on the distance-based rate suggestion

The "suggested rate at target distance" figure is a rough physical estimate
(spreading loss + assumed typical outdoor ambient noise + assumed phone
speaker output), not a measured or guaranteed number. Real outdoor
conditions — wind, other noise sources, mic placement, speaker volume —
vary considerably. Treat it as a starting point to test from, not a promise.

## Auto-detect decoding

If you don't know (or didn't record) the exact settings used to encode a
message, toggle off "I know the encoding settings used" before decoding.
The decoder will try a set of candidate data rates, pick the one with the
strongest sync-chirp correlation, then try error-correction levels from
none up to maximum — favoring whichever combination makes the CRC32
checksum (if one was included) validate.
