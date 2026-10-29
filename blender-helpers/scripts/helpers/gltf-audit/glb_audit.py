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
out = {}
for p in sys.argv[1:]:
    d, j, binb = load(p); r = {'file': p, 'bytes': len(d), 'sha256': sha(d), 'asset_generator': j.get('asset', {}).get('generator'), 'nodes': [{'name': n.get('name'), 'mesh': n.get('mesh'), 'has_matrix/trs': [k for k in ('matrix', 'translation', 'rotation', 'scale') if k in n]} for n in j['nodes']], 'meshes': {}}
    for mi, m in enumerate(j['meshes']):
        for pi, pr in enumerate(m['primitives']):
            P, pa, psha = acc(j, binb, pr['attributes']['POSITION']); N, na, nsha = acc(j, binb, pr['attributes']['NORMAL']) if 'NORMAL' in pr['attributes'] else (np.zeros((len(P), 3), np.float32), {'count': 0}, None); I, ia, isha = acc(j, binb, pr['indices']); I = I.astype(np.uint32); tri = I.reshape(-1, 3)
            nl = np.linalg.norm(N, axis=1) if na['count'] else np.ones(len(P), np.float32); area = 0.5 * np.linalg.norm(np.cross(P[tri[:, 1]] - P[tri[:, 0]], P[tri[:, 2]] - P[tri[:, 0]]), axis=1)
            idx_degen = int(((tri[:, 0] == tri[:, 1]) | (tri[:, 1] == tri[:, 2]) | (tri[:, 0] == tri[:, 2])).sum())
            # position-level (merge coincident float32 positions) topology
            uq, inv = np.unique(P.view(np.uint8).reshape(len(P), -1), axis=0, return_inverse=True); tri2 = inv.reshape(-1)[tri]
            res = {'name': m.get('name'), 'POSITION_count': int(pa['count']), 'NORMAL_count': int(na['count']), 'indices_count': int(ia['count']), 'triangles_from_indices': int(len(tri)), 'max_index': int(I.max()), 'unreferenced_vertices': int(len(P) - len(np.unique(I))),
                   'normals': {'non_finite': int((~np.isfinite(N)).any(axis=1).sum()), 'min_len': float(nl.min()), 'max_len': float(nl.max()), 'max_abs_len_minus_1': float(np.abs(nl - 1).max())},
                   'tris_with_repeated_index': idx_degen, 'tris_zero_area_float32': int((area == 0).sum()), 'tris_area_lt_1e-12': int((area < 1e-12).sum()),
                   'index_level_topology': edges_stats(tri), 'unique_positions': int(len(uq)), 'position_merged_topology': edges_stats(tri2),
                   'POSITION_sha256': psha, 'NORMAL_sha256': nsha, 'indices_sha256': isha, 'pos_min': [round(float(x), 6) for x in P.min(0)], 'pos_max': [round(float(x), 6) for x in P.max(0)]}
            r['meshes'][f'{mi}.{pi}:{m.get("name")}'] = res
    out[p] = r
print(json.dumps(out, indent=1))