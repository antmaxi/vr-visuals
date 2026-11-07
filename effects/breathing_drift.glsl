// Breathing + drifting warp: regions of the image slowly swell and shrink out of
// sync (about 5 s per breath), while a slowly changing swirl field makes the
// texture drift around without bunching up.
//
// eff_int = 0 -> untouched image, 1 -> strongest.

// ---------- noise ----------
float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float noise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i + vec3(0.0, 0.0, 0.0)), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
                   mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
                   mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int k = 0; k < 3; k++) {
        v += a * noise(p);
        p *= 2.03;
        a *= 0.5;
    }
    return v;
}

// spatial gradient of fbm (forward differences)
vec2 grad(vec3 p) {
    const float e = 0.02;
    float c = fbm(p);
    return vec2(fbm(p + vec3(e, 0.0, 0.0)) - c,
                fbm(p + vec3(0.0, e, 0.0)) - c) / e;
}

// ---------- effect ----------
vec4 effect(vec2 uv) {
    float aspect = u_res.x / u_res.y;
    vec2 p = vec2(uv.x * aspect, uv.y);   // aspect-correct, so warp blobs are round

    // ---- knobs ----
    const float SCALE       = 3.0;    // size of warp regions (higher = smaller blobs)
    const float BREATH_AMP  = 0.012;  // breathing displacement at eff_int = 1
    const float BREATH_HZ   = 0.2;    // ~5 s per breath
    const float DRIFT_AMP   = 0.02;   // drifting displacement at eff_int = 1
    const float DRIFT_SPEED = 0.05;   // how fast the drift field evolves

    float t = u_time;

    // Breathing: expand/contract around the bumps of a static field;
    // each region gets its own phase so they breathe out of sync.
    vec2 g = grad(vec3(p * SCALE, 0.0));
    float phase = 6.2831 * fbm(vec3(p * SCALE * 0.5, 7.3));
    vec2 dBreath = BREATH_AMP * sin(6.2831 * BREATH_HZ * t + phase) * g;

    // Drifting: divergence-free (curl) field that slowly evolves,
    // so texture slides around without bunching up.
    vec2 h = grad(vec3(p * SCALE, 13.7 + t * DRIFT_SPEED));
    vec2 dDrift = DRIFT_AMP * vec2(h.y, -h.x);

    // Displacement is always an offset from the original position (never accumulated),
    // and is exactly zero at eff_int = 0.
    vec2 d = eff_int * (dBreath + dDrift);
    d.x /= aspect;                         // back to texture units

    vec2 src = clamp(uv - d, 0.0, 1.0);    // inverse warp: fetch color from the displaced spot
    return vec4(texture(u_tex, src).rgb, 1.0);
}
