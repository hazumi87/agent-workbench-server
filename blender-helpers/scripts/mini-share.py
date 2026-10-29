#!/usr/bin/env python3
"""mini-share.py -- stand-in for the agent-share file drop (stdlib only).
  python3 mini-share.py [ROOT_DIR] [PORT]        default ~/agent-share 8215
GET /health            -> {"ok":true}            (blender-agent preflight needs this)
GET /raw/<path>        -> file bytes
GET /api/list?dir=X    -> {"files":[...]}
POST /api/upload?dir=X multipart field "file"  -> saves under ROOT/X; NEVER overwrites (name-1.ext); X must exist
Binds 127.0.0.1 only. No auth: never put secrets in the share."""
import sys, os, json, re, mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote
from email.parser import BytesParser
from email.policy import HTTP
ROOT = os.path.realpath(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/agent-share'))
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8215
os.makedirs(ROOT, exist_ok=True)
def safe(rel):
    p = os.path.realpath(os.path.join(ROOT, rel.lstrip('/')))
    return p if p == ROOT or p.startswith(ROOT + os.sep) else None
class H(BaseHTTPRequestHandler):
    def _j(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == '/health': return self._j(200, {'ok': True, 'root': ROOT})
        if u.path == '/api/list':
            d = safe(q.get('dir', [''])[0])
            return self._j(200, {'files': sorted(os.listdir(d))}) if d and os.path.isdir(d) else self._j(404, {'ok': False})
        if u.path.startswith('/raw/'):
            p = safe(unquote(u.path[5:]))
            if p and os.path.isfile(p):
                b = open(p, 'rb').read(); self.send_response(200); self.send_header('content-type', mimetypes.guess_type(p)[0] or 'application/octet-stream'); self.send_header('content-length', str(len(b))); self.end_headers(); return self.wfile.write(b)
        self._j(404, {'ok': False})
    def do_POST(self):
        u = urlparse(self.path)
        if u.path != '/api/upload': return self._j(404, {'ok': False})
        d = safe(parse_qs(u.query).get('dir', [''])[0])
        if not d or not os.path.isdir(d): return self._j(400, {'ok': False, 'error': 'target dir missing'})
        n = int(self.headers.get('content-length', 0)); body = self.rfile.read(n)
        msg = BytesParser(policy=HTTP).parsebytes(b'content-type: ' + self.headers['content-type'].encode() + b'\r\n\r\n' + body)
        saved = []
        for part in msg.iter_parts():
            fn = part.get_filename()
            if not fn: continue
            fn = re.sub(r'[^A-Za-z0-9._ -]', '_', os.path.basename(fn)); base, ext = os.path.splitext(fn); out = os.path.join(d, fn); i = 0
            while os.path.exists(out): i += 1; out = os.path.join(d, f'{base}-{i}{ext}')
            open(out, 'wb').write(part.get_payload(decode=True)); saved.append(os.path.relpath(out, ROOT))
        self._j(200, {'ok': True, 'saved': saved})
    def log_message(self, *a): pass
ThreadingHTTPServer(('127.0.0.1', PORT), H).serve_forever()
