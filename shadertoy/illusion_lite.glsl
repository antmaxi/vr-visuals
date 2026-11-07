// =============================================================================
// ILLUSION LITE - low-cost version of illusion.glsl. Shadertoy, Image tab.
// iChannel0 = webcam or video (wrap CLAMP, vflip ON). iMouse = move the center.
// Same scallop-ring "pulse" mandala and hue drift; no Sobel, no video
// distortion, screen blend only. 1 texture tap per pixel.
// =============================================================================

#define PETALS            32      // 8..64   petals around the center (integer)
#define BAND_FREQ         2.0     // 1..6    color cycles per ring (whole number)
#define PETAL_CURVE       1.0     // 0.2..1.1 petal curvature
#define COLOR_SPEED       0.025   // hue-wheel turns per second (one per 40 s)
#define BAND_FLOW         0.25    // bands flowing through the petals, cycles/s
#define ZOOM_SPEED        0.18    // rings per second; + = flow outward
#define ROTATION_SPEED    0.01    // radians per second
#define OVERLAY_STRENGTH  0.55    // 0..1

const float TAU = 6.28318531;

vec3 hsv2rgbSmooth(vec3 c) {
    vec3 rgb = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    rgb = rgb * rgb * (3.0 - 2.0 * rgb);
    return c.z * mix(vec3(1.0), rgb, c.y);
}
vec3 palette(float phase, float hue) {
    float ph  = fract(phase);
    vec3  col = hsv2rgbSmooth(vec3(fract(0.667 - 0.92 * ph + hue), 1.0, 1.0));
    float dip = max(smoothstep(0.78, 0.92, ph), 1.0 - smoothstep(0.0, 0.08, ph));
    return mix(col, hsv2rgbSmooth(vec3(fract(0.64 + hue), 0.9, 0.12)), dip);
}
float petalProfile(float x) { float a = clamp(2.0 * abs(x), 0.0, 1.0); return 1.0 - sqrt(1.0 - a * a); }
float petalX(float n, float x) { return fract(x - 0.5 * mod(n, 2.0) + 0.5) - 0.5; }
float ringEdge(float n, float x, float C) { return n + C * petalProfile(petalX(n, x)); }

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2  res = iResolution.xy;
    vec3  video = texture(iChannel0, fragCoord / res).rgb;
    vec2  center = (iMouse.x > 0.0 || iMouse.y > 0.0) ? iMouse.xy : 0.5 * res;
    vec2  p = (fragCoord - center) / res.y;
    float t = iTime;

    // polar fold -> log-polar cells (x = petals around, y = rings outward)
    float r = max(length(p), 1e-6);
    float k = float(PETALS) / TAU;
    vec2  c = vec2((atan(p.y, p.x) + t * ROTATION_SPEED) * k, log(r) * k - t * ZOOM_SPEED);

    // interlocking scallop rings
    float C = clamp(0.85 * PETAL_CURVE, 0.05, 0.95);
    float n = floor(c.y);
    if (c.y < ringEdge(n, c.x, C)) n -= 1.0;
    float e0 = ringEdge(n, c.x, C), e1 = ringEdge(n + 1.0, c.x, C);
    float band = clamp((c.y - e0) / max(e1 - e0, 1e-4), 0.0, 1.0);

    // bands + slow global hue drift
    float hue = t * COLOR_SPEED + 0.04 * log(r);
    vec3  pat = palette(band * max(1.0, floor(BAND_FREQ + 0.5)) - t * BAND_FLOW, hue);

    // center anti-aliasing: fade petals smaller than a few pixels, blue center dot
    float cellPx = r * TAU / float(PETALS) * res.y;
    pat = mix(hsv2rgbSmooth(vec3(fract(0.62 + hue), 0.55, 0.55)), pat, smoothstep(2.5, 9.0, cellPx));
    pat = mix(pat, hsv2rgbSmooth(vec3(fract(0.66 + hue), 1.0, 0.95)), 1.0 - smoothstep(4.0, 6.0, r * res.y));

    vec3 col = mix(video, 1.0 - (1.0 - video) * (1.0 - pat), OVERLAY_STRENGTH);   // screen blend
    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
