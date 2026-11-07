// <Effect name>: one or two sentences on what the viewer sees.
// This top comment block is the description shown when you click the effect's
// name in the panel; it ends at the first line that is not a comment (keep the
// blank line below). An empty "//" line starts a new paragraph.

// Effect template: copy this file to effects/<your_name>.glsl and edit the copy.
// Files starting with "_" are ignored by the harness.
//
// Your file must define:   vec4 effect(vec2 uv)
// (helper functions above it are fine). uv is 0..1, (0,0) = bottom-left.
// The harness provides these uniforms; do not declare them yourself:
//   sampler2D u_tex    previous effect's output (or the video frame)
//   sampler2D u_prev   this effect's own output from the last frame (feedback)
//   float     u_time   seconds
//   float     u_dt     seconds since the previous frame (max 0.1)
//   vec2      u_look   scene shift from head rotation (uv); sample at uv - u_look to stick to the scene
//   vec2      u_gaze   head turn direction, -1..1 (+x right, +y up), recenters at rest
//   float     eff_int  0..1 effect intensity
//   vec2      u_res    output size in pixels
//   vec4      u_heads[8], float u_headRoll[8], int u_headCount
//                      faces in the image (see README); head tracking only runs
//                      while an enabled effect uses u_heads
//
// Optional sliders in the panel: declare a float uniform with min, max, default
// and a description (shown when you click the slider's name). Comment-only lines
// directly below continue the description:
//   uniform float my_amount; // @param 0 1 0.5 How strongly the image swirls.
// A dropdown instead (the uniform is the option's index, the first is the default):
//   uniform float my_style; // @choice waves|spirals Which pattern appears.
//
// Rules:
// - eff_int = 0 must give output identical to the input, including any
//   feedback state (e.g. mix toward texture(u_tex, uv) as eff_int -> 0).
// - Keep it cheap: runs on a headset at 72 fps, about 6 effects at once.
//   No flicker or strobing.
// - Only edit your own effect file. Only the integrator edits order.txt.
//   Push only when your effect runs in your local harness.

vec4 effect(vec2 uv) {
    return texture(u_tex, uv);
}
