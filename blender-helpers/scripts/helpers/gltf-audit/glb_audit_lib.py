import json, struct, hashlib, sys, numpy as np
def sha(b): return hashlib.sha256(b).hexdigest()
def load(p):
    d = open(p, 'rb').read(); n = struct.unpack('<I', d[12:16])[0]; j = json.loads(d[20:20 + n]); off = 20 + n; bl = struct.unpack('<I', d[off:off + 4])[0]; binb = d[off + 8:off + 8 + bl]; return d, j, binb
CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}; NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}
def acc(j, binb, i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; dt = CT[a['componentType']]; nc = NC[a['type']]; o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', 0); cnt = a['count']
    if stride and stride != dt().itemsize * nc: raise SystemExit('strided')
    arr = np.frombuffer(binb, dtype=dt, count=cnt * nc, offset=o); raw = binb[o:o + cnt * nc * np.dtype(dt).itemsize]
    return (arr.reshape(cnt, nc) if nc > 1 else arr), a, sha(raw)
def edges_stats(tri):
    e = np.concatenate([tri[:, [0, 1]], tri[:, [1, 2]], tri[:, [2, 0]]]); e.sort(axis=1); key = e[:, 0].astype(np.uint64) * np.uint64(1 << 32) + e[:, 1].astype(np.uint64)
    u, c = np.unique(key, return_counts=True); return {'edges': int(len(u)), 'boundary(1 tri)': int((c == 1).sum()), 'nonmanifold(>2 tri)': int((c > 2).sum())}