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
//   float     eff_int  0..1 effect intensity
//   vec2      u_res    output size in pixels
//
// Optional sliders in the panel: declare a float uniform with min, max, default:
//   uniform float my_amount; // @param 0 1 0.5
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
