#!/usr/bin/env python3
import argparse
import http.server
import json
import mimetypes
import pathlib
import socketserver
import threading
import urllib.parse

mimetypes.add_type("application/javascript", ".mjs")
mimetypes.add_type("application/javascript", ".cjs")
mimetypes.add_type("application/wasm", ".wasm")

APP_PREFIX = "/nijikan"
MODELS_PREFIX = f"{APP_PREFIX}/models/"
MODEL_LIST_PATH = f"{APP_PREFIX}/models/__list"
MANIFEST_JSON_PATH = f"{APP_PREFIX}/manifest.json"


class ReusableTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


class NicxHandler(http.server.SimpleHTTPRequestHandler):
    models_root: pathlib.Path = None

    def end_headers(self):
        # Disable browser caching in dev so index/html/js/wasm changes are visible immediately.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_HEAD(self):
        if self.path in ("", "/", APP_PREFIX):
            self.send_response(302)
            self.send_header("Location", f"{APP_PREFIX}/index.html")
            self.end_headers()
            return
        if self.path.startswith(MANIFEST_JSON_PATH):
            self.serve_manifest_json(head_only=True)
            return
        if self.path.startswith(MODEL_LIST_PATH):
            self.serve_model_list(head_only=True)
            return
        if self.path.startswith(MODELS_PREFIX):
            self.serve_model(head_only=True)
            return
        if not self.rewrite_app_path():
            self.send_error(404, "not found")
            return
        return super().do_HEAD()

    def do_GET(self):
        if self.path in ("", "/", APP_PREFIX):
            self.send_response(302)
            self.send_header("Location", f"{APP_PREFIX}/index.html")
            self.end_headers()
            return
        if self.path.startswith(MANIFEST_JSON_PATH):
            self.serve_manifest_json(head_only=False)
            return
        if self.path.startswith(MODEL_LIST_PATH):
            self.serve_model_list(head_only=False)
            return
        if self.path.startswith(MODELS_PREFIX):
            self.serve_model(head_only=False)
            return
        if not self.rewrite_app_path():
            self.send_error(404, "not found")
            return
        return super().do_GET()

    def rewrite_app_path(self):
        parsed = urllib.parse.urlsplit(self.path)
        if not parsed.path.startswith(f"{APP_PREFIX}/"):
            return False
        rewritten_path = parsed.path[len(APP_PREFIX):] or "/"
        if parsed.query:
            rewritten_path = f"{rewritten_path}?{parsed.query}"
        self.path = rewritten_path
        return True

    def serve_manifest_json(self, head_only: bool):
        app_manifest = pathlib.Path(self.directory) / "manifest.json"
        if app_manifest.is_file():
            self.rewrite_app_path()
            if head_only:
                return super().do_HEAD()
            return super().do_GET()
        payload = b'{"models":[]}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)

    def serve_model_list(self, head_only: bool):
        root = self.models_root
        if root is None or not root.is_dir():
            self.send_error(500, "models root is not configured")
            return
        models = []
        for p in root.rglob("*"):
            if not p.is_file():
                continue
            suf = p.suffix.lower()
            if suf not in (".inx", ".inp"):
                continue
            rel = p.relative_to(root).as_posix()
            models.append(f"{MODELS_PREFIX}{rel}")
        models.sort()
        payload = json.dumps({"models": models}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if not head_only:
            self.wfile.write(payload)

    def serve_model(self, head_only: bool):
        root = self.models_root
        if root is None:
            self.send_error(500, "models root is not configured")
            return
        parsed = urllib.parse.urlsplit(self.path)
        rel = urllib.parse.unquote(parsed.path[len(MODELS_PREFIX):])
        rel_path = pathlib.PurePosixPath(rel)
        if rel_path.is_absolute() or ".." in rel_path.parts:
            self.send_error(400, "invalid model path")
            return
        model = (root / pathlib.Path(*rel_path.parts)).resolve()
        try:
            model.relative_to(root)
        except ValueError:
            self.send_error(403, "path escapes models root")
            return
        if not model.is_file():
            self.send_error(404, "model file not found")
            return
        ctype, _ = mimetypes.guess_type(str(model))
        if not ctype:
            ctype = "application/octet-stream"
        try:
            data = model.read_bytes()
        except OSError:
            self.send_error(500, "failed to read model file")
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description="Serve nijikan app at /nijikan and mount models at /nijikan/models")
    parser.add_argument("--models-dir", required=True, help="Directory mounted as /nijikan/models")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on")
    args = parser.parse_args()

    script_dir = pathlib.Path(__file__).resolve().parent
    app_root = script_dir
    models_root = pathlib.Path(args.models_dir).expanduser().resolve()

    if not models_root.is_dir():
        raise SystemExit(f"models dir not found: {models_root}")

    handler = NicxHandler
    handler.models_root = models_root

    with ReusableTCPServer(("127.0.0.1", args.port), lambda *a, **k: handler(*a, directory=str(app_root), **k)) as httpd:
        httpd.timeout = 0.2
        print(f"serving nijikan root: {app_root}")
        print(f"models mapping: {MODELS_PREFIX}* -> {models_root}")
        print(f"open: http://127.0.0.1:{args.port}{APP_PREFIX}/index.html")
        stop_event = threading.Event()
        try:
            while not stop_event.is_set():
                httpd.handle_request()
        except KeyboardInterrupt:
            print("\nstopping server...")
            stop_event.set()
        finally:
            httpd.server_close()


if __name__ == "__main__":
    main()
