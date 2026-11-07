// Edge Mandala: angular, glowing ornament grows out of the edge of every shape.
// Each edge is a mirror line: bands of lines, triangles, squares and waves are
// born on the edge and travel outward to both sides, identical on both sides.
// Style inspiration: visionary "aura" art (Alex Grey) - layered colored bands
// hugging the body outline, fine luminous linework, a sacred-geometry grid.
//
// eff_int (global, 0..1, set by the harness; builds up while the viewer holds
// still, drops fast when they move) is the strength of everything here:
//   0    -> output identical to the input (and the feedback state resets)
//   low  -> a faint ladder of lines close to the edges
//   high -> the ornament reaches far out, all motifs + the grid
// The shader only reads eff_int; it never tries to detect motion itself.
//
// Stages, per pixel:
//   1. Edge detection (pre-blurred gradient on luma) -> "seeds" on every edge.
//   2. Distance field in the feedback buffer: each update, a pixel takes the
//      smallest distance among its 8 neighbors + one step, so distance
//      spreads outward from the edges at growthSpeed. New edges visibly grow
//      their pattern outward; vanished edges dissolve over fadeTime.
//   3. Ornament in (distance from edge, position along edge) space. Bands move
//      outward; band k carries motif k mod 4: ladder / zigzag triangles &
//      diamonds / square battlements / double wave. Depends only on the
//      distance, never on the side -> mirror-symmetric.
//   4. Color: muted red/blue/yellow palette per band, bright edge light, glow halos.
//   5. Compositing over the video (+ optional on-edge / off-edge mask).
//   6. Audio hooks and chromatic aberration across the edges.
//
// STATE: the distance to the nearest edge is stored in the ALPHA channel of this
// effect's output (alpha 1 = far / no pattern). RGB is the normal visible image.
// The canvas has no alpha, so this is invisible on screen; effects after this
// one should ignore u_tex alpha (every current effect does). Alpha 0 (the
// harness's cleared buffer on the first frame / after a resize) also reads as
// far, so there is no first-frame flash.
//
// Color space: video and palette are converted sRGB -> linear on read, mixed in
// linear light, and converted back to sRGB on write. Edge detection runs on sRGB
// luma on purpose (closer to perceived contrast, less noisy in the shadows).
//
// Units: distances are in "units" where the short side of the frame is 2 units
// (aspect-correct for landscape, 4K and vertical 9:16 alike).

// ============================================================================
// Controls (the harness has no custom uniforms: edit these constants)
// ============================================================================
const float edgeThreshold   = 0.06;  // 0..0.5    gradient strength where edges start
const float edgeSoftness    = 0.10;  // 0.01..0.5 smoothstep width above the threshold
const float growthSpeed     = 0.25;  // 0.05..1   units/s the pattern spreads away from new edges
const float reach           = 0.45;  // 0.1..0.8  max distance (units) at eff_int = 1
const float fadeTime        = 2.0;   // 0.5..10 s how long a vanished edge's pattern takes to dissolve
const float falloff         = 1.2;   // 0..4      brightness falloff with distance from the edge
const float bandWidth       = 0.075; // 0.03..0.3 width of one ornament band, units
const float bandSpeed       = 0.35;  // -2..2     bands per second moving outward (negative = inward)
const float motifScale      = 0.06;  // 0.02..0.3 length of one motif repeat along the edge, units
const float motifDrift      = 0.15;  // -1..1     motifs slide along the edges, repeats per second
const float lineWidthPx     = 1.6;   // 0.5..4    line thickness in pixels (at 1080p; scales with resolution)
const float glowPx          = 5.0;   // 1..20     glow halo radius in pixels (at 1080p)
const float glowIntensity   = 0.9;   // 0..2      halo strength + gold edge line
const float gridAmount      = 0.35;  // 0..1      faint triangular sacred-geometry grid in the aura
const float gridScale       = 0.16;  // 0.05..0.5 grid cell size, units
const float paletteSpeed    = 0.04;  // 0..0.5    how fast colors shift through the bands, colors per second
const float colorMute       = 0.35;  // 0..1      0 = full saturation, 1 = gray (tones the bands down)
const float colorBrightness = 0.75;  // 0.2..1.5  brightness of the bands (the edge light is separate)
const float edgeLight       = 1.4;   // 0..3      brightness of the light line on each edge
const float videoColorMix   = 0.15;  // 0..1      0 = palette colors, 1 = video colors
const float effectMix       = 0.6;   // 0..1      0 = original, 0.5 = ornament over video, 1 = ornament only
const float chromaticAmount = 0.5;   // 0..1      RGB split across edges (max ~3 px)
const int   maskMode        = 0;     // 0 = everywhere, 1 = only on video edges, 2 = only away from edges
const float edgeStep        = 1.5;   // 1..3      texels between gradient taps (>1 = built-in pre-blur)
const float audioBass       = 0.0;   // 0..1      no audio in the harness yet: wire a uniform here later
const float audioTreble     = 0.0;   // 0..1      (bass -> growth + band speed, treble -> glow)

// ---------------------------------------------------------------------------
// Presets (copy over the values above)
//   Subtle:    reach 0.25, bandWidth 0.06, bandSpeed 0.15, falloff 2.5,
//              glowIntensity 0.5, gridAmount 0.0, effectMix 0.4,
//              videoColorMix 0.5, chromaticAmount 0.2
//   Hypnotic:  reach 0.5, bandWidth 0.07, bandSpeed 0.35, motifScale 0.05,
//              motifDrift 0.25, glowIntensity 1.0, gridAmount 0.5,
//              effectMix 0.7, videoColorMix 0.1
//   Explosive: growthSpeed 0.7, reach 0.75, falloff 0.5, bandWidth 0.05,
//              bandSpeed 1.2, motifDrift -0.6, lineWidthPx 2.5, glowPx 9,
//              glowIntensity 1.7, gridAmount 0.8, effectMix 0.9,
//              chromaticAmount 1.0, edgeThreshold 0.04
// ---------------------------------------------------------------------------

// ============================================================================
// Helpers
// ============================================================================
const float TAU        = 6.28318531;
const vec3  LUMA       = vec3(0.2126, 0.7152, 0.0722);
const float UPDATE_HZ  = 30.0;   // distance-field updates per second (fixed, so growth
                                 // speed does not depend on the frame rate)
const float SEED_WIDTH = 0.008;  // units; how sharply edges anchor the distance field

// sRGB <-> linear (pow 2.2 approximation; swap for the exact piecewise curve if needed)
vec3 toLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 toSrgb(vec3 c)   { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

float lumaAt(vec2 uv) { return dot(texture(u_tex, uv).rgb, LUMA); }

// Band colors (sRGB): earthy reds, blues and yellows with a few in-between
// tones. Order alternates warm/cool so neighboring bands always contrast.
const vec3 PALETTE[8] = vec3[8](
    vec3(0.80, 0.20, 0.16),   // red
    vec3(0.18, 0.36, 0.78),   // blue
    vec3(0.92, 0.74, 0.22),   // yellow
    vec3(0.14, 0.55, 0.58),   // teal
    vec3(0.88, 0.45, 0.15),   // orange
    vec3(0.42, 0.24, 0.62),   // violet
    vec3(0.62, 0.70, 0.25),   // olive green
    vec3(0.70, 0.22, 0.42)    // magenta-rose
);

// Palette lookup with x continuous: mostly flat colors, short soft blends
// between neighbors (so the slow color shift never pops).
vec3 paletteAt(float x) {
    float i = floor(x);
    float f = smoothstep(0.8, 1.0, fract(x));
    vec3 a = PALETTE[int(mod(i, 8.0))];
    vec3 b = PALETTE[int(mod(i + 1.0, 8.0))];
    vec3 c = mix(a, b, f);
    c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), clamp(colorMute, 0.0, 1.0));  // tone down
    return c * colorBrightness;
}

// triangle wave: 1 at integers, 0 halfway; piecewise linear (sharp corners)
float tri01(float x) { return abs(fract(x) - 0.5) * 2.0; }

// Anti-aliased line of constant pixel width. v = signed distance to the curve
// (any units), dv = how much v changes per pixel. Returns (core, glow halo).
vec2 lineAA(float v, float dv, float widthPx, float haloPx) {
    float px = abs(v) / max(dv, 1e-6);
    return vec2(1.0 - smoothstep(0.5 * widthPx - 0.5, 0.5 * widthPx + 0.5, px),
                exp(-px / haloPx));
}

// 4-tap diagonal gradient on luma, taps spaced by d (uv). With d > 1 texel every
// tap is a bilinear average of 4 texels: a light pre-blur against compression
// noise for free. A hard 0 -> 1 step gives magnitude ~1.
vec2 gradient4(vec2 uv, vec2 d) {
    float tl = lumaAt(uv + vec2(-d.x,  d.y));
    float tr = lumaAt(uv + vec2( d.x,  d.y));
    float bl = lumaAt(uv + vec2(-d.x, -d.y));
    float br = lumaAt(uv + vec2( d.x, -d.y));
    return vec2((tr + br) - (tl + bl), (tl + tr) - (bl + br)) * 0.5;
}

// State <-> alpha. alpha = (1 + q) / 255 with q = 0..254 -> distance 0..reach.
// A valid output never has alpha 0; alpha 0 means "cleared buffer" -> far.
float decodeDist(float a) {
    return a < 0.5 / 255.0 ? reach : clamp((a * 255.0 - 1.0) / 254.0, 0.0, 1.0) * reach;
}
float encodeDist(float d) {
    return (1.0 + floor(clamp(d / reach, 0.0, 1.0) * 254.0 + 0.5)) / 255.0;
}
float distAt(vec2 uv) { return decodeDist(texture(u_prev, uv).a); }

vec3 softClip(vec3 x) {   // identity below 0.8, smooth shoulder up to 1.0
    const float k = 0.8;
    vec3 over = max(x - k, 0.0);
    return min(x, k) + (1.0 - k) * (1.0 - exp(-over / (1.0 - k)));
}

// ============================================================================
// Effect
// ============================================================================
vec4 effect(vec2 uv) {
    vec4 src = texture(u_tex, uv);                  // 1 sample: the exact input
    if (eff_int <= 0.0) return src;                 // exact pass-through, state -> far

    float strength = clamp(eff_int, 0.0, 1.0);
    float dt     = clamp(u_dt, 0.0, 0.1);
    float t      = u_time;
    float bass   = clamp(audioBass, 0.0, 1.0);
    float treble = clamp(audioTreble, 0.0, 1.0);
    vec2  texel  = 1.0 / u_res;
    float unitPx = 0.5 * min(u_res.x, u_res.y);     // pixels per unit
    vec2  toUv   = vec2(unitPx) / u_res;            // units -> uv offset
    vec2  p      = (uv - 0.5) / toUv;               // this pixel, in units
    float pxScale = unitPx / 540.0;                 // line widths are specified at 1080p

    // ---------- 1. edges (4 samples) ----------
    vec2  gLoc      = gradient4(uv, texel * edgeStep);
    float edge      = smoothstep(edgeThreshold, edgeThreshold + edgeSoftness, length(gLoc));
    float localWide = smoothstep(edgeThreshold * 0.5, edgeThreshold + edgeSoftness * 2.0, length(gLoc));
    // Seed distance: 0 on strong edges, growing smoothly as the edge weakens
    // (no hard threshold -> no flicker at the threshold).
    float seedD = SEED_WIDTH * (1.0 - edge) / max(edge, 1e-3);

    // ---------- 2. distance field via feedback (9 samples) ----------
    float qStep = reach / 254.0;                                          // one stored level
    float R     = max(growthSpeed * (1.0 + 0.5 * bass) / UPDATE_HZ, 1.0 / unitPx);  // step, units
    vec2  o     = R * toUv;                                               // step, uv
    const float S = 0.70710678;
    float dC  = distAt(uv);
    float dE  = distAt(uv + vec2( o.x, 0.0));
    float dW  = distAt(uv + vec2(-o.x, 0.0));
    float dN  = distAt(uv + vec2(0.0,  o.y));
    float dS  = distAt(uv + vec2(0.0, -o.y));
    float dNE = distAt(uv + o * vec2( S,  S));
    float dNW = distAt(uv + o * vec2(-S,  S));
    float dSE = distAt(uv + o * vec2( S, -S));
    float dSW = distAt(uv + o * vec2(-S, -S));

    // Direction away from the nearest edge (gradient of the distance field).
    vec2 gD = vec2((dE - dW) + S * ((dNE + dSE) - (dNW + dSW)),
                   (dN - dS) + S * ((dNE + dNW) - (dSE + dSW)));
    vec2 nAway = gD / max(length(gD), 1e-6);

    // Fixed-rate updates: growth speed is independent of the frame rate.
    // Update when a 1/UPDATE_HZ tick boundary falls inside this frame.
    bool  doUpdate = fract(t * UPDATE_HZ) < dt * UPDATE_HZ;
    float d = dC;
    if (doUpdate) {
        float nbMin = min(min(min(dE, dW), min(dN, dS)), min(min(dNE, dNW), min(dSE, dSW))) + R;
        // A pixel no longer supported by an edge drifts "farther" (dissolving
        // over fadeTime). Not while an edge seeds it: camera noise near a
        // real edge then can't make the distance (and the pattern) wobble.
        float rise = max(reach / (max(fadeTime, 0.1) * UPDATE_HZ), 1.01 * qStep);
        d = min(dC + rise * step(0.5 * reach, seedD), nbMin);
    }
    d = clamp(min(d, seedD), 0.0, reach);

    // ---------- 3. angular ornament, mirror-symmetric about every edge ----------
    // Along-edge coordinate x (0..1, zigzag): a triangle wave along whichever of
    // 4 lattice directions (0/45/90/135 deg) best matches the edge direction,
    // evaluated at the foot point on the edge. Both mirror sides share the foot
    // point and the direction, so they get the same x.
    vec2  foot    = p - d * nAway;
    vec2  tangent = vec2(-nAway.y, nAway.x);
    vec2  ax      = abs(tangent);
    float diagA   = abs(tangent.x + tangent.y) * S;
    float diagB   = abs(tangent.x - tangent.y) * S;
    vec2  dir     = ax.x >= max(ax.y, max(diagA, diagB)) ? vec2(1.0, 0.0)
                  : ax.y >= max(diagA, diagB)            ? vec2(0.0, 1.0)
                  : diagA >= diagB                       ? vec2(S, S) : vec2(S, -S);
    float x = tri01(dot(foot, dir) / max(motifScale, 1e-3) + t * motifDrift);

    // Bands: phase grows with distance and moves outward over time.
    float phase = d / max(bandWidth, 1e-3) - t * bandSpeed * (1.0 + bass);
    float band  = floor(phase);                     // band index (motif + color)
    float y     = fract(phase);                     // 0..1 across the band

    float fwP = fwidth(phase);                      // per-pixel change, used for
    float fwX = fwidth(x);                          // constant-width lines
    float wPx = lineWidthPx * pxScale;
    float hPx = glowPx * pxScale;

    // Motif 0: ladder (two rails + rungs)
    float inRails = smoothstep(0.18, 0.22, y) * (1.0 - smoothstep(0.78, 0.82, y));
    vec2 m0 = max(max(lineAA(y - 0.2, fwP, wPx, hPx), lineAA(y - 0.8, fwP, wPx, hPx)),
                  lineAA(x - 0.5, fwX, wPx, hPx) * inRails);
    float f0 = 0.0;
    // Motif 1: crossing zigzags -> triangles and diamonds
    float c1 = 0.15 + 0.7 * x, c2 = 0.85 - 0.7 * x;
    float dv1 = fwP + 0.7 * fwX;
    vec2 m1 = max(lineAA(y - c1, dv1, wPx, hPx), lineAA(y - c2, dv1, wPx, hPx));
    float f1 = step(min(c1, c2), y) * step(y, max(c1, c2));           // diamond interiors
    // Motif 2: square battlements (square wave) with filled blocks
    float sq  = smoothstep(0.42, 0.58, x);
    float sqs = clamp((x - 0.42) / 0.16, 0.0, 1.0);
    float lvl = mix(0.25, 0.75, sq);
    float dv2 = fwP + 0.5 * (6.0 * sqs * (1.0 - sqs) / 0.16) * fwX;
    vec2 m2 = max(lineAA(y - lvl, dv2, wPx, hPx), lineAA(y - 0.25, fwP, wPx, hPx) * 0.6);
    float f2 = step(0.25, y) * step(y, lvl);
    // Motif 3: double wave (braided helix)
    float cw  = 0.28 * cos(x * TAU);
    float dv3 = fwP + 0.28 * TAU * abs(sin(x * TAU)) * fwX;
    vec2 m3 = max(lineAA(y - 0.5 - cw, dv3, wPx, hPx), lineAA(y - 0.5 + cw, dv3, wPx, hPx));
    float f3 = step(0.5 - abs(cw), y) * step(y, 0.5 + abs(cw)) * 0.6;

    // Pick this band's motif. More motifs unlock as eff_int builds up
    // (a locked motif falls back to the ladder).
    float id = mod(band, 4.0);
    float g1 = smoothstep(0.20, 0.35, strength);
    float g2 = smoothstep(0.40, 0.55, strength);
    float g3 = smoothstep(0.60, 0.75, strength);
    vec2  lines = m0;
    float fill  = f0;
    if (id > 0.5 && id < 1.5) { lines = mix(m0, m1, g1); fill = f1 * g1; }
    if (id > 1.5 && id < 2.5) { lines = mix(m0, m2, g2); fill = f2 * g2; }
    if (id > 2.5)             { lines = mix(m0, m3, g3); fill = f3 * g3; }

    // Sacred-geometry grid: three line families at 60 deg -> triangles.
    vec2 gq = p / max(gridScale, 1e-3);
    float ga = dot(gq, vec2(1.0, 0.0)), gb = dot(gq, vec2(0.5, 0.8660254)), gc = dot(gq, vec2(-0.5, 0.8660254));
    float grid = max(max(lineAA(fract(ga + 0.5) - 0.5, fwidth(ga), wPx * 0.7, hPx).x,
                         lineAA(fract(gb + 0.5) - 0.5, fwidth(gb), wPx * 0.7, hPx).x),
                         lineAA(fract(gc + 0.5) - 0.5, fwidth(gc), wPx * 0.7, hPx).x);

    // Reach grows with eff_int: the aura extends outward while the viewer is
    // still and collapses back to the edges when they move.
    float visReach = reach * (0.15 + 0.85 * strength);
    float envelope = (1.0 - smoothstep(0.7 * visReach, visReach, d)) * exp(-(d / reach) * falloff);
    float ridge    = exp(-d / 0.012) * edgeLight * (1.0 + 1.5 * treble);  // bright light on the edge

    // ---------- 4. color ----------
    vec3 vLin    = toLinear(src.rgb);
    // Each band steps 3 colors along the palette (red -> teal -> magenta -> ...),
    // so neighboring bands differ; the whole set drifts slowly over time.
    float ci     = band * 3.0 + t * paletteSpeed;
    vec3 colLine = toLinear(paletteAt(ci));
    vec3 colFill = toLinear(paletteAt(ci + 2.0)) * 0.8;              // contrasting fill
    vec3 vChroma = vLin / (max(max(vLin.r, vLin.g), vLin.b) + 0.05);  // video hue at full brightness
    colLine = mix(colLine, vChroma, videoColorMix);
    colFill = mix(colFill, vChroma, videoColorMix);
    // Edge light: near-white warm core, tinted slightly by the first band's color.
    vec3 edgeCol = mix(vec3(1.0, 0.93, 0.80), toLinear(paletteAt(t * paletteSpeed)) / max(colorBrightness, 0.2), 0.25);

    float halo = lines.y * 0.35 * glowIntensity * (1.0 + treble);
    vec3 orn = (colLine * (lines.x + halo) + colFill * fill * 0.18) * envelope
             + colLine * grid * gridAmount * 0.35 * envelope * smoothstep(0.5, 0.9, strength)
             + edgeCol * ridge;

    // ---------- 6. chromatic aberration across edges (0 or 2 samples) ----------
    vec3  vid  = vLin;
    float caPx = 3.0 * chromaticAmount * edge * strength;
    if (caPx > 0.05) {
        vec2 off = nAway * texel * caPx;
        vid.r = toLinear(texture(u_tex, uv + off).rgb).r;
        vid.b = toLinear(texture(u_tex, uv - off).rgb).b;
    }

    // ---------- 5. compositing ----------
    float mask = maskMode == 1 ? localWide : (maskMode == 2 ? 1.0 - localWide : 1.0);
    vec3  M    = orn * mask;
    float e    = clamp(effectMix, 0.0, 1.0);
    // 0 -> video, 0.5 -> video + ornament, 1 -> ornament only
    vec3 comp  = vid * (1.0 - max(0.0, 2.0 * e - 1.0)) + M * min(1.0, 2.0 * e);
    comp = softClip(comp);

    vec3 outLin = mix(vLin, comp, strength);        // eff_int = overall strength
    return vec4(toSrgb(outLin), encodeDist(d));
}

// COST (texture samples per pixel): 1 input + 4 edges + 9 distance field
// + 2 aberration (only on edges) = 14..16. The motifs and grid are pure math.
// To cut cost (e.g. Quest with several effects chained):
//   - chromaticAmount = 0.0: the branch is skipped, -2 samples
//   - use only the 4 diagonal neighbors (dNE, dNW, dSE, dSW) for nbMin and gD:
//     -4 samples, the pattern around corners gets more square
// Known limits: around corners and dots the bands are slightly octagonal; on
// curved outlines the motif jumps where the edge direction switches lattice
// direction (every 45 deg), which reads as facets.
