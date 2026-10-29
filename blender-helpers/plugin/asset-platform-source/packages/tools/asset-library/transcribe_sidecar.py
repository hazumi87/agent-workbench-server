#!/usr/bin/env python3
"""
server speech-to-text sidecar — tiny HTTP server wrapping faster-whisper.
POST /transcribe  multipart field: audio (any format) -> {"ok":true,"text":"..."}
Runs on 127.0.0.1:8267 (localhost-only; asset-library Node route proxies to it).
Model loaded once at startup; kept in memory.
"""
import cgi, io, os, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(os.environ.get("TRANSCRIBE_PORT", "8267"))

_whisper = None
_lock = threading.Lock()


def get_whisper():
    global _whisper
    with _lock:
        if _whisper is None:
            from faster_whisper import WhisperModel
            t0 = time.time()
            _whisper = WhisperModel("base", device="cpu", compute_type="int8")
            print(f"[transcribe] model loaded in {time.time()-t0:.1f}s", flush=True)
        return _whisper


def decode_audio(raw):
    """Decode any audio format -> (mono float32 ndarray, sample_rate).
    Fast path: soundfile for WAV/FLAC. Fallback: PyAV for m4a/aac/mp3/ogg/etc."""
    import numpy as np
    import soundfile as sf
    try:
        data, sr = sf.read(io.BytesIO(raw))
        if data.ndim > 1:
            data = data.mean(axis=1)
        return np.asarray(data, dtype=np.float32).reshape(-1), sr
    except Exception:
        pass
    import av
    container = av.open(io.BytesIO(raw))
    try:
        stream = next(s for s in container.streams if s.type == "audio")
        resampler = av.audio.resampler.AudioResampler(format="flt", layout="mono", rate=24000)
        chunks = []
        for frame in container.decode(stream):
            for rf in resampler.resample(frame):
                chunks.append(rf.to_ndarray().reshape(-1))
        for rf in resampler.resample(None):
            chunks.append(rf.to_ndarray().reshape(-1))
        if not chunks:
            raise RuntimeError("no audio decoded")
        return np.concatenate(chunks).astype(np.float32), 24000
    finally:
        container.close()


def transcribe_bytes(raw):
    import soundfile as sf
    import tempfile
    data, sr = decode_audio(raw)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        sf.write(f.name, data, sr, format="WAV")
        path = f.name
    try:
        segs, _info = get_whisper().transcribe(path, language="en")
        return " ".join(s.text.strip() for s in segs).strip()
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[transcribe] {self.address_string()} - {fmt % args}", flush=True)

    def do_GET(self):
        if self.path == "/health":
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        import json
        if self.path != "/transcribe":
            self.send_response(404)
            self.end_headers()
            return
        try:
            ctype = self.headers.get("Content-Type", "")
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)
            environ = {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": ctype,
                "CONTENT_LENGTH": str(length),
            }
            fs = cgi.FieldStorage(fp=io.BytesIO(body), environ=environ, keep_blank_values=True)
            field = fs.getvalue("audio") if "audio" in fs else None
            if field is None:
                raise ValueError("missing 'audio' field in multipart")
            raw = field if isinstance(field, bytes) else field.encode()
            t0 = time.time()
            text = transcribe_bytes(raw)
            elapsed = time.time() - t0
            print(f"[transcribe] {len(raw)} bytes -> {len(text)} chars in {elapsed:.2f}s", flush=True)
            resp = json.dumps({"ok": True, "text": text}).encode()
        except Exception as e:
            resp = json.dumps({"ok": False, "error": str(e)}).encode()

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(resp))
        self.end_headers()
        self.wfile.write(resp)


if __name__ == "__main__":
    threading.Thread(target=get_whisper, daemon=True).start()
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[transcribe] sidecar on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
