// The video is seen through rings of eyes that form a tunnel into the middle of
// your view: the eyes shrink with perspective as they recede, slowly travel
// inward, and all look toward the center. Each eye is a lens that bulges the
// picture, and takes its light and color from the scene around it.

// Notes for coders (inspired by the visionary "Net of Being" aesthetic):
// nothing is pasted over the video. Every pattern only changes WHERE the input
// is sampled; structure only darkens, brightens or desaturates the sampled
// video (eye whites lift it toward the local scene brightness, not to a fixed
// white). eff_int = 0 -> output identical to the input; rising eff_int grows
// distortion, color and shading together.
// Lattice: generalized log-polar around the screen center. Cells are N per ring
// (integer -> seamless), ring spacing ~ r^depth (depth -> 1 = true perspective,
// cells shrink in proportion to their distance from the center). Lens offsets
// are mapped back to the screen with the analytic Jacobian of that mapping.
// The harness has no mipmaps, so bloom and coarse brightness come from one
// ring of 8 wide taps.

uniform float eyeRatio;     // @param 0 1 1 Share of cells that are eyes; the rest are swirling spirals.
                            // 1 = an eye in every cell, 0 = only spirals.
uniform float eyeSize;      // @param 0 1 0.5 Size of the eyes. 0 = many small eyes per ring,
                            // 1 = a few big ones.
uniform float centerLook;   // @param 0 1 1 How strongly every eye looks into the middle of the tunnel.
                            // 0 = eyes look straight ahead; they still glance the way you turn your head.
uniform float depth;        // @param 0 1 0.8 How deep the tunnel is. 0 = evenly spaced rings,
                            // 1 = full perspective: eyes shrink toward the center, which sinks into shadow.
uniform float distortion;   // @param 0 1.5 0.85 How strongly each eye bends the video behind it.
                            // 0 = only the drawing, above ~1.2 faces get hard to read.

// ---- fixed settings ----
const float EYE_WHITE      = 0.8;    // 0..1  how far eyeballs lift toward the local scene brightness
const float EYE_LINES      = 0.75;   // 0..1  strength of the eye drawing (lids, iris ring, lashes)
const float EYE_LINE_PX    = 2.0;    // 1..4  eye line width in pixels (at 1080p)
const float GAZE           = 0.6;    // 0..1  irises glance in the direction the head turns (u_gaze)
const float TUNNEL_SPEED   = 0.12;   // rings per second the eyes travel inward
const float TUNNEL_TWIST   = 0.04;   // cells per second the rings slowly rotate
const float CENTER_SHADOW  = 0.55;   // 0..1  darkening of the tunnel's center (scaled by depth)
const float SERRATION      = 0.45;   // 0..1.5 feathery jaggedness of cell borders
const float FRAME_LINES    = 0.35;   // 0..1  darkness of cell frame lines
const float VEINS          = 0.35;   // 0..1.5 embossed vein lines along the scene's brightness
const float SATURATION     = 1.3;    // 0.5..2.5
const float BLOOM          = 0.3;    // 0..1.5
const float ANIM_SPEED     = 1.0;
const float SPIRAL_ARMS    = 3.0;    // 2..4
const float EDGE_SAT_BOOST = 0.7;
const float EDGE_SENS      = 5.0;
const float CHROMA         = 0.005;  // chromatic aberration on structure (uv)
const float FLOW_FOLLOW    = 0.4;    // lattice bends a little along video contours
const float LATTICE_WARP   = 0.15;   // organic wobble of the rings
const int   NEST_LEVELS    = 2;      // 1..3 nested frames per cell

const float PI  = 3.14159265;
const float TAU = 6.28318531;

// ------------------------------ helpers --------------------------------------
float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float lumaAt(vec2 uv) { return luma(texture(u_tex, uv).rgb); }

vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-6)), d / (q.x + 1e-6), q.x);
}
vec3 hsv2rgb(vec3 c) {
    vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
    return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

float sdRoundBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float sdAlmond(vec2 p, float w, float h) {
    float R = (w * w + h * h) / (2.0 * h);
    p = abs(p);
    return length(p - vec2(0.0, h - R)) - R;
}
// Anti-aliased line of constant pixel width around the zero set of d / filled d < 0.
float aaLine(float d, float wPx) {
    float px = abs(d) / max(fwidth(d), 1e-6);
    return 1.0 - smoothstep(0.5 * wPx - 0.5, 0.5 * wPx + 0.5, px);
}
float aaFill(float d) { return 1.0 - smoothstep(-0.5, 0.5, d / max(fwidth(d), 1e-6)); }

// ------------------------------ pattern fields --------------------------------
vec2 frameSDF(vec2 f, float diamond, float h, float t) {
    float d = diamond > 0.5 ? sdRoundBox(rot(PI * 0.25) * f, vec2(0.30), 0.06)
                            : sdRoundBox(f, vec2(0.40), 0.12);
    float a  = atan(f.y, f.x + 1e-6);
    float a8 = abs(mod(a + PI / 8.0, PI / 4.0) - PI / 8.0) / (PI / 8.0);
    float jag = mix(fract(a8 * 3.0), noise(vec2(a8 * 6.0, t * 0.5 + h * 13.0)), 0.4);
    return vec2(d - SERRATION * 0.035 * jag, jag);
}

// Spiral cell: returns (new local position, ridge, dark).
vec4 spiralField(vec2 f, float h, float t) {
    float arms  = floor(clamp(SPIRAL_ARMS, 2.0, 4.0) + 0.5);
    float r     = length(f);
    float a     = atan(f.y, f.x + 1e-6);
    float fall  = 1.0 - smoothstep(0.0, 0.40, r);
    float dir   = h > 0.5 ? 1.0 : -1.0;
    float arm   = 0.5 + 0.5 * cos(a * arms + dir * 16.0 * r - t * (0.5 + 0.5 * h));
    vec2 g = rot(dir * fall * (2.6 + 0.9 * (arm - 0.5))) * f;
    g *= 1.0 - 0.45 * fall * (arm - 0.5);
    g *= mix(0.35, 1.0, smoothstep(0.0, 0.18, r));
    return vec4(g, pow(arm, 4.0) * fall, 0.25 * (1.0 - arm) * fall);
}

// Eye (local frame: x = eye axis). Iris centered at c (follows the gaze) magnifies
// the video, pupil pinches it, lid edge pushes it out. light = brighter side of
// the scene in eye coords (for eyeball shading).
// Returns (new local position, ridge, dark); extra = (ink, glow, white, ball).
vec4 eyeField(vec2 f, float h, float t, float wPx, vec2 gz, vec2 light, out vec4 extra) {
    float open  = 0.08 + 0.92 * smoothstep(0.0, 0.35, abs(sin(t * 0.33 + h * 17.0)));
    float dA    = sdAlmond(f, 0.34, max(0.20 * open, 0.012));
    float inEye = aaFill(dA);
    const float ri = 0.14;
    vec2  c     = clamp(gz, -1.0, 1.0) * vec2(0.13, 0.05);
    vec2  fi    = f - c;
    float r     = length(fi);
    float a     = atan(fi.y, fi.x + 1e-6);
    float rp    = ri * (0.36 + 0.10 * sin(t * 0.9 + h * 20.0));
    float irisW = 1.0 - smoothstep(ri * 0.85, ri * 1.05, r);
    float pupW  = 1.0 - smoothstep(rp * 0.70, rp * 1.10, r);
    float k     = clamp(r / ri, 0.0, 1.0);

    vec2 g = mix(f, c + fi * mix(0.30, 1.0, k * k) * (1.0 + 0.10 * cos(a * 22.0) * k), irisW * inEye);
    g = mix(g, c + fi * (1.0 + 1.5 * pupW), pupW * inEye);
    float lid = exp(-abs(dA) / 0.018);
    g -= vec2(0.0, sign(f.y)) * lid * 0.05;

    float fw      = max(fwidth(dA), 1e-6);
    float irisIn  = aaFill(r - ri);
    float lidInk  = aaLine(dA, wPx * 1.5);
    float lidRim  = aaLine(dA + (wPx * 1.5 + 1.0) * fw, wPx * 0.6) * inEye;
    float irisInk = aaLine(r - ri, wPx * 1.1) * inEye;
    float pupil   = aaFill(r - rp) * inEye;
    float catchL  = aaFill(length(fi - vec2(-0.35, 0.40) * ri) - 0.18 * ri) * inEye;
    float lashBand = step(0.0, f.y) * step(0.0, dA) * (1.0 - smoothstep(0.0, 0.05, dA))
                   * (1.0 - smoothstep(0.24, 0.30, abs(f.x)));
    float lashes  = aaLine((fract(f.x * 24.0 + 0.5) - 0.5) / 24.0, wPx * 0.8) * lashBand;

    float white = inEye * (1.0 - irisIn);
    float ball  = 1.0 - 0.35 * smoothstep(-0.07, 0.0, dA)      // shadow under the lids
                      - 0.20 * pow(abs(f.x) / 0.34, 2.0)       // rounder toward the corners
                      + 0.22 * dot(f / 0.34, light);           // lit from the brighter side
    extra = vec4(max(max(lidInk, irisInk), lashes), max(lidRim * 0.5, catchL), white, clamp(ball, 0.0, 1.2));
    return vec4(g, lid + 0.7 * exp(-abs(r - ri) / 0.01) * inEye, 0.85 * pupil);
}

// ------------------------------ effect ----------------------------------------
vec4 effect(vec2 uv) {
    vec4 src = texture(u_tex, uv);
    if (eff_int <= 0.0) return src;                            // exact pass-through
    float k = clamp(eff_int, 0.0, 1.0);

    float aspect = u_res.x / u_res.y;
    vec2  p      = (uv - 0.5) * vec2(aspect, 1.0);             // centered, screen heights
    float t      = u_time * ANIM_SPEED;
    vec2  tx     = 1.0 / u_res;

    // ---- 1. video analysis (12 taps) ----
    float tl = lumaAt(uv + vec2(-2.0, 2.0) * tx), tr = lumaAt(uv + vec2(2.0, 2.0) * tx);
    float bl = lumaAt(uv - vec2(2.0, 2.0) * tx),  br = lumaAt(uv + vec2(2.0, -2.0) * tx);
    vec2  gF = vec2((tr + br) - (tl + bl), (tl + tr) - (bl + br)) * 0.5;
    float hF = 0.25 * (tl + tr + bl + br);
    float edge = smoothstep(0.08, 0.6, length(gF) * EDGE_SENS);
    vec2  gC = vec2(0.0);
    float hC = 0.0;
    vec3  ringCol = vec3(0.0);
    for (int i = 0; i < 8; i++) {
        float ang = float(i) * (TAU / 8.0);
        vec2  dir = vec2(cos(ang), sin(ang));
        vec3  c   = texture(u_tex, clamp(uv + dir * vec2(0.03 / aspect, 0.03), 0.001, 0.999)).rgb;
        float l   = luma(c);
        gC += dir * l * 0.5;
        hC += l * 0.125;
        ringCol += c * 0.125;
    }

    // ---- 2. tunnel lattice: generalized log-polar around the middle of the view ----
    float r    = max(length(p), 1e-4);
    float ang  = atan(p.y, p.x);
    vec2  tg   = vec2(-p.y, p.x) / r;                          // around the tunnel (cell x)
    vec2  rd   = p / r;                                        // outward (cell y)
    float N    = floor(mix(28.0, 8.0, clamp(eyeSize, 0.0, 1.0)) + 0.5);   // eyes per ring
    float kq   = N / TAU;
    float dd   = clamp(depth, 0.0, 1.0) * 0.98;                // 0 = even rings, ~1 = true perspective
    float uRad = (pow(r, 1.0 - dd) - 1.0) / (1.0 - dd);        // -> log(r) as dd -> 1
    vec2  q    = vec2(ang * kq, uRad * kq);
    q.y += t * TUNNEL_SPEED * (0.3 + dd);                      // eyes travel into the tunnel
    q.x += t * TUNNEL_TWIST;
    q   += LATTICE_WARP * 2.0 * (vec2(noise(p * 2.0 + vec2(0.0, t * 0.05)),
                                      noise(p * 2.0 + vec2(5.2, -t * 0.04))) - 0.5);
    q   += FLOW_FOLLOW * vec2(dot(gF, tg), dot(gF, rd));
    vec2  id   = floor(q);
    id.x = mod(id.x, N);                                       // same cell on both sides of the angle seam
    vec2  f    = fract(q) - 0.5;
    // cell size on screen (screen heights) along each cell axis
    float lenX = r / kq;
    float lenY = pow(r, dd) / kq;
    float cellPx = min(lenX, lenY) * u_res.y;
    float tiny   = smoothstep(5.0, 14.0, cellPx);              // fade cells too small to draw cleanly
    float shadow = CENTER_SHADOW * dd * (1.0 - smoothstep(0.0, 0.45, r));   // depth: center sinks into shadow

    vec2  hc      = hash22(id);
    float h       = hc.x;
    float isEye   = step(1.0 - eyeRatio, hc.y);
    float diamond = step(0.5, hash21(id + 17.3));
    float breath  = 1.0 + 0.05 * sin(t * 0.8 + h * TAU);
    vec2  fb      = f / breath;

    // ---- 3. cell lens ----
    vec2  fr     = frameSDF(fb, diamond, h, t);
    float d0     = fr.x;
    float inside = smoothstep(0.015, -0.015, d0);
    vec4  Sp = spiralField(fb, h, t);
    // Eyes lie along the radius (eye axis = cell y), so looking into the middle
    // moves the iris along the long axis of the eye: eye coords = cell coords .yx
    float wPx    = EYE_LINE_PX * u_res.y / 1080.0;
    vec2  gzCell = centerLook * vec2(0.0, -1.0) + GAZE * vec2(dot(u_gaze, tg), dot(u_gaze, rd));
    vec2  gCn    = gC / max(length(gC), 1e-4) * smoothstep(0.01, 0.06, length(gC));
    vec2  lightCell = vec2(dot(gCn, tg), dot(gCn, rd));
    vec4  eyeX;                                                // (ink, glow, white, ball)
    vec4  Ey = eyeField(fb.yx, h, t, wPx, gzCell.yx, lightCell.yx, eyeX);
    Ey.xy = Ey.yx;
    vec4  C  = mix(Sp, Ey, isEye);
    vec2  g  = mix(fb, C.xy, inside);

    float frames = exp(-abs(d0) / 0.012);
    float s = 1.0;
    for (int i = 1; i < NEST_LEVELS; i++) {
        s *= 0.8;
        float di = frameSDF(fb / s, diamond, h, t).x * s;
        g *= 1.0 - 0.10 * smoothstep(0.01, -0.01, di);
        frames += exp(-abs(di) / 0.010) * (1.0 - 0.25 * float(i));
    }
    g -= fb / max(length(fb), 1e-4) * exp(-abs(d0) / 0.03) * SERRATION * 0.05 * (0.4 + fr.y);

    // cell-local offset -> screen, via the tunnel mapping's Jacobian
    float fade = (1.0 - smoothstep(0.42, 0.5, max(abs(f.x), abs(f.y)))) * tiny;
    vec2  dLoc = (g * breath - f) * fade;
    vec2  dP   = (dLoc.x * lenX * tg + dLoc.y * lenY * rd) * distortion * k;
    vec2  dCellUv = dP / vec2(aspect, 1.0);

    // ---- 4. veins ----
    float H    = 0.85 * hF + 0.15 * hC + 0.12 * noise(q * 0.5 + t * 0.03);
    float vv   = fract(H * 6.0 + t * 0.12) - 0.5;
    float vein = 1.0 - smoothstep(0.0, 0.16, abs(vv));
    vec2  gH   = gF + 0.1 * gC;
    vec2  dVein = VEINS * 0.008 * k * vein * sign(vv) * (gH / max(length(gH), 1e-4))
                * smoothstep(0.005, 0.03, length(gH));

    // ---- 5. re-sample through the lens field (3 taps) ----
    vec2  duv = dCellUv + vec2(dVein.x / aspect, dVein.y);
    vec2  suv = clamp(uv + duv, 0.001, 0.999);
    float vis = tiny * (1.0 - shadow);                         // structure fades into the depth
    float structure = clamp((0.6 * frames + C.z * inside) * vis + 0.5 * VEINS * vein, 0.0, 1.5);
    vec2  ca  = duv / max(length(duv), 1e-5) * CHROMA * k * (0.25 + structure + edge);
    vec3 col;
    col.r = texture(u_tex, clamp(suv + ca, 0.001, 0.999)).r;
    col.g = texture(u_tex, suv).g;
    col.b = texture(u_tex, clamp(suv - ca, 0.001, 0.999)).b;

    // ---- 6. embossing from the combined height field ----
    float Ht = (0.4 * frames + 0.6 * C.z * inside) * vis + 0.7 * VEINS * vein + 0.15 * hF;
    vec2  dH = vec2(dFdx(Ht), dFdy(Ht)) * (u_res.y / 720.0);
    vec3  n  = normalize(vec3(-dH * 2.5, 1.0));
    vec3  L  = normalize(vec3(-0.48, 0.64, 0.60));
    float shade = clamp(1.0 + 1.1 * (dot(n, L) - L.z), 0.5, 1.5);

    // ---- 7. color: the video's own colors, amplified ----
    vec3  hsv = rgb2hsv(col);
    hsv.y = clamp(hsv.y * (SATURATION + EDGE_SAT_BOOST * (edge + 0.6 * structure)), 0.0, 1.0);
    float v = hsv.z * shade;
    v *= 1.0 - FRAME_LINES * exp(-abs(d0) / 0.005) * vis;
    v *= 1.0 + 0.25 * exp(-abs(d0) / 0.02) * SERRATION * vis;
    v *= 1.0 - C.w * inside * vis;
    v *= 1.0 + 0.2 * VEINS * vein;
    // eyes, integrated: the eyeball lifts toward the LOCAL scene brightness and
    // keeps some of the scene's color, so eyes in shadow stay dim and tinted
    float eyeOn  = isEye * inside * vis;
    float wv     = eyeX.z * EYE_WHITE * eyeOn;
    float sclera = mix(0.45, 0.95, smoothstep(0.08, 0.7, hC)) * eyeX.w;
    hsv.y *= 1.0 - 0.6 * wv;
    v = mix(v, max(v, sclera), wv);
    float eyeVis = EYE_LINES * eyeOn;
    v *= 1.0 - 0.85 * eyeX.x * eyeVis;
    v  = mix(v, max(v, 0.8) * 1.1, eyeX.y * eyeVis);
    v *= 1.0 - shadow;                                         // the tunnel's depth
    hsv.z = v;
    col = hsv2rgb(hsv);
    col = mix(col, col * col * (3.0 - 2.0 * clamp(col, 0.0, 1.0)), 0.25);

    // ---- 8. bloom from the ring average ----
    col += BLOOM * max(ringCol - 0.55, 0.0) / 0.45 * (0.6 + 0.4 * structure);

    return vec4(mix(src.rgb, clamp(col, 0.0, 1.0), k), 1.0);
}

// COST: 1 input + 4 fine gradient + 8 ring + 3 final = 16 texture taps per pixel.
// On the Quest, lower cost with CHROMA = 0 (replace the 3 final taps with one
// texture(u_tex, suv), -2) or 4 ring taps instead of 8 (-4).
