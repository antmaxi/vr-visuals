# vr-visuals

Real-time video effects written as GLSL shaders, chained together. Plain HTML + JavaScript + WebGL2: no frameworks, no npm, no build step.

## Run it

```
python3 serve.py
```

Open http://localhost:8000, click **Webcam** or pick / drop a video file (put your test videos in `videos/`; they are not committed).

The panel shows the effect chain, one checkbox per effect, and the `eff_int` slider. **auto** makes `eff_int` build up slowly while the image is still and drop fast when it moves. Press **H** to hide the panel.

Saving an effect file updates the page within about a second. Compile errors appear next to the effect's name, with line numbers from your file; that effect is skipped and the rest keep running.

## Add an effect

1. Copy `effects/_template.glsl` to `effects/<your_name>.glsl`.
2. Edit `vec4 effect(vec2 uv)` (helper functions above it are fine). Available uniforms:

| uniform | meaning |
|---|---|
| `sampler2D u_tex` | previous effect's output (or the video frame) |
| `sampler2D u_prev` | this effect's own output from the last frame (for feedback) |
| `float u_time` | seconds |
| `float eff_int` | intensity, 0..1 |
| `vec2 u_res` | output size in pixels |

`uv` runs 0..1 with (0,0) at the bottom-left. Files starting with `_` are ignored.

## Rules

- `eff_int = 0` must give output identical to the input, including any feedback state.
- Keep effects cheap: they will run on a headset at 72 fps, about 6 at once. No flicker or strobing.
- Only edit your own effect file. Only the integrator edits `order.txt`. Push only when your effect runs in your local harness.

## Chain order (`effects/order.txt`)

Optional, one filename per line (the integrator's file). Effects listed there run first, in that order. Any other effect runs after them, alphabetically. Names that don't exist are ignored; blank lines and lines starting with `#` are skipped. Without `order.txt` everything runs alphabetically. The panel shows the resulting order.

## Git, for people new to it

```
git pull                                   # 1. get everyone's latest changes
# 2. edit ONLY effects/<your_name>.glsl, check it in the harness
git add effects/<your_name>.glsl           # 3. stage your file
git commit -m "Update <your_name> effect"  # 4. save a snapshot
git push                                   # 5. share it (if rejected: git pull, then push again)
```

## Hosted version

Every push to `main` deploys the site to GitHub Pages via `.github/workflows/pages.yml` (it generates `effects.json`, which `serve.py` otherwise produces on the fly).
