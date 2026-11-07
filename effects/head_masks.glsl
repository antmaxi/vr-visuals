// Head masks: every face in view is covered by a mask that follows the person's head
// and tilts with it. Pick one with "mask": a glowing jack-o-lantern, skull, pig, ghost,
// alien, black cat, fox, robot, sun, moon, or a giant eyeball that stares at you. Or a
// mask made from the camera image: a black hole swallowing the head, a kaleidoscope of
// the face, a crystal ball, a disco ball reflecting the room, or anonymous pixels.
// "multiply" leaves the real head alone and surrounds it with small copies of it.
//
// Faces toward the camera, and people farther away or seen from the side, are found.

// Head positions come from heads.js through u_heads / u_headRoll / u_headCount.
// Each mask is drawn in head space: 1 unit = size * half the face box, y up, x along
// the eye line. The face box only spans eyebrows to chin, so the mask's centre sits
// "lift" face heights above the face centre to also cover the hair. Mask functions
// return (colour, coverage); everything stays inside radius 1.2 (the early-out below).
// The defaults reach from just below the chin to about one face height above the brows.
// Masks made from the camera image map head-space points back to the image with headToUv().

uniform float mask;   // @choice glass|pixelate|pumpkin|skull|pig|ghost|alien|cat|fox|robot|sun|moon|eyeball|blackhole|kaleidoscope|disco|multiply
                      // Which mask covers the faces. Glass (the default), pixelate, blackhole, kaleidoscope, disco and multiply are made from the camera image:
                      // blackhole swirls the room into a dark hole, kaleidoscope folds the person's
                      // own face, glass shows the room upside down in a crystal ball, disco reflects
                      // bits of the room in mirror tiles, pixelate hides the face behind big pixels.
                      // Multiply is different: the real head stays visible and copies of it circle
                      // around it (see "heads").
uniform float size;   // @param 1 3 2 Mask size compared with the detected face. At 2 the mask covers the
                      // whole head including hair and ears; lower values let the real head show around it.
uniform float lift;   // @param 0 0.6 0.3 Moves the mask up from the face toward the top of the head, in face
                      // heights. Raise it for big hair or hats. At 0 the mask is centred on the face: it
                      // reaches further down the neck and leaves the top of the hair showing.
uniform float glow;   // @param 0 1 0.6 The mask's light: pumpkin candle, skull embers, glowing eyes (alien,
                      // cat, robot, fox, eyeball), sun and moon halo, ghost aura, pig blush, the black
                      // hole's bright ring, glass highlights, disco sparkles, kaleidoscope colour boost,
                      // a different colour tint on each copy of the multiply mask.
                      // 0 = none. Pixelate ignores it.
uniform float detail; // @param 0 1 0.5 Shading and fine detail: ribs, shadows, outlines, veins in the eyeball,
                      // tile gaps on the disco ball, the gold rim of the kaleidoscope, how hard the black
                      // hole swirls, the light rim around each copy of the multiply mask. For pixelate:
                      // 0 = 4 huge pixels across, 1 = 16 smaller ones.
uniform float opaqueness; // @param 0 1 1 How solid the masks are at a given eff_int. At 1 the masks are
                          // solid from eff_int 0.1 up; at 0.7 from 0.37 up; at 0 the opacity equals eff_int
                          // (see-through at low intensity). They always vanish at eff_int 0.
uniform float heads;  // @int 2 12 5 How many heads you see in total, the real one plus the copies around it
                      // (5 = the real head and 4 copies). The more heads, the smaller each copy, so the
                      // ring stays about the same size. The copies' size and distance also follow "size".
                      // @when mask=multiply

const vec3 LIGHT = vec3(-0.45, 0.55, 0.7);

float fill(float d, float aa) { return 1.0 - smoothstep(-aa, aa, d); }

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }   // counter-clockwise

float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

// The current head, set in effect() before each mask is drawn.
vec2 g_center;     // face centre, uv
float g_scale;     // 1 head unit in uv height units
float g_cos, g_sin;  // the head's tilt
float g_shift;     // the "lift", in head units

// Head-space point -> image uv (inverse of the mapping in effect()).
vec2 headToUv(vec2 p) {
    vec2 d = p + vec2(0.0, g_shift);
    d = vec2(g_cos * d.x - g_sin * d.y, g_sin * d.x + g_cos * d.y);
    return g_center + d * g_scale / vec2(u_res.x / u_res.y, 1.0);
}

float sdEllipse(vec2 p, vec2 r) {     // approximate; exact enough near the edge
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    return k0 * (k0 - 1.0) / max(k1, 1e-5);
}

float sdBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float sdTriangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
    vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
    vec2 q0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 q1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 q2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(q0, q0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(q1, q1), s * (v1.x * e1.y - v1.y * e1.x))),
                     vec2(dot(q2, q2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
}

float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

// Fake 3D lighting: treat the mask as a ball of radius r around c.
float ball(vec2 p, vec2 c, float r) {
    vec2 q = (p - c) / r;
    vec3 n = vec3(q, sqrt(max(1.0 - dot(q, q), 0.0)));
    return 0.45 + 0.55 * max(dot(n, normalize(LIGHT)), 0.0);
}

// Slow, gentle brightness drift for the lights (no flicker).
float pulse() { return 0.88 + 0.12 * sin(u_time * 1.3) * sin(u_time * 0.7 + 1.0); }

vec4 pumpkin(vec2 p, float aa) {
    // Body: five overlapping lobes; rib = distance from the nearest lobe's middle (dark creases).
    float body = 1e9, rib = 1e9;
    for (int i = -2; i <= 2; i++) {
        float fi = float(i);
        vec2 c = vec2(0.3 * fi, -0.08);
        vec2 r = vec2(0.42 - 0.04 * abs(fi), 0.78 - 0.07 * abs(fi));
        body = min(body, sdEllipse(p - c, r));
        float q = (p.x - c.x) / r.x;
        rib = min(rib, q * q);
    }
    vec2 sp = p - vec2(0.04, 0.78);
    sp.x -= 0.25 * sp.y;
    float stem = sdBox(sp, vec2(0.07, 0.14), 0.04);

    // Carved face: triangle eyes and nose, crescent mouth with three teeth.
    vec2 m = vec2(abs(p.x), p.y);
    float eyes = sdTriangle(m, vec2(0.14, 0.08), vec2(0.48, 0.08), vec2(0.30, 0.36));
    float nose = sdTriangle(p, vec2(-0.08, -0.12), vec2(0.08, -0.12), vec2(0.0, 0.02));
    float mouth = max(sdEllipse(p - vec2(0.0, -0.3), vec2(0.55, 0.28)),
                     -sdEllipse(p - vec2(0.0, -0.14), vec2(0.62, 0.26)));
    mouth = max(mouth, -sdBox(vec2(abs(p.x) - 0.18, p.y + 0.43), vec2(0.05, 0.045), 0.01));
    mouth = max(mouth, -sdBox(p - vec2(0.0, -0.54), vec2(0.05, 0.04), 0.01));
    float carve = min(min(eyes, nose), mouth);

    float light = ball(p, vec2(0.0, -0.08), 0.95);
    vec3 col = vec3(1.0, 0.45, 0.05) * light;
    col *= 1.0 - detail * 0.55 * smoothstep(0.15, 0.6, rib);
    col *= 1.0 - detail * 0.5 * smoothstep(-0.05, 0.0, body);

    vec3 candle = vec3(1.0, 0.75, 0.25) * 1.3 * pulse();
    col += candle * glow * 0.35 * exp(-max(carve, 0.0) * 20.0);   // light spilling out of the holes
    vec3 hole = mix(vec3(0.12, 0.03, 0.0), candle * (0.75 + 0.25 * smoothstep(0.0, 0.06, -carve)), glow);
    col = mix(col, hole, fill(carve, aa));

    vec3 stemCol = vec3(0.25, 0.33, 0.08) * ball(p, vec2(-0.2, 0.9), 0.5);
    col = mix(stemCol, col, fill(body, aa));
    return vec4(col, max(fill(body, aa), fill(stem, aa)));
}

vec4 skull(vec2 p, float aa) {
    float cranium = sdEllipse(p - vec2(0.0, 0.12), vec2(0.78, 0.8));
    float jaw = sdBox(p - vec2(0.0, -0.5), vec2(0.42, 0.3), 0.15);
    float d = smin(cranium, jaw, 0.15);

    vec2 m = vec2(abs(p.x), p.y);
    float sockets = sdEllipse(m - vec2(0.3, -0.02), vec2(0.22, 0.2));
    float nose = sdTriangle(p, vec2(0.0, -0.14), vec2(0.11, -0.36), vec2(-0.11, -0.36)) - 0.02;
    float holes = min(sockets, nose);
    float teeth = sdBox(p - vec2(0.0, -0.56), vec2(0.3, 0.1), 0.03);

    vec3 col = vec3(0.93, 0.9, 0.8) * ball(p, vec2(0.0, 0.0), 0.95);
    col *= 1.0 - detail * 0.4 * smoothstep(-0.25, 0.0, d);                        // rounded edge
    col *= 1.0 - detail * 0.35 * exp(-dot(m - vec2(0.5, -0.32), m - vec2(0.5, -0.32)) * 25.0);  // cheek hollows
    col *= 1.0 - detail * 0.4 * (1.0 - smoothstep(0.0, 0.08, holes)) * (1.0 - fill(holes, aa));          // shadow around holes

    // Teeth: gaps between the teeth and between the two rows.
    float gx = abs(fract(p.x * 6.0 + 0.5) - 0.5) / 6.0;
    float gap = min(gx, abs(p.y + 0.56));
    float inTeeth = fill(teeth, aa);
    col = mix(col, vec3(0.95, 0.9, 0.72) * ball(p, vec2(0.0, 0.0), 0.95), inTeeth);
    col = mix(col, vec3(0.1, 0.08, 0.06), inTeeth * fill(gap - 0.008, aa));
    col = mix(col, vec3(0.2, 0.17, 0.12), fill(abs(teeth) - 0.008, aa));            // outline of the teeth

    float ember = exp(-length(m - vec2(0.3, -0.04)) * 11.0) * glow * pulse();
    vec3 hole = vec3(0.04, 0.03, 0.03) + vec3(1.0, 0.3, 0.08) * 1.6 * ember * step(sockets, 0.0);
    col = mix(col, hole, fill(holes, aa));
    return vec4(col, fill(d, aa));
}

vec4 pig(vec2 p, float aa) {
    vec2 m = vec2(abs(p.x), p.y);
    float head = sdEllipse(p - vec2(0.0, -0.05), vec2(0.86, 0.76));
    float ear = sdTriangle(m, vec2(0.33, 0.52), vec2(0.8, 0.42), vec2(0.74, 0.95)) - 0.04;
    float earIn = sdTriangle(m, vec2(0.45, 0.55), vec2(0.72, 0.5), vec2(0.7, 0.82));
    float snout = sdEllipse(p - vec2(0.0, -0.28), vec2(0.34, 0.24));
    float nostrils = sdEllipse(m - vec2(0.12, -0.28), vec2(0.06, 0.1));
    float eyes = length(m - vec2(0.32, 0.15)) - 0.075;
    float shine = length(m - vec2(0.30, 0.175)) - 0.025;

    vec3 pink = vec3(1.0, 0.7, 0.74);
    vec3 earCol = pink * 0.9 * ball(p, vec2(0.0, 0.3), 1.2);
    earCol = mix(earCol, vec3(0.9, 0.45, 0.55), fill(earIn, aa));

    vec3 col = pink * ball(p, vec2(0.0, -0.05), 0.95);
    col *= 1.0 - detail * 0.4 * smoothstep(-0.06, 0.0, head);
    col = mix(col, vec3(1.0, 0.4, 0.5), glow * 0.6 * exp(-dot(m - vec2(0.56, -0.22), m - vec2(0.56, -0.22)) * 25.0));
    vec3 snoutCol = vec3(0.95, 0.52, 0.6) * ball(p, vec2(0.0, -0.28), 0.4);
    snoutCol *= 1.0 - detail * 0.4 * smoothstep(-0.04, 0.0, snout);
    col = mix(col, snoutCol, fill(snout, aa));
    col = mix(col, vec3(0.35, 0.1, 0.15), fill(nostrils, aa));
    col = mix(col, vec3(0.05), fill(eyes, aa));
    col = mix(col, vec3(1.0), fill(shine, aa));

    col = mix(earCol, col, fill(head, aa));
    return vec4(col, max(fill(head, aa), fill(ear, aa)));
}

vec4 ghost(vec2 p, float aa) {
    p.y -= 0.03 * sin(u_time * 1.2);                              // slow bob
    float hem = -0.88 + 0.06 * sin(p.x * 10.0 + u_time * 1.5);    // wavy bottom edge
    float d = min(length(p - vec2(0.0, 0.05)) - 0.8, sdBox(p - vec2(0.0, -0.45), vec2(0.8, 0.5), 0.0));
    d = max(d, hem - p.y);
    vec2 m = vec2(abs(p.x), p.y);
    float eyes = sdEllipse(m - vec2(0.26, 0.15), vec2(0.11, 0.16));
    float mouth = sdEllipse(p - vec2(0.0, -0.22), vec2(0.12, 0.17));

    vec3 col = vec3(0.95, 0.97, 1.0) * ball(p, vec2(0.0, 0.05), 1.0);
    col *= 1.0 - detail * 0.18 * (0.5 + 0.5 * sin(p.x * 14.0)) * (1.0 - smoothstep(-0.7, 0.0, p.y));  // folds
    col *= 1.0 - detail * 0.3 * smoothstep(-0.06, 0.0, d);
    col = mix(col, vec3(0.03, 0.03, 0.06), fill(min(eyes, mouth), aa));
    float body = fill(d, aa);
    float aura = glow * 0.5 * exp(-max(d, 0.0) * 14.0) * (1.0 - body);
    col = mix(vec3(0.55, 0.85, 1.0), col, body);
    return vec4(col, body + aura);
}

vec4 alien(vec2 p, float aa) {
    float d = smin(length(p - vec2(0.0, 0.18)) - 0.74, sdEllipse(p - vec2(0.0, -0.52), vec2(0.28, 0.32)), 0.4);
    vec2 m = vec2(abs(p.x), p.y);
    vec2 e = rot(-0.45) * (m - vec2(0.3, -0.02));    // almond eyes, outer ends up
    float eye = sdEllipse(e, vec2(0.25, 0.12));
    float shine = length(e - vec2(-0.08, 0.04)) - 0.035;
    float mouth = sdEllipse(p - vec2(0.0, -0.52), vec2(0.09, 0.012));

    vec3 col = vec3(0.45, 0.85, 0.4) * ball(p, vec2(0.0, 0.1), 0.95);
    col *= 1.0 - detail * 0.4 * smoothstep(-0.06, 0.0, d);
    col = mix(col, vec3(0.15, 0.35, 0.15), fill(mouth, aa));
    float ek = clamp(length(e / vec2(0.25, 0.12)), 0.0, 1.0);
    vec3 eyeCol = vec3(0.02, 0.03, 0.03) + vec3(0.1, 0.9, 0.6) * glow * 0.6 * pulse() * (1.0 - ek);
    col = mix(col, eyeCol, fill(eye, aa));
    col = mix(col, vec3(1.0), 0.9 * fill(shine, aa));
    return vec4(col, fill(d, aa));
}

vec4 cat(vec2 p, float aa) {   // black cat with glowing eyes
    vec2 m = vec2(abs(p.x), p.y);
    float head = sdEllipse(p - vec2(0.0, -0.08), vec2(0.84, 0.7));
    float ear = sdTriangle(m, vec2(0.28, 0.45), vec2(0.8, 0.3), vec2(0.66, 0.98)) - 0.03;
    float earIn = sdTriangle(m, vec2(0.4, 0.5), vec2(0.7, 0.42), vec2(0.63, 0.82));
    float eye = sdEllipse(m - vec2(0.3, 0.06), vec2(0.17, 0.12));
    float pupil = sdEllipse(m - vec2(0.3, 0.06), vec2(0.03, 0.1));
    float nose = sdTriangle(p, vec2(-0.07, -0.13), vec2(0.07, -0.13), vec2(0.0, -0.21)) - 0.01;
    float mouth = max(abs(length(m - vec2(0.07, -0.25)) - 0.07) - 0.012, p.y + 0.25);
    float whiskers = 1e9;
    for (int k = -1; k <= 1; k++) {
        float fk = float(k);
        float y = -0.2 + 0.06 * fk + (m.x - 0.32) * 0.18 * fk;   // fanning out
        whiskers = min(whiskers, max(abs(m.y - y) - 0.007, abs(m.x - 0.62) - 0.3));
    }

    vec3 fur = vec3(0.13, 0.12, 0.15);
    vec3 col = fur * (0.6 + 0.9 * ball(p, vec2(0.0, -0.08), 0.9));
    col += vec3(0.25, 0.25, 0.32) * detail * smoothstep(-0.08, 0.0, head);   // rim light
    vec3 eyeLight = vec3(0.7, 0.95, 0.2) * pulse();
    col += eyeLight * glow * 0.3 * exp(-max(eye, 0.0) * 18.0);
    col = mix(col, eyeLight * (0.55 + 0.6 * glow), fill(eye, aa));
    col = mix(col, vec3(0.02), fill(pupil, aa));
    col = mix(col, vec3(0.85, 0.45, 0.5), fill(nose, aa));
    col = mix(col, vec3(0.7, 0.7, 0.72), fill(mouth, aa));
    vec3 earCol = mix(fur * ball(p, vec2(0.0, 0.3), 1.2), vec3(0.5, 0.28, 0.33), fill(earIn, aa));
    col = mix(earCol, col, fill(head, aa));
    col = mix(col, vec3(0.75, 0.75, 0.78), fill(whiskers, aa));
    return vec4(col, max(max(fill(head, aa), fill(ear, aa)), fill(whiskers, aa)));
}

vec4 fox(vec2 p, float aa) {
    vec2 m = vec2(abs(p.x), p.y);
    float head = smin(sdEllipse(p - vec2(0.0, 0.08), vec2(0.8, 0.55)),
                      sdTriangle(p, vec2(-0.6, 0.0), vec2(0.6, 0.0), vec2(0.0, -0.82)) - 0.05, 0.15);
    head = smin(head, sdEllipse(p - vec2(0.0, -0.3), vec2(0.62, 0.5)), 0.1);   // full cheeks
    float ear = sdTriangle(m, vec2(0.22, 0.45), vec2(0.75, 0.35), vec2(0.6, 1.02)) - 0.03;
    float earIn = sdTriangle(m, vec2(0.34, 0.5), vec2(0.66, 0.44), vec2(0.58, 0.85));
    float cheeks = sdEllipse(m - vec2(0.36, -0.22), vec2(0.36, 0.26));
    float muzzle = sdTriangle(p, vec2(-0.25, -0.15), vec2(0.25, -0.15), vec2(0.0, -0.8)) - 0.04;
    float chin = sdEllipse(p - vec2(0.0, -0.55), vec2(0.45, 0.3));
    float white = max(min(min(cheeks, muzzle), chin), head);
    vec2 e = rot(-0.35) * (m - vec2(0.28, 0.12));
    float eye = sdEllipse(e, vec2(0.13, 0.065));
    float nose = sdEllipse(p - vec2(0.0, -0.74), vec2(0.09, 0.06));

    vec3 col = vec3(0.95, 0.5, 0.15) * ball(p, vec2(0.0, 0.0), 0.95);
    col = mix(col, vec3(0.97, 0.95, 0.9) * ball(p, vec2(0.0, -0.2), 0.9), fill(white, aa));
    col *= 1.0 - detail * 0.35 * smoothstep(-0.06, 0.0, head);
    vec3 eyeCol = mix(vec3(0.06, 0.04, 0.02), vec3(0.95, 0.65, 0.1) * (0.6 + 0.7 * glow), fill(length(e) - 0.05, aa));
    eyeCol = mix(eyeCol, vec3(0.0), fill(length(e) - 0.022, aa));
    col = mix(col, eyeCol, fill(eye, aa));
    col = mix(col, vec3(0.05), fill(nose, aa));
    vec3 earCol = mix(vec3(0.9, 0.45, 0.13) * ball(p, vec2(0.0, 0.4), 1.2), vec3(0.22, 0.1, 0.06), fill(earIn, aa));
    col = mix(earCol, col, fill(head, aa));
    return vec4(col, max(fill(head, aa), fill(ear, aa)));
}

vec4 robot(vec2 p, float aa) {
    vec2 m = vec2(abs(p.x), p.y);
    float head = sdBox(p - vec2(0.0, -0.02), vec2(0.7, 0.68), 0.16);
    float bolts = sdBox(m - vec2(0.76, -0.02), vec2(0.07, 0.15), 0.03);
    float stick = sdBox(p - vec2(0.0, 0.8), vec2(0.025, 0.12), 0.01);
    float bulb = length(p - vec2(0.0, 0.97)) - 0.08;
    float eye = length(m - vec2(0.3, 0.12)) - 0.14;
    float grille = sdBox(p - vec2(0.0, -0.4), vec2(0.38, 0.12), 0.04);
    float slots = max(grille + 0.03, abs(fract(p.x * 7.0) - 0.5) / 7.0 - 0.025);
    float rivets = min(length(m - vec2(0.58, 0.54)), length(m - vec2(0.58, -0.58))) - 0.035;

    vec3 metal = vec3(0.62, 0.67, 0.74);
    float light = ball(p, vec2(0.0), 1.0);
    vec3 col = metal * light;
    col *= 1.0 - detail * 0.35 * smoothstep(-0.05, 0.0, head);
    col *= 1.0 - detail * 0.5 * fill(abs(p.y - 0.36) - 0.008, aa);     // panel seam
    col = mix(col, metal * 0.55, detail * fill(rivets, aa));
    vec3 led = vec3(0.2, 0.9, 1.0) * pulse();
    float er = clamp(length(m - vec2(0.3, 0.12)) / 0.14, 0.0, 1.0);
    col += led * glow * 0.25 * exp(-max(eye, 0.0) * 20.0);
    col = mix(col, mix(vec3(0.05, 0.07, 0.1), led * (1.3 - 0.8 * er), glow), fill(eye, aa));
    col = mix(col, vec3(0.15, 0.16, 0.18), fill(grille, aa));
    col = mix(col, metal * 0.7, fill(slots, aa));
    vec3 outside = mix(metal * 0.7 * light, vec3(1.0, 0.2, 0.15) * (0.5 + 0.9 * glow * pulse()), fill(bulb, aa));
    col = mix(outside, col, fill(head, aa));
    return vec4(col, max(max(fill(head, aa), fill(bolts, aa)), max(fill(stick, aa), fill(bulb, aa))));
}

vec4 sun(vec2 p, float aa) {
    float r = length(p);
    float a = (atan(p.y, p.x) + u_time * 0.15) * 12.0 / 6.2832;        // rays turn slowly
    float tri = abs(fract(a) - 0.5) * 2.0;                               // 1 at a ray's tip
    float rays = r - (0.64 + (0.3 - 0.1 * mod(floor(a), 2.0)) * tri);    // long and short rays
    float disc = r - 0.62;
    vec2 m = vec2(abs(p.x), p.y);
    float eyes = max(abs(length(m - vec2(0.22, 0.05)) - 0.09) - 0.02, 0.05 - m.y);   // happy closed eyes
    float smile = max(abs(length(p - vec2(0.0, -0.05)) - 0.3) - 0.025, p.y + 0.15);

    vec3 discCol = mix(vec3(1.0, 0.92, 0.35), vec3(1.0, 0.6, 0.08), smoothstep(0.2, 0.62, r));
    discCol *= 1.0 - detail * 0.3 * smoothstep(0.4, 0.62, r);
    discCol = mix(discCol, vec3(1.0, 0.45, 0.3), 0.5 * glow * exp(-dot(m - vec2(0.38, -0.12), m - vec2(0.38, -0.12)) * 40.0));
    discCol = mix(discCol, vec3(0.45, 0.2, 0.02), fill(min(eyes, smile), aa));
    vec3 col = mix(vec3(1.0, 0.5, 0.05) * (0.7 + 0.5 * glow * pulse()), discCol, fill(disc, aa));
    float body = max(fill(disc, aa), fill(rays, aa));
    float halo = glow * 0.45 * exp(-max(rays, 0.0) * 10.0) * (1.0 - body);
    col = mix(vec3(1.0, 0.7, 0.2), col, body);
    return vec4(col, body + halo);
}

vec4 moon(vec2 p, float aa) {   // crescent moon on a round patch of night sky
    float sky = length(p) - 0.9;
    float crescent = max(length(p - vec2(-0.05, 0.0)) - 0.78, -(length(p - vec2(0.3, 0.14)) - 0.66));
    float eye = max(abs(length(p - vec2(-0.6, 0.26)) - 0.07) - 0.015, p.y - 0.26);   // sleepy closed eye
    float smile = max(abs(length(p - vec2(-0.58, -0.1)) - 0.08) - 0.015, p.y + 0.1);
    float craters = min(min(length(p - vec2(-0.55, -0.5)) - 0.06, length(p - vec2(-0.42, 0.55)) - 0.05),
                        length(p - vec2(-0.68, -0.32)) - 0.04);

    vec3 col = vec3(0.04, 0.06, 0.17) * (1.0 - 0.35 * length(p));
    for (int k = 0; k < 5; k++) {
        float fk = float(k);
        vec2 sp = vec2(hash21(vec2(fk, 1.0)), hash21(vec2(fk, 2.0)));
        vec2 q = p - (vec2(0.3, 0.14) + (sp - 0.5) * 0.7);            // inside the dark "bite"
        float star = exp(-dot(q, q) * 1500.0) + 0.6 * exp(-abs(q.x) * 90.0 - abs(q.y) * 9.0)
                   + 0.6 * exp(-abs(q.y) * 90.0 - abs(q.x) * 9.0);
        col += vec3(0.9, 0.9, 1.0) * star * (0.75 + 0.25 * sin(u_time * 0.9 + fk * 2.1));
    }
    col += vec3(0.55, 0.6, 0.4) * glow * 0.5 * exp(-max(crescent, 0.0) * 9.0);
    vec3 moonCol = vec3(0.98, 0.94, 0.72) * ball(p, vec2(-0.05, 0.0), 0.8);
    moonCol *= 1.0 - detail * 0.25 * fill(craters, aa);
    moonCol = mix(moonCol, vec3(1.0, 0.6, 0.55), 0.4 * exp(-dot(p - vec2(-0.68, 0.06), p - vec2(-0.68, 0.06)) * 120.0));
    moonCol = mix(moonCol, vec3(0.35, 0.3, 0.15), fill(min(eye, smile), aa));
    col = mix(col, moonCol, fill(crescent, aa));
    return vec4(col, fill(sky, aa));
}

vec4 eyeball(vec2 p, float aa) {   // the pupil looks toward the middle of the view, i.e. at the viewer
    float r = length(p);
    vec2 toC = (vec2(0.5) - g_center) * vec2(u_res.x / u_res.y, 1.0);
    toC = vec2(g_cos * toC.x + g_sin * toC.y, -g_sin * toC.x + g_cos * toC.y);    // into head space
    vec2 look = toC / max(length(toC), 1e-3) * min(length(toC) * 1.2, 0.3);
    look += 0.04 * vec2(sin(u_time * 0.37), sin(u_time * 0.29 + 1.0));            // slow wander
    vec2 q = p - look;
    float rq = length(q);

    vec3 col = vec3(0.97, 0.95, 0.92) * ball(p, vec2(0.0), 0.85);
    float ang = atan(p.y, p.x);
    float vein = smoothstep(0.92, 1.0, abs(sin(ang * 9.0 + 3.0 * sin(r * 7.0 + ang * 2.0)))) * smoothstep(0.4, 0.82, r);
    col = mix(col, vec3(0.8, 0.15, 0.12), detail * 0.7 * vein);
    col *= 1.0 - detail * 0.3 * smoothstep(0.6, 0.85, r);
    float pupilR = 0.13 + 0.02 * sin(u_time * 0.5);
    vec3 iris = mix(vec3(0.05, 0.35, 0.3), vec3(0.35, 0.85, 0.5), smoothstep(pupilR, 0.34, rq));
    iris *= (1.0 - 0.15 * detail + 0.15 * detail * sin(atan(q.y, q.x) * 40.0)) * (0.7 + 0.6 * glow);
    col = mix(col, vec3(0.05, 0.15, 0.1), fill(rq - 0.345, aa));
    col = mix(col, iris, fill(rq - 0.32, aa));
    col = mix(col, vec3(0.01), fill(rq - pupilR, aa));
    col = mix(col, vec3(1.0), 0.9 * fill(length(q - vec2(-0.1, 0.1)) - 0.045, aa));
    return vec4(col, fill(r - 0.85, aa));
}

vec4 blackhole(vec2 p, float aa) {
    float r = length(p);
    float t = clamp((r - 0.42) / 0.53, 0.0, 1.0);     // 0 at the horizon, 1 at the outer edge
    float k = (1.0 - t) * (1.0 - t) * (1.0 - t);
    float swirl = k * (1.0 + 2.5 * detail) * (1.0 + 0.3 * sin(u_time * 0.25));
    float rs = r + 0.35 * k;                           // lensing: shows what is further out
    vec2 sp = rot(swirl) * (p / max(r, 1e-4)) * rs;
    vec3 col = texture(u_tex, headToUv(sp)).rgb;
    col = col * (0.6 + 0.4 * t) + vec3(1.0, 0.6, 0.25) * glow * 0.8 * k;   // light piling up near the hole
    col += vec3(1.0, 0.85, 0.6) * glow * 1.5 * exp(-abs(r - 0.44) * 60.0);  // photon ring
    col = mix(col, vec3(0.0), fill(r - 0.42, aa));
    return vec4(col, 1.0 - smoothstep(0.8, 0.95, r));
}

vec4 kaleidoscope(vec2 p, float aa) {
    float r = length(p);
    float seg = 6.2832 / 6.0;
    float a = mod(atan(p.y, p.x) + u_time * 0.1, seg);
    a = abs(a - seg * 0.5) + 1.309;                    // mirrored wedge, pointing up from the face centre
    vec2 sp = vec2(cos(a), sin(a)) * r * 1.4 - vec2(0.0, g_shift);   // face, hair and some of the room
    vec3 col = texture(u_tex, headToUv(sp)).rgb;
    col = clamp(mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 1.0 + 0.8 * glow), 0.0, 1.0);
    col = mix(col, vec3(0.85, 0.7, 0.3) * ball(p, vec2(0.0), 0.9) * 1.2, detail * fill(abs(r - 0.86) - 0.025, aa));
    return vec4(col, fill(r - 0.885, aa));
}

vec4 glass(vec2 p, float aa) {   // crystal ball: the room seen through it, upside down
    float R = 0.88;
    vec2 q = p / R;
    float z = sqrt(max(1.0 - dot(q, q), 0.0));
    vec3 n = vec3(q, z);
    vec3 col = texture(u_tex, headToUv(-q * R * (1.7 - 0.9 * z))).rgb * vec3(0.92, 0.96, 1.0);
    col = mix(col, vec3(0.85, 0.92, 1.0), pow(1.0 - z, 3.0) * (0.3 + 0.4 * detail));     // bright rim
    col += pow(max(dot(n, normalize(vec3(-0.4, 0.5, 0.75))), 0.0), 60.0) * (0.4 + glow);
    col += 0.3 * glow * pow(max(dot(n, normalize(vec3(0.5, -0.4, 0.75))), 0.0), 30.0);
    return vec4(col, fill(length(p) - R, aa));
}

vec4 disco(vec2 p, float aa) {   // turning mirror ball; each tile reflects a random bit of the room
    float R = 0.85;
    vec2 q = p / R;
    float z = sqrt(max(1.0 - dot(q, q), 0.0));
    float lat = asin(clamp(q.y, -1.0, 1.0));
    float lon = atan(q.x, z) + u_time * 0.3;
    vec2 g = vec2(lon, lat) * (12.0 / 3.1416);
    vec2 id = floor(g), f = fract(g);
    float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    float h = hash21(id);

    vec3 refl = texture(u_tex, vec2(hash21(id + 17.0), hash21(id + 41.0))).rgb;
    vec3 col = (0.3 + 0.8 * mix(vec3(dot(refl, vec3(0.333))), refl, 0.6)) * (0.55 + 0.6 * h) * ball(p, vec2(0.0), R) * 1.2;
    float sparkle = pow(max(sin(u_time * 0.8 + h * 6.2832), 0.0), 12.0);   // ~1 s every ~8 s per tile
    col += vec3(1.0, 0.97, 0.9) * glow * 1.5 * sparkle * z;
    col = mix(col, vec3(0.08), (1.0 - smoothstep(0.04, 0.09, edge)) * (0.4 + 0.6 * detail) * z);
    return vec4(col, fill(length(p) - R, aa));
}

vec4 pixelate(vec2 p, float aa) {
    float cell = 2.0 / mix(4.0, 16.0, detail);
    vec2 c = (floor(p / cell) + 0.5) * cell;           // blocks follow the head and its tilt
    return vec4(texture(u_tex, headToUv(c)).rgb, fill(sdEllipse(p, vec2(0.8, 0.92)), aa));
}

// "multiply": the real head stays; copies of it (head and hair) circle around it, shrinking as
// their number grows so they fit side by side. glow tints each copy differently, detail draws a
// rim around it. Unlike the other masks it reaches beyond radius 1.2, see cloneReach().
int cloneCount() { return int(clamp(floor(heads + 0.5), 2.0, 12.0)) - 1; }   // heads is a whole number already

float cloneRadius(int n) {
    float s = sin(3.1416 / float(max(n, 2)));
    return n < 5 ? 0.6 : 0.96 * min(0.6, s / (1.0 - s));
}

const float HEAD_R = 0.6;   // head and hair radius in head units; the multiply mask is laid out in these
float cloneReach() { return (1.0 + 2.0 * cloneRadius(cloneCount())) * HEAD_R + 0.05; }

vec4 multiply(vec2 p, float aa) {
    p /= HEAD_R; aa /= HEAD_R;                                   // 1 = the real head's edge
    int n = cloneCount();
    float rc = cloneRadius(n);
    float ring = 1.0 + rc;
    vec3 col = vec3(0.0);
    float alpha = 0.0;
    for (int k = 0; k < 11; k++) {
        if (k >= n) break;
        float a = 6.2832 * float(k) / float(n) + u_time * 0.25;   // starts above the head, turns slowly
        vec2 q = (p - ring * vec2(sin(a), cos(a))) / rc;           // point inside this copy, 1 = its edge
        float r = length(q);
        if (r > 1.1) continue;
        vec3 c = texture(u_tex, headToUv(q * HEAD_R)).rgb;
        vec3 tint = 0.5 + 0.5 * cos(6.2832 * (float(k) / float(n) + vec3(0.0, 0.33, 0.67)));
        c = mix(c, c * (0.45 + 0.9 * tint), 0.6 * glow);
        c = mix(c, vec3(0.95, 0.92, 0.85), detail * fill(abs(r - 0.96) - 0.035, aa / rc));
        float ca = fill(r - 1.0, aa / rc);
        col = col * (1.0 - ca) + c * ca;
        alpha = alpha + ca * (1.0 - alpha);
    }
    return vec4(col / max(alpha, 1e-4), alpha);
}

vec4 effect(vec2 uv) {
    vec4 cam = texture(u_tex, uv);
    if (eff_int <= 0.0) return cam;
    vec3 col = cam.rgb;
    float aspect = u_res.x / u_res.y;
    int kind = int(mask + 0.5);
    float opacity = min(eff_int / (1.0 - 0.9 * opaqueness), 1.0);
    float reach = kind == 16 ? cloneReach() : 1.2;
    for (int i = 0; i < 8; i++) {
        if (i >= u_headCount) break;
        vec4 h = u_heads[i];
        float s = h.z * size;
        if (s <= 0.0 || h.w <= 0.0) continue;
        vec2 d = (uv - h.xy) * vec2(aspect, 1.0) / s;
        float c = cos(u_headRoll[i]), sn = sin(u_headRoll[i]);
        vec2 p = mat2(c, -sn, sn, c) * d;   // undo the head's tilt
        p.y -= 2.0 * lift / size;           // face box height = 2 / size head units
        if (dot(p, p) > reach * reach) continue;
        g_center = h.xy; g_scale = s; g_cos = c; g_sin = sn; g_shift = 2.0 * lift / size;
        float aa = 1.0 / (s * u_res.y);     // one pixel in head units
        vec4 mk;
        if (kind == 1) mk = pixelate(p, aa);
        else if (kind == 2) mk = pumpkin(p, aa);
        else if (kind == 3) mk = skull(p, aa);
        else if (kind == 4) mk = pig(p, aa);
        else if (kind == 5) mk = ghost(p, aa);
        else if (kind == 6) mk = alien(p, aa);
        else if (kind == 7) mk = cat(p, aa);
        else if (kind == 8) mk = fox(p, aa);
        else if (kind == 9) mk = robot(p, aa);
        else if (kind == 10) mk = sun(p, aa);
        else if (kind == 11) mk = moon(p, aa);
        else if (kind == 12) mk = eyeball(p, aa);
        else if (kind == 13) mk = blackhole(p, aa);
        else if (kind == 14) mk = kaleidoscope(p, aa);
        else if (kind == 15) mk = disco(p, aa);
        else if (kind == 16) mk = multiply(p, aa);
        else mk = glass(p, aa);
        col = mix(col, mk.rgb, mk.a * h.w * opacity);
    }
    return vec4(col, cam.a);
}
