# vr-visuals

Real-time video effects written as GLSL shaders, chained together. Plain HTML + JavaScript + WebGL2: no frameworks, no npm, no build step.

## Run it

You need **git**, **Python 3.7 or newer** (standard library only, nothing to `pip install`) and a browser with WebGL2 (current Chrome, Firefox, Edge or Safari).

Check what you have:

```
git --version
python3 --version      # Windows: python --version  (or: py --version)
```

If one is missing, install it:

| OS | git | Python |
|---|---|---|
| Ubuntu / Debian | `sudo apt install git` | `sudo apt install python3` |
| macOS | `xcode-select --install` | `brew install python` (or from python.org) |
| Windows | [git-scm.com](https://git-scm.com/download/win) | [python.org](https://www.python.org/downloads/) (tick "Add python.exe to PATH") |

Get the code and start the server:

```
git clone https://github.com/bastak/vr-visuals
cd vr-visuals
python3 serve.py       # Windows: python serve.py  (or: py serve.py)
```

Open http://localhost:8000, click **Webcam** (allow camera access when the browser asks) or pick / drop a video file (put your test videos in `videos/`; they are not committed). Stop the server with Ctrl+C.

If port 8000 is taken (`OSError: [Errno 98] Address already in use`, or the page asks for a password / shows something else), use another port: `python3 serve.py --port 8001`, then open http://localhost:8001.

Use `localhost` in the address, not your machine's IP: browsers only allow the webcam on `localhost` or HTTPS pages, and the server only listens on `localhost` anyway.

If you have several cameras, a dropdown next to **Webcam** lets you pick one. The panel shows the effect chain, one checkbox per effect, and the `eff_int` slider. **auto** makes `eff_int` build up slowly while the image is still and drop fast when it moves. Press **H** to hide the panel.

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

## On the Quest (headset mode)

The headset's cameras can only be used on a secure page, so open the **GitHub Pages URL** in the Quest Browser. For your own laptop's server, connect the Quest by USB with developer mode on, run `adb reverse tcp:8000 tcp:8000`, and open `http://localhost:8000` on the Quest.

1. Allow camera access: in the Quest Browser's settings/permissions, allow **Headset cameras** (otherwise only the avatar camera is offered).
2. Tap **Webcam**, allow access, and pick the passthrough camera (e.g. "camera 1 ... facing back") in the dropdown that appears.
3. Tap **Enter VR**. The processed camera image fills your view. Press the Meta/menu button to leave.
4. Line the image up with the room using the controller thumbsticks (tilt them; no buttons needed):
   - **Left stick forward/back = image size**: adjust until objects look as big as they really are.
   - **Right stick = move the image** up/down/left/right until it sits exactly over the real room.
   - **Left stick left/right = camera delay**: turn your head side to side; adjust until the image stays still in the room instead of lagging behind or running ahead.
   - **Click a stick** (press it down) to reset that stick's settings.
   While you adjust, a text display shows the values and the image turns half see-through, so you can match it against the real passthrough behind it. The values are remembered and also shown as sliders in the panel.

`eff_int` auto mode uses **head motion** in the headset (it drops when you turn your head, builds up when you hold still).

The panel shows the camera resolution and frame rate, and the render frame rate. Check these first if something looks jerky.

Known limits for now: one camera is shown to both eyes (no depth). The image is turned to stay put in the room between camera frames, but only for rotation, so nearby things can still shift a little when you move your head sideways. On a fast turn you briefly see the edge of the image. Effects still hot-reload while you are inside. Needs Quest 3 / 3S with recent software; this is reported by other developers, not yet checked on our headset.

## Hosted version

Every push to `main` deploys the site to GitHub Pages via `.github/workflows/pages.yml` (it generates `effects.json`, which `serve.py` otherwise produces on the fly).
