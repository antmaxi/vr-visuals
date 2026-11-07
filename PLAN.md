Create a minimal repo for a one-day team project: real-time video effects written as GLSL shaders, chained together, later shown on a Meta Quest. Keep it as small and plain as possible: no frameworks, no npm, no build step. Plain HTML + JavaScript + WebGL2.



STRUCTURE

\- index.html, harness.js: the test page

\- serve.py: tiny dev server (Python standard library only)

\- effects/: one .glsl file per effect; files starting with "\_" are ignored

\- effects/order.txt: optional chain order (see below)

\- videos/: local test videos, git-ignored

\- README.md, .gitignore



EFFECT CONTRACT

Each effect file contains only one function:

&#x20;   vec4 effect(vec2 uv)

The harness turns it into a full WebGL2 fragment shader by prepending a shared header that declares:

&#x20;   uniform sampler2D u\_tex;   // previous effect's output (or the video frame)

&#x20;   uniform sampler2D u\_prev;  // this effect's own output from the last frame (for feedback effects)

&#x20;   uniform float u\_time;

&#x20;   uniform float eff\_int;     // 0..1

&#x20;   uniform vec2 u\_res;

and appending a main() that calls effect(). Compile errors must report line numbers as they appear in the effect file itself.



HARNESS PAGE

\- Input: a webcam button, or pick / drag-drop a video file (looping).

\- Discover effects by fetching effects.json (a list of .glsl filenames).

\- Chain order: if effects/order.txt exists (one filename per line), those effects run first, in that order. Any discovered effect not listed runs after them, alphabetically. Names in order.txt that don't exist are ignored. Show the resulting order in the panel.

\- One checkbox per effect to turn it on/off, all on by default. If an effect fails to compile, show the error next to its name and skip it; the rest of the chain keeps running.

\- Global eff\_int slider (0-1), plus an "auto" checkbox: eff\_int builds up slowly while the image is still and drops fast when it moves (mean absolute frame difference on a small downscaled copy; about 0.3 s to drop, about 10 s to build up). Show the current eff\_int value.

\- Chain with render targets: each effect reads the previous effect's output and writes its own; each effect keeps its own last output for u\_prev.

\- Check the effect files and order.txt about once a second and reload anything that changed, so saving a file updates the page right away.

\- Output fills the window; controls in a small overlay panel.



SERVING

\- serve.py serves the folder at http://localhost:8000 with caching disabled and answers /effects.json with the current list of effects/\*.glsl (excluding files starting with "\_").

\- Add a GitHub Actions workflow that generates effects.json and deploys the site to GitHub Pages, so the same page works hosted. Tell me any one-time settings I need to change on GitHub.



STARTING EFFECTS

\- effects/\_template.glsl: pass-through (return texture(u\_tex, uv);) with short comments stating the rules below.

\- effects/breathing\_drift.glsl: port breathing\_drift\_warp.glsl (Shadertoy format, in this folder) to the contract: iChannel0 -> u\_tex, iTime -> u\_time, iResolution -> u\_res, remove the mouse line and use the eff\_int uniform.

\- No order.txt yet.



RULES (in README and template comments)

\- eff\_int = 0 must give output identical to the input, including any feedback state.

\- Keep effects cheap: they will run on a headset at 72 fps, about 6 at once. No flicker or strobing.

\- Only edit your own effect file. Only the integrator edits order.txt. Push only when your effect runs in your local harness.



README

How to run (python3 serve.py, open localhost:8000), how to add an effect (copy the template under a new name), how order.txt works, and a 5-line git workflow (pull, edit your file, commit, push) for people new to git.



NOT NOW

No WebXR / Quest mode yet. But keep the input source and the source of eff\_int in separate small functions, so they can later be swapped for the headset camera and head motion.



FINISH

Initialize git and make a first commit. If the GitHub CLI (gh) is installed and logged in, create a PUBLIC repo and push. Then test what you can (start the server, check effects.json, validate the shaders compile), and tell me what you could not test.

