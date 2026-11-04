# 把 .blend 导出成 web 能加载的 GLB。
#
#   blender -b "模型.blend" --python tools/blender-export-glb.py -- "out.glb"
#   blender -b "模型.blend" --python tools/blender-export-glb.py -- "out.glb" --max-tex 1024
#   blender -b "模型.blend" --python tools/blender-export-glb.py -- "out.glb" --skins   # 要骨骼/动画时加
#
# 做四件容易被忘掉的事：
#   1. 只导出可见网格：rigify 的 WGT- 控制器、灯光、相机都不带（它们会把体积撑大几倍）
#   2. 贴图降采样：4K 一遍材质几十张，原样导出 GLB 上百 MB，网页根本等不起
#   3. export_apply：应用修改器，否则细分/布料/平滑在 web 里直接消失
#   4. export_yup：Blender 是 Z 轴朝上，glTF 是 Y 轴朝上，不转模型就躺平
import os
import re
import sys

import bpy
from mathutils import Matrix, Vector


def parse_args():
    argv = sys.argv
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    out = rest[0] if rest else None
    max_tex = 1024
    if "--max-tex" in rest:
        max_tex = int(rest[rest.index("--max-tex") + 1])
    # 脸和眼睛单独一档：观众只看这一块，其余贴图可以压得很狠
    face_tex = 4096
    if "--face-tex" in rest:
        face_tex = int(rest[rest.index("--face-tex") + 1])
    animate = "--animate" in rest
    # 默认把手放下来（台上要的是站姿，不是 A-pose）；要原始姿势加 --no-pose
    pose = not ("--no-pose" in rest)
    inward, down = 0.24, 0.24
    if "--arm-offset" in rest:
        i = rest.index("--arm-offset")
        inward, down = (float(v) for v in rest[i + 1].split(","))
    return out, max_tex, face_tex, ("--skins" in rest or animate), animate, pose, inward, down


def collect_tex_images(tree, seen=None):
    """递归把节点树（含 group 内部）里的 TEX_IMAGE 都捞出来"""
    seen = seen or set()
    if tree.name in seen:
        return []
    seen.add(tree.name)
    found = []
    for n in tree.nodes:
        if n.type == "TEX_IMAGE" and n.image:
            found.append(n.image)
        elif n.type == "NODE_GROUP" and n.node_tree:
            found += collect_tex_images(n.node_tree, seen)
    return found


# 这些接口上的图片不是「颜色」，追颜色时不要走
SKIP_SOCKETS = {"Normal", "Height", "Displacement", "Weight", "Thickness", "Coat Normal", "Tangent"}


def trace_color_image(tree, depth=0):
    """
    从输出节点的 Surface 往回找第一张 TEX_IMAGE。
    不猜「树里最大的图」——那会把身体材质的图猜成脸的贴图（真踩过）。
    遇到节点组就进组里，从组内的输出节点接着追。
    """
    if depth > 6 or tree is None:
        return None
    out = next((n for n in tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
    if not out:
        return None
    queue = [out.inputs["Surface"]]
    visited = set()
    while queue:
        sock = queue.pop(0)
        for link in sock.links:
            node = link.from_node
            if node.type == "TEX_IMAGE" and node.image:
                return node.image
            if node.type == "NODE_GROUP" and node.node_tree:
                inner = trace_color_image(node.node_tree, depth + 1)
                if inner:
                    return inner
            if node.name in visited:
                continue
            visited.add(node.name)
            for inp in node.inputs:
                if inp.name in SKIP_SOCKETS or not inp.is_linked:
                    continue
                queue.append(inp)
    return None


def has_principled(mat):
    return any(n.type == "BSDF_PRINCIPLED" for n in mat.node_tree.nodes)


def base_color_is_direct_image(mat):
    """Base Color 是不是直接接在图片上——不是的话 glTF 导出器就取不到贴图"""
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    sock = bsdf.inputs["Base Color"]
    if not sock.is_linked:
        return True
    return all(l.from_node.type == "TEX_IMAGE" for l in sock.links)


def flatten_toon_materials(verbose=True):
    """
    MMD/toon 材质（TEX_IMAGE → HUE_SAT/节点组 → 输出）glTF 导出器认不出来，
    结果脸和眼睛导出去是一片没有五官的皮肤色。这里把它们压成 Principled：
    顺着链接追到真正喂颜色的那张图当 Base Color，有 alpha 通道就一并接上。

    有损转换：toon 的阴影色/边缘光不会带过去，靠场景灯光补。
    """
    done = []
    audit = []
    for mat in list(bpy.data.materials):
        if not mat.use_nodes or not mat.node_tree or mat.users == 0:
            continue
        principled = has_principled(mat)
        if principled and base_color_is_direct_image(mat):
            audit.append((mat.name, "ok(直连图片)", ""))
            continue

        traced = trace_color_image(mat.node_tree)
        images = collect_tex_images(mat.node_tree)
        img = traced or (max(images, key=lambda i: (i.size[0] or 0) * (i.size[1] or 0)) if images else None)
        if not img:
            audit.append((mat.name, "跳过(没有图片)", ""))
            print(f"[flatten] 跳过 {mat.name}（子树里没有图片）")
            continue

        alpha = img.depth in (32, 128)  # 32=R8G8B8A8, 128=float RGBA
        nt = mat.node_tree
        nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        out.location = (300, 0)
        bsdf.location = (0, 0)
        tex.location = (-320, 0)
        # 不接 Vector：Image Texture 默认用当前 UV 层，和原来 TEX_COORD 的行为一致
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha:
            # 高光贴片在原文件里是发光/叠加混合，压成不透明遮罩会变成一块白斑，
            # 这类单独走 BLEND（它是独立的小面片，不存在多层互透的问题）。
            is_additive = bool(re.search(r"high ?light|高光|hightlight", mat.name, re.I))
            if is_additive:
                nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
                mat.blend_method = "BLEND"
                if hasattr(mat, "surface_render_method"):
                    mat.surface_render_method = "BLENDED"
            else:
                # 其余是好几层重叠贴片：必须遮罩，BLEND 会互相透成鬼影
                cut = nt.nodes.new("ShaderNodeMath")
                cut.operation = "GREATER_THAN"
                cut.inputs[1].default_value = 0.5
                cut.location = (-120, -120)
                nt.links.new(tex.outputs["Alpha"], cut.inputs[0])
                nt.links.new(cut.outputs[0], bsdf.inputs["Alpha"])
                mat.blend_method = "CLIP"
                mat.alpha_threshold = 0.5
                if hasattr(mat, "surface_render_method"):
                    mat.surface_render_method = "DITHERED"
        else:
            mat.blend_method = "OPAQUE"
        bsdf.inputs["Roughness"].default_value = 0.6
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
        how = "追踪" if traced else "退回最大图"
        mode = "BLEND" if re.search(r"high ?light|高光|hightlight", mat.name, re.I) else ("MASK" if alpha else "OPAQUE")
        done.append(f"{mat.name.strip()} ← {img.name} ({mode}, {how})")
        audit.append((mat.name, how, img.name))
    if verbose:
        print("[flatten] 材质审计（前 40 条）：")
        for name, state, img in audit[:40]:
            print(f"   {name.strip()[:22]:22s} {state:14s} {img}")
    return done


def relax_arms_to_idle(inward=0.24, down=0.24):
    """
    把 A-pose 的手臂放下来。

    这份模型是 Auto-Rig Pro 骨架，FK 链权重是 0、IK 链权重是 1（试过：转 FK 控制骨，
    形变骨一动不动），所以只能挪 IK 的手部目标 c_hand_ik.*。
    挪法用世界坐标算，不猜欧拉轴向。
    """
    arm = bpy.data.objects.get("rig")
    if not arm:
        print("[pose] 没找到 'rig' 骨架，跳过摆姿势")
        return []
    done = []
    for side, sign in ((".l", 1.0), (".r", -1.0)):
        pb = arm.pose.bones.get("c_hand_ik" + side)
        if not pb:
            continue
        head_w = arm.matrix_world @ pb.head
        # 目标：x 向内收 inward，z 向下移 down，y 保持；符号跟着左右手走
        target = Vector((sign * max(0.06, abs(head_w.x) - inward), head_w.y, head_w.z - down))
        m = arm.matrix_world @ pb.matrix
        pb.matrix = arm.matrix_world.inverted() @ (Matrix.Translation(target) @ m.to_3x3().to_4x4())
        bpy.context.view_layer.update()  # 不 update 就读 pb.head 会拿到旧值（踩过）
        after = arm.matrix_world @ pb.head
        done.append(
            f"{side}: ({head_w.x:+.3f},{head_w.y:+.3f},{head_w.z:+.3f}) -> "
            f"({after.x:+.3f},{after.y:+.3f},{after.z:+.3f})"
        )
    bpy.context.view_layer.update()
    return done


def add_breathing_loop(frames=72, fps=24):
    """
    一段 3 秒的呼吸循环：脊柱微微起伏 + 脖子和头极小幅摆动。
    关键帧打在控制骨上，形变骨会跟着走；导出时 glTF 导出器逐帧采样，
    所以控制器上的姿势也会被烘进动画里（不需要手工 nla.bake）。
    """
    arm = bpy.data.objects.get("rig")
    if not arm:
        return []
    scn = bpy.context.scene
    scn.render.fps = fps
    scn.frame_start = 1
    scn.frame_end = frames

    tracks = {
        "c_spine_02.x": [("rotation_euler", 0, 0.0), ("rotation_euler", 0, 0.012)],
        "c_spine_03.x": [("rotation_euler", 0, 0.0), ("rotation_euler", 0, -0.010)],
        "c_neck.x": [("rotation_euler", 0, 0.0), ("rotation_euler", 0, 0.008)],
    }
    touched = []
    mid = frames // 2
    for name, keys in tracks.items():
        pb = arm.pose.bones.get(name)
        if not pb:
            continue
        pb.rotation_mode = "XYZ"
        base = pb.rotation_euler.copy()
        for frame, axis, delta in ((1, 0, 0.0), (mid, 0, 1.0), (frames, 0, 0.0)):
            pb.rotation_euler = base
            pb.rotation_euler[axis] += (keys[1][2] if frame == mid else 0.0)
            pb.keyframe_insert("rotation_euler", frame=frame)
        touched.append(f"{name} ±{keys[1][2]:.3f}rad / {frames}帧")
    bpy.context.view_layer.update()
    return touched


def collapse_extra_armatures(meshes, usable):
    """
    一个网格挂两个骨架修改器时，导出 skin 只能绑其中一个，另一个的形变会被丢掉
    （症状：光环节变成一个飘在头顶的红色伞状物）。
    把多余那些修改器应用到网格里，把形变烧进顶点，只留一个骨架给 skin 绑。
    """
    keep_names = {a.name for a in usable}
    done = []
    for obj in meshes:
        mods = [m for m in obj.modifiers if m.type == "ARMATURE" and m.object]
        if len(mods) < 2:
            continue
        keep = next((m for m in mods if m.object.name in keep_names), None)
        if not keep:
            done.append(f"{obj.name}: 两个骨架都不在选中集里，跳过")
            continue
        bpy.context.view_layer.objects.active = obj
        for name in [m.name for m in mods if m.name != keep.name]:
            try:
                bpy.ops.object.modifier_apply(modifier=name)
                done.append(f"{obj.name}: 把 {name} 烘进顶点，保留 {keep.name}({keep.object.name})")
            except Exception as exc:
                done.append(f"{obj.name}: 应用 {name} 失败 -> {exc}")
    bpy.context.view_layer.update()
    return done


def key_current_pose(armatures, frame=1):
    """
    把「当前看到的姿势」钉成关键帧。

    为什么必须做：导出 skin 时网格是按骨架的**静止姿势**绑定的，蒙皮播放的是动画。
    这几套骨架里配件的静止姿势和作者摆出来的姿势不一样（光环会飘到头顶十几厘米外），
    不打关键帧就等于把配件丢回静止位置。
    """
    touched = []
    for arm in armatures:
        if arm.type != "ARMATURE":
            continue
        n = 0
        for pb in arm.pose.bones:
            pb.keyframe_insert("location", frame=frame)
            if pb.rotation_mode == "QUATERNION":
                pb.keyframe_insert("rotation_quaternion", frame=frame)
            else:
                pb.keyframe_insert("rotation_euler", frame=frame)
            pb.keyframe_insert("scale", frame=frame)
            n += 1
        touched.append(f"{arm.name}: {n} 根骨")
    bpy.context.view_layer.update()
    return touched


def main():
    out, max_tex, face_tex, with_skins, animate, do_pose, inward, down = parse_args()
    if not out:
        raise SystemExit("缺少输出路径：blender -b 文件.blend --python tools/blender-export-glb.py -- 输出.glb")
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    # 1. 挑出真正要导出的对象：可见、非 WGT- 控制器、非灯/相机
    picked = []
    for obj in bpy.context.view_layer.objects:
        if obj.type not in {"MESH", "CURVE", "SURFACE", "FONT"}:
            continue
        if obj.name.startswith("WGT-"):
            continue
        if not obj.visible_get():
            continue
        picked.append(obj)
    if not picked:
        raise SystemExit("没有可见的网格可导出：检查集合是不是被 exclude 了")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in picked:
        obj.select_set(True)

    # 骨架必须一起选中：use_selection=True 时不选骨架，导出器就不会生成 skin 和动画
    # （症状是 skins=0 / animations=0，而模型看着一切正常）
    arms = set()
    for obj in picked:
        for mod in obj.modifiers:
            if mod.type == "ARMATURE" and mod.object:
                arms.add(mod.object)
        anc = obj.parent
        while anc:
            if anc.type == "ARMATURE":
                arms.add(anc)
            anc = anc.parent
    # 不在视图层的骨架选不中（比如被 exclude 的集合里的），那些网格只能按静态几何导出
    in_layer = {o.name for o in bpy.context.view_layer.objects}
    usable = []
    skipped = []
    for arm_obj in arms:
        if arm_obj.name in in_layer:
            usable.append(arm_obj)
        else:
            skipped.append(arm_obj.name)
    if skipped:
        print(f"[export] 这些骨架不在视图层，跳过（它们的网格按静态几何导出）：{sorted(skipped)}")
    for arm_obj in usable:
        arm_obj.select_set(True)
    print(f"[export] 一起选中的骨架：{sorted(a.name for a in usable)}")

    bpy.context.view_layer.objects.active = picked[0]

    # 2. 贴图降采样（只缩不放大），否则 4K 贴图能把 GLB 顶到上百 MB。
    #    脸和眼睛是观众唯一盯着看的地方，单独给一档更高的上限。
    scaled = 0
    for img in bpy.data.images:
        try:
            w, h = img.size
        except Exception:
            continue
        if not w or not h:
            continue
        cap = face_tex if re.search(r"face|eye|眼睛|脸", img.name, re.I) else max_tex
        if max(w, h) <= cap:
            continue
        k = cap / max(w, h)
        img.scale(max(1, round(w * k)), max(1, round(h * k)))
        scaled += 1

    print(f"[export] 选中 {len(picked)} 个对象，降采样 {scaled} 张贴图到 ≤{max_tex}px")

    flattened = flatten_toon_materials()
    print(f"[export] 压平 {len(flattened)} 个 toon 材质：")
    for line in flattened:
        print("   -", line)

    # 姿势与动作：必须在挑完对象、压完材质之后做（摆姿势会改形变结果）
    if do_pose:
        posed = relax_arms_to_idle(inward, down)
        print("[pose] 手臂放到自然站姿：")
        for line in posed:
            print("   -", line)
    if animate:
        tracks = add_breathing_loop()
        print("[anim] 呼吸循环关键帧：")
        for line in tracks:
            print("   -", line)
    if with_skins:
        collapsed = collapse_extra_armatures(picked, usable)
        if collapsed:
            print("[skin] 多骨架网格收敛：")
            for line in collapsed:
                print("   -", line)
        keyed = key_current_pose(usable)
        print("[pose] 当前姿势已钉成关键帧（否则配件会回到静止姿势）：")
        for line in keyed:
            print("   -", line)

    # 3./4. 导出
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_skins=with_skins,
        export_animations=with_skins,
        export_frame_range=animate,
        export_def_bones=with_skins,  # 只要形变骨；rigify 的控制骨一千多根，带上是纯负担
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
    )

    print(f"[export] ok -> {out} ({os.path.getsize(out)/1024/1024:.2f} MB)")


main()
