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

If you have several cameras, a dropdown next to **Webcam** lets you pick one. The panel shows the effect chain, one checkbox per effect (all unticked when the page loads: tick the ones you want) (plus a **parameters** button next to it if the effect declares sliders; it opens or closes the list), and the `eff_int` slider. Click an effect's or a slider's name to see its description. **auto** makes `eff_int` build up slowly while the image is still (in the headset: while your head is still) and drop when it moves; **drop time** sets how fast it falls and **drop depth** how far (default 0.8 = a full effect sinks to 0.2 at most). Double-click either slider to reset it. Press **H** to hide the panel.

Saving an effect file updates the page within about a second. Compile errors appear next to the effect's name, with line numbers from your file; that effect is skipped and the rest keep running.

## Add an effect

1. Copy `effects/_template.glsl` to `effects/<your_name>.glsl`.
2. Replace the first comment block with a short description of what the viewer sees. Clicking the effect's name in the panel shows it. The block ends at the first non-comment line; an empty `//` line starts a new paragraph.
3. Edit `vec4 effect(vec2 uv)` (helper functions above it are fine). Available uniforms:

| uniform | meaning |
|---|---|
| `sampler2D u_tex` | previous effect's output (or the video frame) |
| `sampler2D u_prev` | this effect's own output from the last frame (for feedback) |
| `float u_time` | seconds |
| `float u_dt` | seconds since the previous frame (use it to make feedback frame-rate independent) |
| `vec2 u_look` | how far the scene has shifted across the image because the head turned, in uv units. Sample a pattern at `uv - u_look` to keep it attached to the scene. Flat page: drag on the video to simulate. |
| `vec2 u_focus` | uv of the main object in view (biggest / closest-looking, moving things favored), eases after it on a smooth spring (~1 s). Heuristic, no depth camera. |
| `vec2 u_focusVel` | velocity of `u_focus` in uv per second (0 when it rests). Use it to let things trail behind the moving focus. |
| `vec2 u_gaze` | which way the head is turning, -1..1 per axis (+x right, +y up), settles back to 0 when the head rests |
| `float eff_int` | intensity, 0..1 |
| `vec2 u_res` | output size in pixels |
| `vec4 u_heads[8]` | faces found in the image: `xy` = centre (uv), `z` = radius (half the face box, in units of the image height), `w` = 0..1 fade in/out |
| `float u_headRoll[8]` | tilt of each face's eye line, radians (counter-clockwise) |
| `int u_headCount` | number of valid entries in `u_heads` |

`uv` runs 0..1 with (0,0) at the bottom-left. Files starting with `_` are ignored.

Head tracking (`heads.js`) only runs while an enabled effect uses `u_heads`. The first time, it loads Google's MediaPipe face detector from the internet (a few MB). It finds faces toward the camera, and (via pose) people farther away or seen from the side. The stats line shows how many heads it sees and how long a detection takes. See `effects/head_masks.glsl` for an example.

### Effect parameters (sliders)

To get a slider for your effect in the panel, declare a `float` uniform in your file with an `@param` comment giving min, max, default and a description. Comment-only lines directly below continue the description:

```glsl
uniform float colorfulness; // @param -1 1 0 Grey dream at -1, original colours at 0, saturated scene
                            // with rainbow-tinted patterns at 1.
```

Clicking the slider's name shows the description. The slider appears in the list behind your effect's **parameters** button and the harness sets the uniform every frame. Double-click a slider to reset it to the default. The rule above still holds: with `eff_int = 0` the output must equal the input whatever the sliders say.

For a slider that only takes whole numbers (a count), use `@int` instead of `@param`; min and max must be whole numbers. To show a parameter only for one setting of another, add a comment line directly below it, e.g. `// @when mask=multiply` (an option name for a `@choice`, or a number); that line is not part of the description.

For a dropdown instead of a slider, use `@choice` with the options separated by `|`. The uniform gets the index of the selected option (0, 1, 2, ...), and the first option is the default. In the shader, use `int(mask + 0.5)`:

```glsl
uniform float mask; // @choice pumpkin|skull|pig Which mask covers the faces.
```

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

**Stereo (depth):** tick **stereo (both cameras)** after starting the webcam. The left headset camera then goes to the left eye and the right camera to the right eye; the status line and stats say whether both cameras opened ("stereo on (L: ..., R: ...)") or why not (then it falls back to one camera for both eyes). In VR, if the two eye images don't fuse comfortably, **hold a trigger and use the right stick**: left/right = separation, forward/back = vertical mismatch (click the stick while holding the trigger to reset). If depth looks inside-out, tick **swap eyes**.

**Eye check (which camera is which):** which Quest camera is left and which is right is a guess (the first by name, usually "camera 1, facing back", is used for the left eye). To check it in VR, press **A or X**: both eyes now see only **camera A** (the one shown as L), press again for only **camera B**, a third time for normal stereo. Hold a finger about 20 cm in front of your face and flip between A and B: the camera that shows your finger further to the **right** (compared with the background) is the **left** camera. If that is camera B, tick **swap eyes** (in the panel, before entering VR). Stereo runs the effect chain twice (once per eye), so it costs about twice the GPU time; watch the render fps in the stats line.

**Soft edges:** the overlay fades into the passthrough at its border (**edge fade** in the Headset panel section, in degrees; 0 = hard edge). The cameras point a bit downward, so above the image there is passthrough the camera cannot see; the fade hides that seam.

**Near objects vs far objects (match distance):** each Quest camera sits a few cm away from your eye (in front of it, a little lower/sideways), so without depth information the overlay can only line up with the real world at one distance. The page models where the camera sits and lines things up exactly at the **match distance**; objects much nearer or farther are a bit off. Hold the **grip** (side button under your middle finger) to set it: **left stick** fwd/back = match distance, left/right = camera height; **right stick** left/right = camera sideways offset, fwd/back = camera forward offset; click a stick while holding grip to reset. To tune (with stereo sep. / vert. at 0, one eye closed):
1. Look at something far (3 m or more) and line it up with size (left stick) and move (right stick).
2. Look at something about 0.5 m away. Hold grip and set the match distance to roughly that distance, then adjust the camera offsets until the near object lines up too, across the whole view (forward offset fixes "matches at the edge but not in the middle", sideways offset fixes an even shift).
3. Open the other eye and check; the sideways offset is mirrored for the two eyes.
4. Finally set the match distance to the distance you mostly look at.

`eff_int` auto mode uses **head motion** in the headset (it drops when you turn your head, builds up when you hold still).

The panel shows the camera resolution and frame rate, and the render frame rate. Check these first if something looks jerky.

Known limits for now: without stereo, one camera is shown to both eyes (no depth). The image is turned to stay put in the room between camera frames, but only for rotation, so nearby things can still shift a little when you move your head sideways. On a fast turn you briefly see the edge of the image. Effects still hot-reload while you are inside. Needs Quest 3 / 3S with recent software; this is reported by other developers, not yet checked on our headset.

## Hosted version

Every push to `main` deploys the site to GitHub Pages via `.github/workflows/pages.yml` (it generates `effects.json`, which `serve.py` otherwise produces on the fly).
