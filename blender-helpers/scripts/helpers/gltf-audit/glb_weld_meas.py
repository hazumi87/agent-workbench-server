"""Compare two GLBs: coincident-vertex pairs (<= 1e-6 m) in the first, how many vertices a weld removes, and whether the second's vertices are bit-equal to the first's.
   usage: python3 glb_weld_meas.py before.glb after.glb [mesh_index]    (needs scipy)"""
import sys, json, numpy as np
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from glb_audit_lib import load, acc
try:
    from scipy.spatial import cKDTree
except Exception as ex:
    print('NOSCIPY', ex); raise SystemExit
A, B = sys.argv[1], sys.argv[2]   # two GLBs to compare (before, after)
MI = int(sys.argv[3]) if len(sys.argv) > 3 else 0   # mesh index in both files
d, j, binb = load(A); PA = acc(j, binb, j['meshes'][MI]['primitives'][0]['attributes']['POSITION'])[0].astype(np.float64)
d2, j2, b2 = load(B); PB = acc(j2, b2, j2['meshes'][MI]['primitives'][0]['attributes']['POSITION'])[0].astype(np.float64)
t = cKDTree(PA); pairs = t.query_pairs(1e-6, output_type='ndarray')
if len(pairs) == 0: print(json.dumps({'verts_A': len(PA), 'verts_B': len(PB), 'coincident_pairs_le_1e-6m': 0})); raise SystemExit
dist = np.linalg.norm(PA[pairs[:, 0]] - PA[pairs[:, 1]], axis=1)
res = {'verts_A': len(PA), 'verts_B': len(PB), 'coincident_pairs_le_1e-6m': int(len(pairs)), 'pair_distance_m': {'max': float(dist.max()), 'median': float(np.median(dist)), 'p95': float(np.percentile(dist, 95))}}
# union-find clusters
par = np.arange(len(PA))
def f(x):
    while par[x] != x: par[x] = par[par[x]]; x = par[x]
    return x
for a, b in pairs: par[f(a)] = f(b)
roots = np.array([f(i) for i in range(len(PA))]); cnt = np.bincount(roots); members = np.nonzero(cnt[roots] > 1)[0]
cent = {}
for r in np.unique(roots[members]): idx = np.nonzero(roots == r)[0]; cent[r] = PA[idx].mean(0)
disp = np.array([np.linalg.norm(PA[i] - cent[roots[i]]) for i in members])
res['clusters']= int((cnt[np.unique(roots[members])]).size); res['vertices_in_clusters'] = int(len(members)); res['vertices_removed_by_weld(=A-B)'] = int(len(PA) - len(PB)); res['max_displacement_to_cluster_centroid_m'] = float(disp.max()); res['mean_displacement_m'] = float(disp.mean())
# all other vertices unchanged? match B verts to A verts by exact position
sa = set(map(tuple, PA.astype(np.float32).tolist())); sb = PB.astype(np.float32); unmatched = [tuple(x) for x in sb.tolist() if tuple(x) not in sa]
res['B_vertices_not_bit_equal_to_any_A_vertex'] = len(unmatched)
print(json.dumps(res, indent=1))