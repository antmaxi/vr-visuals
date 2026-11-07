// Pseudo-DeepDream: one "dream step" per frame, accumulated through u_prev.
// Each frame the previous output is zoomed in slightly, flowed along its edges,
// detail-amplified (unsharp mask) and recoloured, then pulled back toward the
// live image. Patterns grow while eff_int stays up.
// eff_int = 0 -> output (and so the feedback state) is exactly the input.
// colorfulness: -1 grey dream, 0 original colours, 1 saturated scene with
// rainbow-tinted patterns.
// eyes: dark points, line ends and corners in the live image turn into black
// pupils (lines and straight edges don't), and the dream patterns flow around
// them, like the "eyes" in DeepDream images.

uniform float colorfulness; // @param -1 1 0
uniform float eyes;         // @param 0 1 0.5

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

const vec2 DIR8[8] = vec2[8](
    vec2( 1.0, 0.0), vec2( 0.7071,  0.7071), vec2(0.0,  1.0), vec2(-0.7071,  0.7071),
    vec2(-1.0, 0.0), vec2(-0.7071, -0.7071), vec2(0.0, -1.0), vec2( 0.7071, -0.7071));
const vec2 DIR12[12] = vec2[12](
    vec2( 1.0,  0.0  ), vec2( 0.866,  0.5  ), vec2( 0.5,  0.866), vec2( 0.0,    1.0),
    vec2(-0.5,  0.866), vec2(-0.866,  0.5  ), vec2(-1.0,  0.0  ), vec2(-0.866, -0.5),
    vec2(-0.5, -0.866), vec2( 0.0,   -1.0  ), vec2( 0.5, -0.866), vec2( 0.866, -0.5));

// How much the camera image at uv looks like a dark point: darker than most of
// its surroundings (dot, line end, corner), but not part of a line.
// Walking round a ring, a line shows up as two separate dark arcs (one each way
// along it), even when uv is off the line's centre; a dot, line end or corner
// shows at most one. "trans" counts bright/dark changes round the ring, so two
// arcs give 4. The inner ring catches thin lines (the outer one can slip
// between them), the outer ring catches lines too thick for the inner one.
float eyeSeed(vec2 uv, vec2 px, float c0, float rOut, float rIn, float t) {
    float around = 0.0, transOut = 0.0, transIn = 0.0;
    float first = 0.0, prev = 0.0;
    for (int i = 0; i < 8; i++) {
        float b = smoothstep(t, 2.0 * t, luma(texture(u_tex, uv + DIR8[i] * rOut * px).rgb) - c0);
        around += b;
        if (i == 0) first = b; else transOut += abs(b - prev);
        prev = b;
    }
    transOut += abs(first - prev);
    for (int i = 0; i < 12; i++) {
        float b = smoothstep(t, 2.0 * t, luma(texture(u_tex, uv + DIR12[i] * rIn * px).rgb) - c0);
        if (i == 0) first = b; else transIn += abs(b - prev);
        prev = b;
    }
    transIn += abs(first - prev);
    float line = smoothstep(2.5, 3.5, max(transOut, transIn));
    return smoothstep(0.5, 0.75, around / 8.0) * (1.0 - line);
}

vec4 effect(vec2 uv) {
    vec3 cam = texture(u_tex, uv).rgb;
    if (eff_int <= 0.0) return vec4(cam, 1.0);

    // The harness clears feedback targets to alpha 0; start the dream from the camera.
    if (texture(u_prev, uv).a < 0.5) return vec4(cam, 1.0);

    // ---- knobs (per frame, at eff_int = 1) ----
    const float ZOOM   = 0.0015;  // zoom-in per frame (classic DeepDream video drift)
    const float R      = 3.0;     // sampling radius in pixels: size of the grown features
    const float FLOW   = 2.0;     // how far texture flows along edges, in pixels
    const float SHARP  = 0.12;    // detail amplification while detail is still weak
    const float MAXDET = 0.18;    // detail strength at which amplification stops
    const float TINT   = 1.5;     // rainbow colouring of grown detail by edge direction
    const float SAT    = 0.03;    // saturation boost per frame; must stay below
                                  // ANCHOR / (1 - ANCHOR) (~0.052) or colours run away
    const float ANCHOR = 0.05;    // how strongly the live image pulls the dream back
    const float RE       = 10.0;  // eye detection radius in pixels (largest pupil)
    const float RE_IN    = 4.0;   // inner radius for rejecting thin lines (>= ~2 px wide)
    const float EYE_T    = 0.04;  // how much darker than its surroundings a point must be
    const float EYE_DARK = 0.25;  // pupil darkening per frame (settles near 17% brightness)

    vec2 px = 1.0 / u_res;
    float k = eff_int;
    float e = eyes * k;
    float warm = max(colorfulness, 0.0) * k;   // 0..1 toward colourful
    float grey = max(-colorfulness, 0.0);      // 0..1 toward desaturated
    // How much of the dream state survives each frame. Saturates early so the
    // dream can accumulate at medium intensity, and is exactly 0 at eff_int = 0.
    float keep = smoothstep(0.0, 0.25, eff_int);

    vec2 z = (uv - 0.5) * (1.0 - ZOOM * k) + 0.5;

    // Brightness gradient of the dream state
    float l = luma(texture(u_prev, z - vec2(R, 0.0) * px).rgb);
    float r = luma(texture(u_prev, z + vec2(R, 0.0) * px).rgb);
    float d = luma(texture(u_prev, z - vec2(0.0, R) * px).rgb);
    float u = luma(texture(u_prev, z + vec2(0.0, R) * px).rgb);
    vec2 g = vec2(r - l, u - d);

    // Flow along edges (perpendicular to the gradient): swirly, feathery lines
    vec2 p = z + vec2(-g.y, g.x) * FLOW * k * px;
    vec3 dream = texture(u_prev, p).rgb;

    // Amplify detail: push away from the local average
    vec3 blur = 0.25 * (texture(u_prev, p + vec2( R,  R) * px).rgb +
                        texture(u_prev, p + vec2(-R,  R) * px).rgb +
                        texture(u_prev, p + vec2( R, -R) * px).rgb +
                        texture(u_prev, p + vec2(-R, -R) * px).rgb);
    // Amplification fades out as detail gets strong, so patterns settle at a
    // fixed contrast instead of growing into noise.
    vec3 detail = dream - blur;
    float gain = SHARP * k * (1.0 - smoothstep(0.0, MAXDET, length(detail)));

    // Colourful: give the (mostly grey) grown detail a colour from the edge
    // direction, a zero-sum RGB vector going round the colour wheel with the
    // edge angle. It is fixed per location, so colours stay put instead of cycling.
    vec2 n = g / (length(g) + 1e-3);
    vec3 tint = vec3(n.x, -0.5 * n.x - 0.866 * n.y, -0.5 * n.x + 0.866 * n.y);
    dream += (detail + TINT * warm * luma(detail) * tint) * gain;

    // Eyes: detected on the live image (so the dream's own patterns can't seed
    // them), then darkened every frame into black pupils.
    if (e > 0.0) dream *= 1.0 - EYE_DARK * e * eyeSeed(uv, px, luma(cam), RE, RE_IN, EYE_T);

    // Colourful: boost saturation. Compounds through the feedback loop and
    // settles against ANCHOR as long as SAT stays below the limit above.
    dream = mix(vec3(luma(dream)), dream, 1.0 + SAT * warm);

    // Keep it attached to the real scene
    dream = mix(dream, cam, ANCHOR);

    // Desaturated: pull the dream toward grey (always stable)
    dream = mix(dream, vec3(luma(dream)), grey);

    return vec4(mix(cam, clamp(dream, 0.0, 1.0), keep), 1.0);
}
