// A hypnotic optical-illusion mandala of interlocking rainbow petals blooms from
// the main object in view (the biggest or closest-looking thing, e.g. a person)
// and glides after it as it moves - the outer rings trail behind like a
// flowing veil and catch up when it stops - streaming like an endless tunnel
// woven into the scene. Around the same center the real scene is mirrored in
// 20 rays like a kaleidoscope. Its colors slowly drift around the color wheel.

// Notes for coders: procedural log-polar scallop rings (port of
// shadertoy/illusion.glsl). Every ring of petals has a scalloped inner edge
// (circular arcs, tips pointing outward); alternate rings are offset by half a
// petal and the bands morph from one ring's scallops into the next. The pattern
// is bent slightly by the video's brightness gradient and darkened along video
// edges so the scene reads through it. eff_int = 0 -> output identical to the
// input (strength is multiplied by eff_int). Center = mix(screen center,
// u_focus, follow); u_focus is the harness's smoothed main-object position.
// Flow: outer rings use an older center (focus - velocity * lag, lag growing
// with radius), so the mandala trails behind the moving center.
// Mirror: kaleidoscope of the input around the same center - the angle is
// mirror-folded into one of RAYS wedges (each wedge reflects its neighbor, so
// there are no seams) and the video is re-sampled there. The pattern is then
// blended over this mirrored video; edges and the ring bending use it too.

uniform float strength;     // @param 0 1 0.55 How strongly the mandala shows over the scene.
                            // 0 = only the scene, 1 = the pattern dominates.
uniform float petals;       // @param 8 64 32 Number of petals around the center (whole numbers).
                            // Fewer = big bold petals, more = a fine, dense lotus.
uniform float colorSpeed;   // @param 0 0.2 0.025 How fast the colors drift around the color wheel, in turns
                            // per second. 0.025 = one full turn every 40 seconds.
uniform float zoomSpeed;    // @param -1 1 0.18 Tunnel flow. Positive = rings stream outward toward you,
                            // negative = they sink into the center, 0 = still.
uniform float follow;       // @param 0 1 1 How much the center follows the main object in view (the
                            // biggest or closest-looking thing). 0 = always the middle of the screen,
                            // 1 = centered on the object, gliding after it when it moves.
uniform float mirror;       // @param 0 1 1 Kaleidoscope: the real scene mirrored in 20 rays radiating
                            // from the mandala's center. 0 = the normal camera picture, 1 = fully mirrored.
uniform float blendMode;    // @param 0 5 0 How the pattern mixes with the scene: 0 screen (light, airy),
                            // 1 overlay, 2 soft light (subtle), 3 multiply (dark, stained glass),
                            // 4 additive glow, 5 pattern mainly in the dark parts of the scene.

// ---- fixed settings ----
const float BAND_FREQ        = 2.0;    // color cycles per ring of petals (whole number)
const float PETAL_CURVE      = 1.0;    // 0.2..1.1 petal curvature
const float BAND_FLOW        = 0.25;   // bands flowing through each petal, cycles/s
const float ROTATION_SPEED   = 0.01;   // radians per second
const float PULSE_AMOUNT     = 0.35;   // breathing of the petal curvature (moire shimmer)
const float VIDEO_DISTORTION = 0.6;    // rings bend around objects
const float EDGE_INFLUENCE   = 0.5;    // video edges darken the pattern
const float SATURATION       = 1.15;
const float GLOW             = 0.6;    // bright seams between petals + halo
const float LUMA_HUE         = 0.15;   // video brightness shifts the local hue
const float FLOW_LAG         = 0.9;    // s; how far behind the outer rings trail a moving center
const float FLOW_RADIUS      = 0.5;    // screen heights; how quickly the trail grows outward
const float RAYS             = 20.0;   // mirrored rays around the center (whole number)
const float MIRROR_ANGLE     = 1.5708; // radians; direction of the wedge that is mirrored (up)

const float TAU = 6.28318531;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float lumaAt(vec2 uv) { return luma(texture(u_tex, clamp(uv, 0.0, 1.0)).rgb); }

vec3 hsv2rgbSmooth(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    rgb = rgb * rgb * (3.0 - 2.0 * rgb);
    return c.z * mix(vec3(1.0), rgb, c.y);
}
// blue -> cyan -> green -> yellow -> orange -> red -> magenta -> violet -> navy
vec3 palette(float phase, float hue) {
    float ph  = fract(phase);
    vec3  col = hsv2rgbSmooth(vec3(fract(0.667 - 0.92 * ph + hue), 1.0, 1.0));
    float dip = max(smoothstep(0.78, 0.92, ph), 1.0 - smoothstep(0.0, 0.08, ph));
    return mix(col, hsv2rgbSmooth(vec3(fract(0.64 + hue), 0.9, 0.12)), dip);
}
vec3 saturateColor(vec3 c, float s) { return max(mix(vec3(luma(c)), c, s), 0.0); }

vec3 blendScreen(vec3 b, vec3 s)   { return 1.0 - (1.0 - b) * (1.0 - s); }
vec3 blendOverlay(vec3 b, vec3 s)  { return mix(2.0 * b * s, 1.0 - 2.0 * (1.0 - b) * (1.0 - s), step(0.5, b)); }
vec3 blendSoftLight(vec3 b, vec3 s) {
    vec3 d = mix(((16.0 * b - 12.0) * b + 4.0) * b, sqrt(b), step(0.25, b));
    return mix(b - (1.0 - 2.0 * s) * b * (1.0 - b), b + (2.0 * s - 1.0) * (d - b), step(0.5, s));
}

float sobel(vec2 uv, vec2 d) {
    float tl = lumaAt(uv + vec2(-d.x,  d.y)), tt = lumaAt(uv + vec2(0.0,  d.y)), tr = lumaAt(uv + d);
    float ll = lumaAt(uv - vec2( d.x, 0.0)),                                     rr = lumaAt(uv + vec2(d.x, 0.0));
    float bl = lumaAt(uv - d),                bb = lumaAt(uv - vec2(0.0,  d.y)), br = lumaAt(uv + vec2(d.x, -d.y));
    return length(vec2((tr + 2.0 * rr + br) - (tl + 2.0 * ll + bl),
                       (tl + 2.0 * tt + tr) - (bl + 2.0 * bb + br))) * 0.25;
}

float petalProfile(float x) { float a = clamp(2.0 * abs(x), 0.0, 1.0); return 1.0 - sqrt(1.0 - a * a); }
float petalX(float n, float x) { return fract(x - 0.5 * mod(n, 2.0) + 0.5) - 0.5; }
float ringEdge(float n, float x, float C) { return n + C * petalProfile(petalX(n, x)); }
// (band coordinate 0..1 across the ring, distance to the petal's side edge)
vec2 petalField(vec2 c, float C) {
    float n = floor(c.y);
    if (c.y < ringEdge(n, c.x, C)) n -= 1.0;
    float e0 = ringEdge(n, c.x, C), e1 = ringEdge(n + 1.0, c.x, C);
    return vec2(clamp((c.y - e0) / max(e1 - e0, 1e-4), 0.0, 1.0), 0.5 - abs(petalX(n, c.x)));
}

vec4 effect(vec2 uv) {
    vec4 src = texture(u_tex, uv);
    if (eff_int <= 0.0) return src;                            // exact pass-through
    float t  = u_time;
    float fo     = clamp(follow, 0.0, 1.0);
    vec2  center = mix(vec2(0.5), clamp(u_focus, 0.0, 1.0), fo);
    vec2  asp    = vec2(u_res.x / u_res.y, 1.0);
    vec2  p      = (uv - center) * asp;

    // ---- kaleidoscope: mirror the real scene in RAYS wedges around the center ----
    // Fold the angle into one wedge, mirrored at every wedge edge, and re-sample
    // the video there. The wedge turns with the pattern so rays and petals move together.
    float seg  = TAU / RAYS;
    float aM   = atan(p.y, p.x) - MIRROR_ANGLE - t * ROTATION_SPEED;
    float aF   = abs(mod(aM + 0.5 * seg, seg) - 0.5 * seg);   // 0..seg/2, mirrored
    vec2  pM   = length(p) * vec2(cos(aF + MIRROR_ANGLE + t * ROTATION_SPEED),
                                  sin(aF + MIRROR_ANGLE + t * ROTATION_SPEED));
    vec2  muv  = clamp(center + pM / asp, 0.001, 0.999);
    float mk   = clamp(mirror, 0.0, 1.0) * clamp(eff_int, 0.0, 1.0);   // fades in with eff_int
    vec2  auv  = mk > 0.5 ? muv : uv;                          // where to analyze edges / gradient
    vec3  video = mix(src.rgb, texture(u_tex, muv).rgb, mk);
    float vl = luma(video);
    // the mandala flows after its center: the further out, the older the center
    // it uses (trail = velocity * lag). Fold-free: the trail grows with radius
    // as (1 - exp(-r / FLOW_RADIUS)), whose slope is at most 1 / FLOW_RADIUS, and
    // its length is soft-capped below 0.7 * FLOW_RADIUS -> the warp's slope stays
    // < 0.7, so the pattern stretches and flows but never folds over itself.
    vec2  trail  = clamp(u_focusVel, -3.0, 3.0) * fo * asp * FLOW_LAG;
    trail /= 1.0 + length(trail) / (0.7 * FLOW_RADIUS);
    p += trail * (1.0 - exp(-length(p) / FLOW_RADIUS));

    // rings bend around objects (blurred luminance gradient, 4 taps)
    vec2 e  = 6.0 / u_res;
    vec2 gL = vec2(lumaAt(auv + vec2(e.x, 0.0)) - lumaAt(auv - vec2(e.x, 0.0)),
                   lumaAt(auv + vec2(0.0, e.y)) - lumaAt(auv - vec2(0.0, e.y)));
    p += VIDEO_DISTORTION * 0.03 * gL;

    // polar fold -> log-polar cells (x = petals around, y = rings outward)
    float P = floor(clamp(petals, 8.0, 64.0) + 0.5);
    float r = max(length(p), 1e-6);
    float k = P / TAU;
    vec2  c = vec2((atan(p.y, p.x) + t * ROTATION_SPEED) * k, log(r) * k - t * zoomSpeed);
    float C = clamp(0.85 * PETAL_CURVE * (1.0 + 0.08 * PULSE_AMOUNT * sin(t * 0.7)), 0.05, 0.95);
    vec2  pf = petalField(c, C);

    // bands with the global hue drift
    float hue = t * colorSpeed + 0.04 * log(r) + LUMA_HUE * vl;
    vec3  pat = palette(pf.x * BAND_FREQ - t * BAND_FLOW, hue);

    // bright rainbow seams at the petal edges
    float seamPx  = pf.y * TAU * r * u_res.y / P;
    vec3  seamCol = hsv2rgbSmooth(vec3(fract(hue + c.y * 0.37 + 0.5), 0.8, 1.0));
    pat = mix(pat, seamCol, (1.0 - smoothstep(0.4, 1.6, seamPx)) * clamp(GLOW, 0.0, 1.0));
    pat += seamCol * exp(-seamPx / 4.0) * 0.25 * GLOW;
    pat = saturateColor(pat, SATURATION);

    // dense center: fade petals below a few pixels, blue dot at the very center
    float cellPx = r * TAU / P * u_res.y;
    pat = mix(hsv2rgbSmooth(vec3(fract(0.62 + hue), 0.55, 0.55)), pat, smoothstep(2.5, 9.0, cellPx));
    pat = mix(pat, hsv2rgbSmooth(vec3(fract(0.66 + hue), 1.0, 0.95)), 1.0 - smoothstep(4.0, 6.0, r * u_res.y));

    // the scene's edges read through the pattern
    pat *= 1.0 - 0.7 * EDGE_INFLUENCE * smoothstep(0.05, 0.35, sobel(auv, 1.5 / u_res));

    // blend
    int   mode = int(clamp(floor(blendMode + 0.5), 0.0, 5.0));
    vec3  blended = mode == 0 ? blendScreen(video, pat)
                  : mode == 1 ? blendOverlay(video, pat)
                  : mode == 2 ? blendSoftLight(video, pat)
                  : mode == 3 ? video * pat
                  : mode == 4 ? video + pat * (0.6 + 0.4 * GLOW)
                  : pat;
    float s = clamp(strength, 0.0, 1.0) * clamp(eff_int, 0.0, 1.0);
    if (mode == 5) s *= 1.0 - smoothstep(0.15, 0.85, vl);     // strong in dark areas only
    return vec4(clamp(mix(video, blended, s), 0.0, 1.0), 1.0);
}

// COST: 1 input + 4 gradient + 8 Sobel = 13 texture taps per pixel; the
// pattern itself is pure math. Cheapest: EDGE_INFLUENCE = 0 and remove the
// sobel() call (-8 taps).
