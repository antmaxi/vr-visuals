# Soundtrack files

All audio here was produced with [ElevenLabs](https://elevenlabs.io) (Eleven Music and Sound Effects, from text prompts). The files are committed so the hosted site and the headset can play them.

Drop files into the subfolders below. The page loads the catalog from `/audio.json`, which `serve.py` produces on the fly and the Pages workflow generates on deploy.

| folder | when it plays |
|---|---|
| `bed/` | looping ambient bed (required for **Play**). Filenames containing `more-intense` (e.g. `bed-more-intense_…`) are the high-intensity bed and crossfade in as `eff_int` rises; other `bed/` files are the calm bed |
| `peak/` | `peak_loop.*` (filename contains `loop`) is a third looping layer; `peak_onset.*` (contains `onset`) is a one-shot at its start. Both start after `eff_int` has stayed at 0.85 or more for 5 s; the loop fades in slowly and fades out when `eff_int` falls below 0.7 |
| `intense/` | one-shot when `eff_int` crosses up into a higher band (0.4, 0.7), or drops fast |
| `head_appear/` | one-shot when a tracked face fades in, heard from the side that head is on |
| `head_disappear/` | one-shot when a tracked face fades out, heard from where it was (the panel's "flip L/R" reverses both) |

Files that share the same name up to `#` are variants of one sound (e.g. `whoosh_soft_psychede_#2-….mp3` and `#3-….mp3`). Each trigger picks a first-part at random in that folder, then one of its variants at random.

Supported extensions: `.mp3`, `.ogg`, `.wav`, `.m4a`.
