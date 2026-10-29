import sys, json, numpy as np
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from glb_audit_lib import load, acc
res={}
for p in sys.argv[1:]:
    d,j,binb=load(p); r={}
    for mi,m in enumerate(j['meshes']):
        pr=m['primitives'][0]; P,_,_=acc(j,binb,pr['attributes']['POSITION']); I,_,_=acc(j,binb,pr['indices']); tri=I.astype(np.int64).reshape(-1,3)
        srt=np.sort(tri,axis=1); key=srt[:,0]*(1<<42)+srt[:,1]*(1<<21)+srt[:,2]
        u,inv,c=np.unique(key,return_inverse=True,return_counts=True)
        dupgroups=int((c>1).sum()); dup_tris=int(c[c>1].sum())
        # opposite-winding duplicates: same sorted triple, cyclic-different orientation
        ori=np.zeros(len(tri),bool)
        for g in np.nonzero(c>1)[0][:50]: pass
        # edges with >2 tris: list triangles on them
        e=np.concatenate([tri[:,[0,1]],tri[:,[1,2]],tri[:,[2,0]]]); es=np.sort(e,axis=1); ek=es[:,0]*(1<<32)+es[:,1]; ue,ic=np.unique(ek,return_counts=True)
        nm=ue[ic>2]; tid=np.tile(np.arange(len(tri)),3)
        info=[]
        for k in nm[:12]:
            ts=tid[ek==k]; a,b=int(k>>32),int(k&0xffffffff); info.append({'edge_pos_m':[[round(float(x),4) for x in P[a]],[round(float(x),4) for x in P[b]]],'tris':[[int(x) for x in tri[t]] for t in ts],'tri_areas':[float(0.5*np.linalg.norm(np.cross(P[tri[t][1]]-P[tri[t][0]],P[tri[t][2]]-P[tri[t][0]]))) for t in ts]})
        r[m.get('name')]={'tri_count':int(len(tri)),'duplicate_triangle_groups(same 3 verts)':dupgroups,'triangles_in_duplicate_groups':dup_tris,'nonmanifold_edges':int(len(nm)),'nonmanifold_edge_detail':info}
    res[p]=r
print(json.dumps(res,indent=1))