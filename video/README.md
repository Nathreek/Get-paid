# Explainer video

`explainer.html` is the whole video: an animation driven by `render(t)` (seconds). `render.mjs` steps through it at 30 fps in headless Chrome and pipes the frames to ffmpeg.

Requires Node.js, ffmpeg on PATH, and Chrome or Edge (or set `CHROME_PATH`).

```sh
cd video
npm install
npm run render                 # writes ../get-paid-explainer.mp4 (about 3 min)
npm run stills -- 9.5 25 40    # still frames at those seconds, to check a scene quickly
open explainer.html            # or open it in a browser to preview in real time
```

## Adding a scene

1. Add a `<section class="scene" id="sN">` with a `.copy` block (eyebrow, `h1` lines, `.sub`) and a `.visual` block.
2. Add `['sN', start, end]` to `S` and shift the later scenes; update `DURATION`.
3. Add `R.sN(t)` to animate the visual (`t` is seconds since the scene started). The copy animates in and the scene blurs out on its own.

Helpers: `appear(el, t, at)` fades/slides in, `pop(el, t, at)` scales in with overshoot, `pr(t, a, b)` gives 0→1 progress, `eo`/`eio`/`back` are easings.

The QR code (`qr.svg`) is regenerated from `SITE_URL` in `render.mjs` on every run.
