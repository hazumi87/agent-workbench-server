"""kit2_modes — the four view modes of the watch and of kit2_view / kit2_review (Workbench, so each picture costs well under 0.1 s).

  plain    the assets in colour; the reference hidden (shown only when there are no assets yet = the opening shot)
  color    A  the reference solid grey, the assets in colour: where do the parts sit, what shows through
  wire     B  the reference in colour and see-through (alpha `wire_alpha`, default 0.5), the assets as bright yellow wireframe
  refwire  C  the reference as a cyan wireframe grid, the assets solid grey: how far does the reference stick out of the parts

Wireframe is real geometry (Workbench's final render ignores its wireframe shading): each asset is decimated to a quarter and given a
Wireframe modifier (0.002 m struts), the reference is voxel-remeshed at 0.012 m and wired. They are built once per run, on first use.
This module is imported by watch_capture.py, kit2_view.py and kit2_review.py; it is not a verb.
"""
import hashlib
import os
import time

import bpy

MODES = [
    {"id": "plain", "label": "Plain", "short": "Plain"},
    {"id": "color", "label": "Colour on grey reference", "short": "A"},
    {"id": "wire", "label": "Wireframe on see-through reference", "short": "B"},
    {"id": "refwire", "label": "Grey on reference wireframe", "short": "C"},
]
IDS = [m["id"] for m in MODES]
ALIASES = {"a": "color", "b": "wire", "c": "refwire", "colour": "color"}
GREY = (0.55, 0.55, 0.57, 1)
ASSET_WIRE = (1.0, 0.85, 0.1, 1)
REF_WIRE = (0.3, 0.8, 1.0, 1)


def split(ms):
    """(reference, assets) of a job's meshes: the object named `ref`; before kit2_body has named it (the opening shot: a single imported
    mesh) that one mesh is the reference and there are no assets. With several meshes and no `ref`, all are assets."""
    ref = next((o for o in ms if o.name == "ref"), None)
    if ref is None and len(ms) == 1:
        return ms[0], []
    return ref, [o for o in ms if o is not ref]


def job_wire_alpha(job_dir, given=None):
    """the opacity of the reference in `wire`: the caller's value, else the job's watch setting (watch.json), else 0.5 - the same everywhere"""
    import json
    if given is not None:
        return float(given)
    try:
        return float(json.load(open(os.path.join(job_dir, "watch.json"), encoding="utf-8")).get("wire_alpha", 0.5))
    except Exception:  # noqa: BLE001
        return 0.5


def norm(mode):
    m = str(mode).strip().lower()
    m = ALIASES.get(m, m)
    if m not in IDS:
        raise RuntimeError(f"mode must be one of {IDS} (or A, B, C): got {mode!r}")
    return m


def workbench(scn, res):
    """Workbench settings shared by every mode: studio light, texture colour, no shadows/cavity, standard transform."""
    scn.render.resolution_x = scn.render.resolution_y = res
    scn.render.resolution_percentage = 100
    scn.render.use_file_extension = False
    scn.render.engine = "BLENDER_WORKBENCH"
    sh = scn.display.shading
    sh.light, sh.color_type = "STUDIO", "TEXTURE"
    sh.show_cavity = False
    sh.show_shadows = False
    sh.show_specular_highlight = True
    scn.display.render_aa = "8"
    scn.view_settings.view_transform = "Standard"
    scn.view_settings.exposure = 0.45
    if scn.world is None:
        scn.world = bpy.data.worlds.new("World")
    scn.world.use_nodes = True
    bg = scn.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.30, 0.31, 0.34, 1)
    bg.inputs[1].default_value = 1.0
    scn.world.color = (0.30, 0.31, 0.34)


def strip_normals(objs):
    """for viewing only: cut every Normal Map / Bump node out of the materials of `objs` (in memory; the file is never saved by a view),
    so a flat surface is not made to look shaped. The glossy highlight (specular, roughness) is left as it is. Returns how many links."""
    cut = 0
    seen = set()
    for o in objs:
        for slot in o.material_slots:
            mt = slot.material
            if not mt or not mt.use_nodes or mt in seen:
                continue
            seen.add(mt)
            for lk in list(mt.node_tree.links):
                if lk.from_node.type in ("NORMAL_MAP", "BUMP"):
                    mt.node_tree.links.remove(lk)
                    cut += 1
    return cut


def _flat(name, rgba):
    m = bpy.data.materials.new(name)
    m.diffuse_color = rgba
    return m


def _set_mats(o, mats):
    o.data.materials.clear()
    for m in mats:
        o.data.materials.append(m)


class Rig:
    """Switches the scene between the modes. `ref` may be None; `assets` are the objects to show (not the reference)."""

    def __init__(self, ref, assets, wire_alpha=0.5, grid=0.012, asset_ratio=0.25):
        self.ref, self.assets = ref, list(assets)
        self.opening = not self.assets
        self.wire_alpha, self.grid, self.asset_ratio = float(wire_alpha), float(grid), float(asset_ratio)
        self.grey = _flat("mode-grey", GREY)
        self.mats = {o: list(o.data.materials) for o in ([ref] if ref else []) + self.assets}
        self.ref_alpha = {m: m.diffuse_color[3] for m in (self.mats[ref] if ref else [])}
        self.wires = {}
        self.prep_s = {}

    def _bake(self, src, tag, rgba, thick, ratio=None, voxel=None):
        """a plain mesh copy of `src` reduced and turned into wireframe geometry (modifiers applied)."""
        scn = bpy.context.scene
        c = src.copy()
        old = src.data.copy()
        c.data = old
        c.name = f"{src.name}.{tag}"
        scn.collection.objects.link(c)
        if voxel:
            md = c.modifiers.new("remesh", "REMESH")
            md.mode, md.voxel_size = "VOXEL", voxel
        elif ratio and ratio < 1:
            md = c.modifiers.new("decimate", "DECIMATE")
            md.ratio = ratio
        w = c.modifiers.new("wire", "WIREFRAME")
        w.thickness, w.use_replace, w.use_even_offset, w.use_boundary = thick, True, False, False
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(c.evaluated_get(dg))
        c.modifiers.clear()
        c.data = me
        bpy.data.meshes.remove(old)
        me.materials.clear()
        me.materials.append(_flat(f"wire-{tag}", rgba))
        c.hide_render = True
        return c

    def _wires_for(self, key):
        if key not in self.wires:
            t = time.time()
            if key == "assets":
                self.wires[key] = [self._bake(o, "wire", ASSET_WIRE, 0.002, ratio=self.asset_ratio) for o in self.assets]
            else:
                self.wires[key] = [self._bake(self.ref, "grid", REF_WIRE, 0.0012, voxel=self.grid)] if self.ref else []
            self.prep_s[key] = round(time.time() - t, 2)
        return self.wires[key]

    def apply(self, mode):
        mode = norm(mode)
        ref = self.ref
        for o, m in self.mats.items():  # back to the starting state
            _set_mats(o, m)
        for m, a in self.ref_alpha.items():
            m.diffuse_color[3] = a
        if ref:
            ref.show_transparent = False
            ref.hide_render = True
        for ws in self.wires.values():
            for w in ws:
                w.hide_render = True
        for o in self.assets:
            o.hide_render = False
        if mode == "plain":
            if ref and self.opening:
                ref.hide_render = False
        elif mode == "color":
            if ref:
                _set_mats(ref, [self.grey])
                ref.hide_render = False
        elif mode == "wire":
            for o in self.assets:
                o.hide_render = True
            for w in self._wires_for("assets"):
                w.hide_render = False
            if ref:
                for m in self.ref_alpha:
                    m.diffuse_color[3] = self.wire_alpha
                ref.show_transparent = True
                ref.hide_render = False
        elif mode == "refwire":
            for o in self.assets:
                _set_mats(o, [self.grey])
            for w in self._wires_for("ref"):
                w.hide_render = False


def load_small(img, cache_dir, tex):
    """a downscaled copy of `img` from the cache (made on first use). None if the image has no usable source."""
    if img.packed_file is not None:
        key = hashlib.md5(img.packed_file.data).hexdigest()
    else:
        p = bpy.path.abspath(img.filepath)
        if not os.path.isfile(p):
            return None
        key = hashlib.md5(f"{p}:{os.path.getsize(p)}:{os.path.getmtime(p)}".encode()).hexdigest()
    path = os.path.join(cache_dir, f"{key[:20]}_{tex}.jpg")
    made = False
    if not os.path.isfile(path):
        w, h = img.size  # decodes the original: only on the first sighting
        if max(w, h) > tex:
            k = tex / max(w, h)
            img.scale(max(1, round(w * k)), max(1, round(h * k)))
        img.filepath_raw = path
        img.file_format = "JPEG"
        img.save()
        made = True
    sm = bpy.data.images.load(path)
    sm.colorspace_settings.name = img.colorspace_settings.name
    return sm, made


def swap_textures(objs, cache_dir, tex):
    os.makedirs(cache_dir, exist_ok=True)
    done, new = {}, 0
    for o in objs:
        for slot in o.material_slots:
            m = slot.material
            if not m or not m.use_nodes:
                continue
            for nd in m.node_tree.nodes:
                if nd.type != "TEX_IMAGE" or nd.image is None:
                    continue
                img = nd.image
                if img.name not in done:
                    r = load_small(img, cache_dir, tex)
                    done[img.name] = r[0] if r else None
                    new += 1 if r and r[1] else 0
                if done[img.name] is not None:
                    nd.image = done[img.name]
    return {"images": len(done), "new_in_cache": new}