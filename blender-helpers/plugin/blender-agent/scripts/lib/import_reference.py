"""Developer helper for a Blender Studio reference_import verb (Blender 4.5).

Creates position-derived reference armatures and baked capture meshes, not a
skinned MHR character. Run on a NEW job/checkpoint. Does not alter existing objects.

Inside Blender: import_reference('/absolute/path/to/extracted/bundle')
Optional standalone: blender -b --python import_reference.py -- BUNDLE OUTPUT.blend
The operator should use the developer's registered verb, not bypass the tool runner.
"""
import json
from pathlib import Path
import sys


def read_obj(path):
    vertices, faces = [], []
    for line in Path(path).read_text().splitlines():
        if line.startswith('v '): vertices.append(tuple(map(float, line.split()[1:4])))
        elif line.startswith('f '): faces.append(tuple(int(s.split('/')[0])-1 for s in line.split()[1:]))
    return vertices, faces


def import_reference(directory):
    import bpy
    from mathutils import Vector

    directory = Path(directory)
    ref = json.loads((directory/'reference.json').read_text())
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    name = 'VideoTo3D_MetaReference'
    if bpy.data.collections.get(name): raise ValueError('Reference collection exists; use a new job or remove it explicitly')
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    bpy.context.scene.unit_settings.system = 'METRIC'
    bpy.context.scene.unit_settings.scale_length = 1.
    names, parents = ref['joint_names'], ref['parents']
    material = bpy.data.materials.new('Meta reference cyan')
    material.diffuse_color = (.035, .42, .62, 1)
    made = []
    for pose in ref['poses']:
        label = pose['label'] + ('_INFERRED' if pose['inferred'] else '')
        # All pose meshes occupy their real positions in the same coordinate frame.
        sub = bpy.data.collections.new('Meta_'+label); collection.children.link(sub)
        vertices, faces = read_obj(directory/pose['mesh_smooth'])
        mesh = bpy.data.meshes.new('MetaMesh_'+label); mesh.from_pydata(vertices, [], faces); mesh.update()
        body = bpy.data.objects.new('MetaBody_'+label, mesh); sub.objects.link(body)
        body.data.materials.append(material)
        armature = bpy.data.armatures.new('MetaSkeleton_'+label)
        arm = bpy.data.objects.new('MetaJoints_'+label, armature); sub.objects.link(arm)
        arm.show_in_front = True; armature.display_type = 'STICK'
        bpy.ops.object.select_all(action='DESELECT'); arm.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.mode_set(mode='EDIT')
        points = [Vector(p) for p in pose['joints_smooth']]
        # Tail placement is a drawing convention. The head is the measured joint.
        preferred = {0: 1, 1: 34, 2: 3, 3: 4, 4: 8, 18: 19, 19: 20, 20: 24,
                     34: 35, 35: 36, 36: 37, 37: 110, 38: 39, 39: 40, 40: 42,
                     74: 75, 75: 76, 76: 78, 110: 113, 113: 126}
        bones = []
        for i, joint_name in enumerate(names):
            bone = armature.edit_bones.new(f'{i:03d}_{joint_name}')
            bone.head = points[i]
            children = [k for k, p in enumerate(parents) if p == i]
            child = preferred.get(i, children[0] if children else None)
            tail = points[child] if child is not None else points[i]+Vector((0, 0, .01))
            if (tail-points[i]).length < 1e-5: tail = points[i]+Vector((0, 0, .01))
            bone.tail = tail
            if parents[i] >= 0: bone.parent = bones[parents[i]]
            bone.use_connect = False; bone.use_deform = False
            bones.append(bone)
        bpy.ops.object.mode_set(mode='OBJECT')
        for i, joint_name in enumerate(names):
            bone = armature.bones[f'{i:03d}_{joint_name}']
            bone['mhr_index'] = i
            bone['reference_only'] = True
        for ob in [body, arm]:
            ob['capture_time_s'] = pose['t_s']; ob['inferred'] = pose['inferred']
            ob['reference_only'] = True
            ob['note'] = 'Baked captured geometry / position-derived skeleton; no original MHR skin or twist.'
        # Show the 0.5 s reference initially. The developer can expose a pose selector.
        sub.hide_viewport = pose['label'] != '000500ms'
        sub.hide_render = sub.hide_viewport
        made.append({'collection': sub.name, 'mesh': body.name, 'armature': arm.name,
                     't_s': pose['t_s'], 'inferred': pose['inferred']})
    collection['source_bundle'] = str(directory)
    collection['coordinates'] = ref['coordinates']['system']
    bpy.context.scene.render.fps = 60
    bpy.context.scene.frame_start = 1; bpy.context.scene.frame_end = 1823
    return {'reference_collection': collection.name, 'poses': made,
            'joint_count': len(names), 'skinned': False,
            'note': 'Room PLY and source photos are separate imports; all share documented scale/transforms.'}


if __name__ == '__main__':
    args = sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    if len(args) != 2: raise SystemExit('Usage after --: BUNDLE_DIRECTORY OUTPUT.blend')
    result = import_reference(args[0])
    import bpy
    bpy.ops.wm.save_as_mainfile(filepath=str(Path(args[1]).resolve()))
    print(json.dumps(result))
