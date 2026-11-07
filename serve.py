#!/usr/bin/env python3
"""Tiny dev server for the effect harness (standard library only).

    python3 serve.py              # serve at http://localhost:8000
    python3 serve.py --port 9000  # other port
    python3 serve.py --write-json # just write effects.json and exit (used by CI)

Serves this folder with caching disabled and answers /effects.json with the
current list of effects/*.glsl (files starting with "_" are ignored).
"""
import argparse
import http.server
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
EFFECTS_DIR = os.path.join(ROOT, "effects")


def list_effects():
    names = [
        n for n in os.listdir(EFFECTS_DIR)
        if n.endswith(".glsl") and not n.startswith("_")
    ]
    return sorted(names)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/effects.json":
            body = json.dumps(list_effects()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass  # the page polls every second; keep the console quiet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--write-json", action="store_true")
    args = ap.parse_args()

    if args.write_json:
        with open(os.path.join(ROOT, "effects.json"), "w") as f:
            json.dump(list_effects(), f)
        print("wrote effects.json:", list_effects())
        return

    server = http.server.ThreadingHTTPServer(("localhost", args.port), Handler)
    print(f"Serving at http://localhost:{args.port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
