// Peripheral emphasis: the edges of the view come alive while the centre stays
// untouched. Toward the periphery the image bulges outward with slow ripples
// flowing out from the centre, gets a soft glow, stronger colour, and a hue
// shift that slowly travels around the ring.
// eff_int = 0 -> untouched image.
// radius: where the periphery starts (0 = centre, 1 = top/bottom edge).
// colour: saturation boost and hue shift in the periphery.
// bulge: how much the periphery bulges outward (tunnel feel).
// ripple_amp: how far the ripples push the image. Relative to the ripple
// spacing, so it stays smooth at any ripple_freq.
// ripple_freq: ripples between the centre and the top/bottom edge.
// bulge and ripple_amp are squared, so the top of each slider is much
// stronger than the bottom; the defaults are subtle.

uniform float radius;      // @param 0 1.2 0.45
uniform float colour;      // @param 0 1 0.6
uniform float bulge;       // @param 0 1 0.35
uniform float ripple_amp;  // @param 0 1 0.33
uniform float ripple_freq; // @param 0.5 6 2.2

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// Rotate hue by a (radians) in YIQ space; keeps brightness.
vec3 hueRotate(vec3 c, float a) {
    const mat3 TO_YIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
    const mat3 TO_RGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
    vec3 yiq = TO_YIQ * c;
    float cs = cos(a), sn = sin(a);
    yiq.yz = mat2(cs, sn, -sn, cs) * yiq.yz;
    return TO_RGB * yiq;
}

vec4 effect(vec2 uv) {
    vec3 cam = texture(u_tex, uv).rgb;
    if (eff_int <= 0.0) return vec4(cam, 1.0);

    // ---- knobs (at eff_int = 1, outer periphery) ----
    // Distances are in units where the top/bottom edge is at 1.
    const float SOFT      = 0.5;    // width of the centre -> periphery transition
    const float BULGE_MAX = 0.2;    // bulge at bulge = 1
    const float STEEP_MAX = 0.8;    // ripple slope at ripple_amp = 1; near 1 the image folds over
    const float WAVE_HZ   = 0.15;   // ripples flow outward, ~7 s per wave
    const float BLUR_R    = 2.5;    // glow radius in pixels
    const float GLOW      = 0.5;    // softening toward the blurred image
    const float BLOOM     = 0.25;   // extra brightness on bright areas
    const float SAT       = 0.8;    // extra saturation
    const float HUE       = 1.2;    // max hue rotation (radians)
    const float HUE_SPEED = 0.02;   // turns per second of the hue pattern around the ring

    float aspect = u_res.x / u_res.y;
    vec2 c = (uv - 0.5) * vec2(aspect, 1.0) * 2.0;
    float r = length(c);
    float m = eff_int * smoothstep(radius, radius + SOFT, r);
    if (m <= 0.0) return vec4(cam, 1.0);

    // Bulge + outward-flowing ripples: sample closer to the centre.
    float waveK = 6.2831 * ripple_freq;
    float waveA = STEEP_MAX * ripple_amp * ripple_amp / waveK;
    float shift = BULGE_MAX * bulge * bulge * r + waveA * sin(waveK * r - 6.2831 * WAVE_HZ * u_time);
    vec2 dir = c / max(r, 1e-4);
    vec2 src = uv - dir * shift * m / (2.0 * vec2(aspect, 1.0));
    vec3 col = texture(u_tex, src).rgb;

    // Soft glow: ring of 8 taps, close enough together that thin lines blur
    // instead of showing up doubled.
    vec2 px = BLUR_R / u_res;
    vec3 blur = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float a = 0.7854 * float(i);
        blur += texture(u_tex, src + vec2(cos(a), sin(a)) * px).rgb;
    }
    blur *= 0.125;
    col = mix(col, blur, GLOW * m);
    col += BLOOM * m * blur * blur;

    // Colour: saturation boost, and a hue shift that varies around the ring.
    float k = colour * m;
    col = mix(vec3(luma(col)), col, 1.0 + SAT * k);
    float ang = atan(c.y, c.x);
    col = hueRotate(col, HUE * k * sin(ang + 6.2831 * HUE_SPEED * u_time));

    return vec4(clamp(col, 0.0, 1.0), 1.0);
}
