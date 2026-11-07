# Agent instructions

Real-time video effects as GLSL shaders, chained in a plain WebGL2 page (`index.html`, `harness.js`, `xr.js`). No frameworks, no npm, no build step. See `README.md` for the effect contract and the team rules.

## Creating or changing an effect

Every effect and every effect parameter must have a description. The panel shows it in a bubble when the user clicks the effect's or parameter's name, so write it for the person watching, not for the next coder.

- **Effect description:** the comment block at the very top of `effects/<name>.glsl`. Say what the viewer sees, in one to three sentences. The block ends at the first non-comment line, so put a blank line between it and any other comments (implementation notes, knob explanations). An empty `//` line starts a new paragraph. Start from `effects/_template.glsl` and replace its first block.
- **Parameter description:** the text after min, max and default on the `@param` line. Comment-only lines directly below continue it, so don't put an unrelated comment right under a `@param` line:

  ```glsl
  uniform float eyes; // @param 0 1 0.5 Dark points in the image turn into black pupils
                      // with bright rims, like the "eyes" in DeepDream images.
  ```

  Say what the slider does at its low and high end, and mention anything non-obvious (e.g. a squared response, or settings that look bad when combined).
- **Dropdown parameters:** `uniform float <name>; // @choice a|b|c <description>` gives a dropdown; the uniform is the option's index and the first option is the default. The description follows the same rules as `@param`.
- When you change what an effect or parameter does, update its description in the same edit.

## Other rules

- `eff_int = 0` must give output identical to the input, including any feedback state.
- Keep effects cheap (headset at 72 fps, about 6 effects at once). No flicker or strobing.
- Only the integrator edits `effects/order.txt`. Effects not listed there run after the listed ones, so a new effect runs after `peripheral_emphasis` until it is added above it.
