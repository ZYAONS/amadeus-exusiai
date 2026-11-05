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
import math
from mathutils import Matrix, Quaternion, Vector


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
    animate = "--animate" in rest or "--alive" in rest
    alive = "--alive" in rest
    mocap = None
    if "--mocap" in rest:
        mocap = rest[rest.index("--mocap") + 1]
    mocap_action = None
    if "--mocap-action" in rest:
        mocap_action = rest[rest.index("--mocap-action") + 1]
    mocap_frames = None
    if "--mocap-frames" in rest:
        mocap_frames = int(rest[rest.index("--mocap-frames") + 1])
    mocap_clip = "idle"
    if "--mocap-clip" in rest:
        mocap_clip = rest[rest.index("--mocap-clip") + 1]
    mocap_window = None
    if "--mocap-window" in rest:
        a, b = rest[rest.index("--mocap-window") + 1].split(":")
        mocap_window = (float(a), float(b))
    mocap_scale = 1.0
    if "--mocap-scale" in rest:
        mocap_scale = float(rest[rest.index("--mocap-scale") + 1])
    mocap_smooth = 0.0
    if "--mocap-smooth" in rest:
        mocap_smooth = float(rest[rest.index("--mocap-smooth") + 1])
    mocap_loop = 0.0
    if "--mocap-loop" in rest:
        mocap_loop = float(rest[rest.index("--mocap-loop") + 1])
    mocap_arms_ik = 0.0
    if "--mocap-arms-ik" in rest:
        mocap_arms_ik = float(rest[rest.index("--mocap-arms-ik") + 1])
    # 默认把手放下来（台上要的是站姿，不是 A-pose）；要原始姿势加 --no-pose
    pose = not ("--no-pose" in rest)
    inward, down = 0.24, 0.24
    if "--arm-offset" in rest:
        i = rest.index("--arm-offset")
        inward, down = (float(v) for v in rest[i + 1].split(","))
    return (out, max_tex, face_tex, ("--skins" in rest or animate), animate, alive, pose,
            inward, down, mocap, mocap_action, mocap_frames, mocap_clip,
            mocap_window, mocap_scale, mocap_smooth, mocap_loop, mocap_arms_ik)


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


def bake_static_accessories(meshes, animated_armatures=("rig",)):
    """
    只有「会动的骨架」驱动的网格才导出 skin，其余网格的骨架形变直接烘进顶点。

    为什么：导出 skin 时网格是按骨架的**静止姿势**绑定的。这份模型里配件骨架
    （骨架 / 骨架.001 / RIG-骨架.002）的静止姿势和作者摆出来的姿势不一样，
    一旦给它们导出 skin，光环和翅膀会回到静止位置——表现为头顶一团红色弧形。
    它们本来也不做动画，烘成静态几何既省体积又不会错位。
    """
    done = []
    animated = set(animated_armatures)
    for obj in meshes:
        arm_mods = [m for m in obj.modifiers if m.type == "ARMATURE" and m.object]
        if not arm_mods:
            continue
        if {m.object.name for m in arm_mods} & animated:
            continue  # 会动的骨架：留着导出 skin
        bpy.context.view_layer.objects.active = obj
        ok = True
        for name in [m.name for m in arm_mods]:
            try:
                bpy.ops.object.modifier_apply(modifier=name)
            except Exception as exc:
                ok = False
                done.append(f"{obj.name}: modifier_apply 失败（{exc}）→ 改用 convert")
                break
        if ok:
            done.append(f"{obj.name}: 烘成静态（{', '.join(m.name for m in arm_mods)}）")
            continue
        # 有形状键/多用户数据时 modifier_apply 会失败，convert 能把修改器一起烘掉
        try:
            if obj.data.users > 1:
                obj.data = obj.data.copy()
            bpy.ops.object.convert(target="MESH")
            left = [m.type for m in obj.modifiers]
            done.append(f"{obj.name}: convert 成功，剩余修改器={left}")
        except Exception as exc:
            done.append(f"{obj.name}: convert 也失败 -> {exc}")
    bpy.context.view_layer.update()
    return done


def weights_live_in(obj, armature_name):
    """这个网格的顶点组是不是真的落在那套骨架的骨头上（决定它该不该被蒙皮）"""
    arm = bpy.data.objects.get(armature_name)
    if not arm or obj.type != "MESH":
        return False
    bones = {b.name for b in arm.data.bones}
    return any(vg.name in bones for vg in obj.vertex_groups)


def apply_modifier(obj, mod_name):
    """
    应用一个修改器；有形状键时退回 convert（convert 会把所有修改器一起烘掉）。

    注意：convert 作用于**整个选中集**。不先把选择收敛到这个对象，
    它会把别的网格（包括身体）的骨架修改器一起烘掉——那样导出时就没有蒙皮了。
    """
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.object.modifier_apply(modifier=mod_name)
        return "applied"
    except Exception:
        try:
            if obj.data.users > 1:
                obj.data = obj.data.copy()
            bpy.ops.object.convert(target="MESH")
            return "converted"
        except Exception as exc:
            return f"failed({exc})"


def prepare_meshes_for_skin(meshes, animated_armature="rig"):
    """
    分派：顶点组真正落在会动的骨架上的网格 → 保留骨架修改器，导出 skin；
    其余网格（配件）→ 把骨架形变烘进顶点，导出静态几何。

    为什么这么分：导出 skin 时网格是按骨架**静止姿势**绑定的。配件骨架的静止姿势
    和作者摆的姿势不一样，一旦给它们绑 skin，光环/头发会飞到镜头前（实测：头发网格
    离相机 2.39，其余 3.7）。而像 hair.001 这种挂着 rig 修饰器、顶点组却属于另一套
    骨架的网格，绑到 rig 上会让权重全落空、直接塌成一团。
    """
    report = []
    for obj in meshes:
        arm_mods = [m for m in obj.modifiers if m.type == "ARMATURE" and m.object]
        if not arm_mods:
            continue
        skinned = weights_live_in(obj, animated_armature) and any(
            m.object.name == animated_armature for m in arm_mods
        )
        if skinned:
            # 只烘掉别的骨架的贡献，留下会动的那套
            for m in [m for m in arm_mods if m.object.name != animated_armature]:
                what = apply_modifier(obj, m.name)
                report.append(f"{obj.name}: 蒙皮(rig)，烘掉 {m.name} -> {what}")
        else:
            # 按修改器栈顺序全烘掉（只烘一个的话，第二个骨架修改器还在，导出时又会被绑上）
            for m in list(arm_mods):
                if not obj.modifiers.get(m.name):
                    continue
                what = apply_modifier(obj, m.name)
                report.append(f"{obj.name}: 静态，烘 {m.name} -> {what}")
                if what == "converted":
                    break  # convert 已经把栈里剩下的都烘掉了
    bpy.context.view_layer.update()
    return report


def apply_non_armature_modifiers(meshes):
    """非骨架修改器（细分、镜像等）导出前要应用掉，否则 web 里看不到"""
    done = []
    for obj in meshes:
        for m in [m for m in obj.modifiers if m.type != "ARMATURE"]:
            if not obj.modifiers.get(m.name):
                continue
            what = apply_modifier(obj, m.name)
            done.append(f"{obj.name}: {m.name}({m.type}) -> {what}")
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


# 「活人感」要用的形态键（ARKit 命名）。其余几十个裁掉：每多一个都要多一份顶点数据
ALIVE_KEYS = {
    "eyeBlinkLeft", "eyeBlinkRight",
    "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
    "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
    "eyeSquintLeft", "eyeSquintRight", "eyeWideLeft", "eyeWideRight",
    "jawOpen", "mouthSmileLeft", "mouthSmileRight", "mouthFrownLeft", "mouthFrownRight",
    "browDownLeft", "browDownRight", "browInnerUp", "cheekSquintLeft", "cheekSquintRight",
}


def prune_shape_keys(meshes):
    """只留活人感要用的形态键，其余删掉（体积和运行时开销都省）"""
    report = []
    for obj in meshes:
        if obj.type != "MESH" or not obj.data.shape_keys:
            continue
        names = [k.name for k in obj.data.shape_keys.key_blocks]
        # 一个都不在名单里的（比如头发的「修女头发修复」）原样不动：
        # 那可能是作者调好的外观，删掉会改形状
        if not (set(names) & ALIVE_KEYS):
            continue
        before = len(names)
        for k in list(obj.data.shape_keys.key_blocks):
            if k.name not in ALIVE_KEYS and k.name != "Basis":
                obj.shape_key_remove(k)
        after = len(obj.data.shape_keys.key_blocks) if obj.data.shape_keys else 0
        report.append(f"{obj.name}: {before} → {after} 个形态键")
    return report


def _key_bone(pb, frame):
    pb.keyframe_insert("location", frame=frame)
    pb.keyframe_insert("rotation_quaternion" if pb.rotation_mode == "QUATERNION" else "rotation_euler", frame=frame)


def _bone(arm, name):
    return arm.pose.bones.get(name)


def author_alive_clips(arm, fps=24):
    """
    编两段循环动作：idle（8s：呼吸 + 重心微移 + 手臂微摆）和 talk（4s：点头 + 身体前倾 + 手的动作）。

    关键：每条动作第 1 帧把所有骨头钉一遍，保证在运行时用 crossfade 切换 clip 时
    手臂不会跳回 A-pose（手臂是靠 IK 手部目标摆下来的，切 clip 会丢姿势）。
    用 export_animation_mode='ACTIONS' 导出，一段 action 就是一个 clip。
    """
    import math

    scene = bpy.context.scene
    scene.render.fps = fps
    if not arm.animation_data:
        arm.animation_data_create()

    made = []
    for name, frames in (("idle", 192), ("talk", 96)):
        action = bpy.data.actions.new(name)
        action.use_fake_user = True
        arm.animation_data.action = action
        scene.frame_start, scene.frame_end = 1, frames

        # ① 基准帧：所有骨头当前姿势各钉一帧
        for pb in arm.pose.bones:
            _key_bone(pb, 1)

        # ② 记录要动画的骨头的基准值
        base = {}
        for bone_name in ("c_spine_02.x", "c_spine_03.x", "c_neck.x", "c_head.x",
                          "c_root_master.x", "c_hand_ik.l", "c_hand_ik.r"):
            pb = _bone(arm, bone_name)
            if not pb:
                continue
            if pb.rotation_mode == "QUATERNION":
                pb.rotation_mode = "XYZ"
            base[bone_name] = (pb.location.copy(), pb.rotation_euler.copy())

        step = 4
        for f in range(1, frames + 1, step):
            t = (f - 1) / fps
            for bone_name, (loc0, rot0) in base.items():
                pb = _bone(arm, bone_name)
                pb.location = loc0.copy()
                pb.rotation_euler = rot0.copy()
                if name == "idle":
                    if bone_name == "c_spine_02.x":
                        pb.rotation_euler.x += math.sin(t * 2 * math.pi / 3.2) * 0.010
                    elif bone_name == "c_spine_03.x":
                        pb.rotation_euler.x -= math.sin(t * 2 * math.pi / 3.2) * 0.008
                    elif bone_name == "c_root_master.x":
                        pb.location.x += math.sin(t * 2 * math.pi / 8.0) * 0.012
                        pb.rotation_euler.z += math.sin(t * 2 * math.pi / 8.0) * 0.010
                    elif bone_name == "c_head.x":
                        pb.rotation_euler.x += math.sin(t * 2 * math.pi / 5.0) * 0.012
                        pb.rotation_euler.z += math.sin(t * 2 * math.pi / 7.0) * 0.018
                    elif bone_name == "c_neck.x":
                        pb.rotation_euler.x += math.sin(t * 2 * math.pi / 3.2 + 0.6) * 0.006
                    elif bone_name == "c_hand_ik.l":
                        pb.location.z += math.sin(t * 2 * math.pi / 6.0) * 0.005
                    elif bone_name == "c_hand_ik.r":
                        pb.location.z += math.sin(t * 2 * math.pi / 6.0 + 1.2) * 0.005
                else:  # talk
                    if bone_name == "c_head.x":
                        # 两次点头 + 轻微侧转，像在说话
                        pb.rotation_euler.x += abs(math.sin(t * 2 * math.pi / 2.0)) * 0.05
                        pb.rotation_euler.z += math.sin(t * 2 * math.pi / 4.0) * 0.03
                    elif bone_name == "c_neck.x":
                        pb.rotation_euler.x += abs(math.sin(t * 2 * math.pi / 2.0)) * 0.02
                    elif bone_name == "c_spine_03.x":
                        pb.rotation_euler.x += math.sin(t * 2 * math.pi / 4.0) * 0.02
                    elif bone_name == "c_spine_02.x":
                        pb.rotation_euler.x += math.sin(t * 2 * math.pi / 3.2) * 0.010
                    elif bone_name == "c_hand_ik.l":
                        pb.location.y -= 0.03 + abs(math.sin(t * 2 * math.pi / 2.0)) * 0.04
                        pb.location.z += math.sin(t * 2 * math.pi / 2.0) * 0.02
                    elif bone_name == "c_hand_ik.r":
                        pb.location.y -= abs(math.sin(t * 2 * math.pi / 2.0 + 1.0)) * 0.02
                _key_bone(pb, f)

        made.append(f"{name}: {frames} 帧 @ {fps}fps（{frames / fps:.1f}s）")
        arm.animation_data.action = None
        # 必须推上 NLA：glTF 的 ACTIONS 模式只导出「当前 action 和 NLA 轨道上的动作」，
        # 只加 fake user 的 action 是导不出去的（踩过：clips 空了）
        track = arm.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, action)
        strip.name = name
        track.mute = True  # 导出时按 track 采样，静音只是为了不在视口里互相叠加

    scene.frame_start, scene.frame_end = 1, 192
    return made


def bake_shape_keys_with_modifiers(obj):
    """
    把非骨架修改器（细分）逐形态键烘进顶点，然后重建形态键。

    为什么必须这么绕：glTF 导出器的 export_apply 与形态键互斥（开了就不导 morph），
    可脸又是靠 Subsurf 才不糙（1621 → 约 6500 顶点）。所以只能是「先把细分烘进每一个
    形态键的姿态里」，再把 export_apply 关掉，morph 才能带出去。
    """
    kb = obj.data.shape_keys.key_blocks
    names = [k.name for k in kb]
    original = {k.name: k.value for k in kb}

    baked = {}
    for name in names:
        for k in kb:
            k.value = 1.0 if k.name == name else 0.0
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
        baked[name] = [v.co.copy() for v in me.vertices]
        bpy.data.meshes.remove(me)

    for k in kb:
        k.value = 0.0
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    new_mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    for m in [m for m in obj.modifiers if m.type != "ARMATURE"]:
        obj.modifiers.remove(m)
    obj.data = new_mesh

    obj.shape_key_add(name="Basis", from_mix=False)
    for name in names[1:]:
        key = obj.shape_key_add(name=name, from_mix=False)
        for i, co in enumerate(baked[name]):
            key.data[i].co = co
    # 恢复原先的键值（一般全是 0，但别替作者改表情）
    for k in obj.data.shape_keys.key_blocks:
        if k.name in original:
            k.value = original[k.name]
    return len(names)


def prepare_for_morph_export(meshes):
    """形态键要 export_apply=False，所以非骨架修改器得自己先烘掉"""
    report = []
    for obj in meshes:
        if obj.type != "MESH":
            continue
        nonarm = [m for m in obj.modifiers if m.type != "ARMATURE"]
        if not nonarm:
            continue
        if obj.data.shape_keys:
            n = bake_shape_keys_with_modifiers(obj)
            report.append(f"{obj.name}: 细分逐形态键烘进顶点（{n} 个键，{len(obj.data.vertices)} 顶点）")
            continue
        for m in nonarm:
            if obj.modifiers.get(m.name):
                what = apply_modifier(obj, m.name)
                report.append(f"{obj.name}: {m.name}({m.type}) -> {what}")
    return report


# ───────────────────────── 开源动作重定向 ─────────────────────────
# 两套开源骨架的命名不一样，映射表要分开；目标骨都是 ARP 的控制骨。
# 手臂链走「世界旋转校正」，躯干/颈/头走「局部增量」（见下面注释）。
MAPS = {
    "mixamo": {
        "world": [
            ("mixamorig:LeftShoulder", "c_shoulder.l", False),
            ("mixamorig:LeftArm", "c_arm_fk.l", False),
            ("mixamorig:LeftForeArm", "c_forearm_fk.l", False),
            ("mixamorig:LeftHand", "c_hand_fk.l", False),
            ("mixamorig:RightShoulder", "c_shoulder.r", False),
            ("mixamorig:RightArm", "c_arm_fk.r", False),
            ("mixamorig:RightForeArm", "c_forearm_fk.r", False),
            ("mixamorig:RightHand", "c_hand_fk.r", False),
        ],
        # IK 手臂：源的肩/腕 → 目标 IK 手部目标骨（这份 .blend 里 FK 是死的，只有 IK 链驱动可见骨）
        "ik_arms": [
            ("mixamorig:LeftArm", "mixamorig:LeftHand", "c_hand_ik.l"),
            ("mixamorig:RightArm", "mixamorig:RightHand", "c_hand_ik.r"),
        ],
        "local": [
            ("mixamorig:Spine", "c_spine_01.x"),
            ("mixamorig:Spine1", "c_spine_02.x"),
            ("mixamorig:Spine2", "c_spine_03.x"),
            ("mixamorig:Neck", "c_neck.x"),
            ("mixamorig:Head", "c_head.x"),
        ],
    },
    # CMU mocap：Hips→LowerBack→Spine→Spine1→Neck→Neck1→Head（官方声明可用于任何用途）
    #
    # 全部走「局部增量」，不用世界旋转校正：BVH 的静止姿势不是规范的 T-pose，骨骼 roll
    # 也是导入器按偏移算出来的，corr = R_t_rest · R_s_rest⁻¹ 对它没有意义
    # （实测把手臂映射成平举、甚至举过头顶）。局部增量只搬「姿势变化量」，与静止朝向无关。
    #
    # 手臂不参与重定向：这份 .blend 里 ARP 的 FK 开关是失效的（rotFK/locFK/scaleFK 的
    # 影响值被一条变量未绑定的驱动器锁在 0），网格实际蒙皮在 *arm_stretch /
    # *forearm_twist 上、跟的是 IK 链；给 c_arm_fk.* 打关键帧只会经 arm_fk_pre_pole
    # 牵动肘部极向，实测把前臂侧展从 0.25 拉到 0.72~0.83（手臂被撑开）。
    # 所以手臂保持与上一版完全一致的站姿，只搬躯干 + 颈 + 头。
    "cmu": {
        "world": [],
        "ik_arms": [
            ("LeftArm", "LeftHand", "c_hand_ik.l"),
            ("RightArm", "RightHand", "c_hand_ik.r"),
        ],
        "local": [
            ("LowerBack", "c_spine_01.x"),
            ("Spine", "c_spine_02.x"),
            ("Spine1", "c_spine_03.x"),
            ("Neck", "c_neck.x"),
            # CMU 的颈是 Neck→Neck1→Head 三节，ARP 只有 c_neck→c_head 两节，
            # 所以把 Neck1 与 Head 的增量复合成 c_head 的增量，不丢动作。
            (("Neck1", "Head"), "c_head.x"),
        ],
    },
}

def detect_family(bones):
    names = set(bones)
    if any(n.startswith("mixamorig:") for n in names):
        return "mixamo"
    if {"Hips", "LowerBack", "LeftUpLeg"} <= names:
        return "cmu"
    return None


def import_motion_source(path):
    """导入动作源，返回 (armature, src_fps, 说明)。BVH 要按文件里的 Frame Time 定帧率，
    否则 120fps 的 CMU 数据会被均匀采样成 4 倍速。"""
    import os

    bpy.ops.object.select_all(action="DESELECT")
    ext = os.path.splitext(path)[1].lower()
    if ext == ".bvh":
        fps = 120.0
        try:
            with open(path, "r", errors="ignore") as fh:
                for line in fh:
                    if line.strip().startswith("Frame Time:"):
                        fps = 1.0 / float(line.split(":")[1].strip())
                        break
                    if line.strip().startswith("MOTION"):
                        break
        except Exception:  # noqa: BLE001
            pass
        fps = max(1.0, round(fps))
        bpy.context.scene.render.fps = int(fps)
        # 该操作符没有 fps 参数：先把场景帧率设成素材帧率，再按帧号 1:1 导入，
        # 这样动作的帧号范围 / 场景帧率 == 素材真实时长。
        bpy.ops.import_anim.bvh(filepath=path, use_fps_scale=False,
                                update_scene_fps=False, update_scene_duration=False)
        note = f"BVH {int(fps)}fps"
    else:
        bpy.ops.import_scene.gltf(filepath=path)
        fps = 24.0
        note = "glTF"

    imported = list(bpy.context.selected_objects)
    src = next((o for o in imported if o.type == "ARMATURE"), None)
    if not src:
        raise SystemExit("动作源里没有骨架")
    # 源自带的网格会挡在镜头前，删掉（只借它的骨架采样）
    for o in imported:
        if o.type == "MESH":
            bpy.data.objects.remove(o, do_unlink=True)
    return src, fps, note


def _basis_quat(pb):
    """取骨骼的局部（basis）旋转，旋转模式统一成四元数"""
    if pb.rotation_mode == "QUATERNION":
        return pb.rotation_quaternion.copy()
    from mathutils import Euler

    return Euler(pb.rotation_euler, pb.rotation_mode).to_quaternion()


def _bone_local_rot(ob, bone_name):
    """骨骼相对父级的旋转（armature 空间矩阵相除）。
    用它而不是 rotation_quaternion：BVH 导入的骨架是 euler 驱动的，
    读 rotation_quaternion 会拿到一条不随时间变化的常量，头就永远不动。"""
    pb = ob.pose.bones[bone_name]
    m = pb.matrix.to_3x3()
    if pb.parent:
        m = pb.parent.matrix.to_3x3().inverted() @ m
    return m.to_quaternion()


def retarget_local_delta(rig, src, pairs, frame):
    """局部增量重定向：q_target = q_target_rest · (q_src_rest⁻¹ · q_src_frame)"""
    for s_name, t_name, src_rest, tgt_rest in pairs:
        tgt_pb = rig.pose.bones[t_name]
        if tgt_pb.rotation_mode != "QUATERNION":
            tgt_pb.rotation_mode = "QUATERNION"
        delta = src_rest.inverted() @ _bone_local_rot(src, s_name)
        tgt_pb.rotation_quaternion = tgt_rest @ delta
        tgt_pb.keyframe_insert("rotation_quaternion", frame=frame)


# 关于「把手臂切到 FK」这条路（不再实现，写在这里免得下次又试一遍）：
# 这份 .blend 里 ARP 的 rotFK / locFK / scaleFK 三个约束的 influence 被一条变量未绑定的
# 驱动器锁在 0（文件内的 RIG-*_ui.py 被禁用，ARP 重绑那条链没跑），手写 1.0 会在下一次
# 求值被改回去——实测把 arm_fk.l 转 90°，可见骨动 0.00°。而关掉 rotIK 更糟：IK 解算被
# 撤销，手臂从「垂在身侧」（arm_stretch 垂度 0.99 / 侧展 0.15）退回作者 A-pose
# （0.70 / 0.71）。网格实际蒙皮在 *arm_stretch / *forearm_twist 上、跟的是 IK 链，
# 所以手臂只有一条通路：挪 IK 的手部目标（见 retarget_mocap 的 ik_arms）。


def _rest_rot(ob, bone_name):
    return (ob.matrix_world @ ob.data.bones[bone_name].matrix_local).to_quaternion()


def retarget_mocap(rig, mocap_path, action_name=None, fps=24, frames=None, clip="idle",
                   window=None, scale=1.0, smooth=0.0, loop_blend=0.0, arms_ik=0.0):
    """
    把开源动作重定向到 ARP 控制骨。支持 Mixamo（GLB）与 CMU mocap（BVH）两种骨架。

    手臂链用「世界旋转校正」；躯干/颈/头用「局部增量」（世界校正套在脊柱上会驼背）。
    两侧静止姿势不同，所以一律以「窗口起点那一帧的姿势」为基准算增量——
    这样 clip 第一帧就等于 rig 自己的站姿，切换时不跳。

    四个可调参数是为了把「真实采集的表演动作」压成适合站姿 idle 的幅度：
      window     取素材的哪一段（秒，如 (0.5, 4.5)），默认整段
      scale      增量四元数的缩放，1.0 = 原始幅度
      smooth     滑动平均窗长（秒），压掉 mocap 的高频抖动
      loop_blend 结尾回归首帧的交叉淡入时长（秒），0 = 不做
    先采样到内存，再统一做平滑/缩放/收口，最后一次性写关键帧。
    """
    src, src_fps, note = import_motion_source(mocap_path)
    family = detect_family([b.name for b in src.data.bones])
    if family is None:
        names = sorted(b.name for b in src.data.bones)[:12]
        raise SystemExit(f"不认识的骨架家族，骨骼名示例：{names}")
    world_spec = MAPS[family]["world"]
    local_spec = MAPS[family]["local"]
    ik_spec = MAPS[family].get("ik_arms", []) if arms_ik > 0 else []

    act = None
    if action_name:
        act = next((a for a in bpy.data.actions if a.name.startswith(action_name)), None)
    if act is None and src.animation_data and src.animation_data.action:
        act = src.animation_data.action
    if act is None:
        raise SystemExit("动作源里没有可用的动作")
    src.animation_data.action = act
    fr = act.frame_range
    total = (fr[1] - fr[0]) / float(src_fps)

    if window:
        w0 = max(0.0, min(total - 0.4, float(window[0])))
        w1 = max(w0 + 0.4, min(total, float(window[1])))
    else:
        w0, w1 = 0.0, total
    span = w1 - w0
    if frames is None:
        frames = int(round(span * fps))
    frames = max(24, min(240, int(frames)))
    print(f"[mocap] 源：{note} / 骨架 {family} / 动作 {act.name!r} / 全长 {total:.2f}s / "
          f"取 {w0:.2f}~{w1:.2f}s → {frames} 帧 @ {fps}fps / scale {scale:g} smooth {smooth:g}s")

    scene = bpy.context.scene
    scene.render.fps = int(fps)
    if rig.animation_data:
        rig.animation_data.action = None
    scene.frame_set(int(round(fr[0] + w0 * src_fps)))
    bpy.context.view_layer.update()
    # 这里**不**切 FK（原因见上面 switch_limbs_to_fk 那段注释）：
    # 关掉 IK 会把 relax_arms_to_idle 摆好的垂手站姿退回 A-pose（侧展 0.70 / 垂度 0.71）。
    # 手臂链基准：把「源素材窗口起点那一帧」按世界校正搬到目标骨架上。
    # 用这个基准时 scale=1 与旧公式 target_world = corr · source_world 完全等价。
    world_pairs = []
    for s_name, t_name, _ in world_spec:
        if s_name not in src.pose.bones or t_name not in rig.pose.bones:
            print(f"  ! 跳过 {s_name} -> {t_name}（骨架里没有）")
            continue
        corr = _rest_rot(rig, t_name) @ _rest_rot(src, s_name).inverted()
        ref = corr @ (src.matrix_world @ src.pose.bones[s_name].matrix).to_quaternion()
        # 诊断：素材窗口起点的手臂，相对它自己的静止姿势偏了多少（偏太多说明这个窗口的站姿不适合当 idle 基准）
        off = math.degrees((corr @ _rest_rot(src, s_name)).rotation_difference(ref).angle)
        print(f"    手臂基准 {s_name:22s} 偏离源静止姿势 {off:5.1f}°")
        world_pairs.append((s_name, t_name, corr, ref))

    local_pairs = []
    for s_name, t_name in local_spec:
        parts = [s_name] if isinstance(s_name, str) else list(s_name)
        if t_name not in rig.pose.bones or any(p not in src.pose.bones for p in parts):
            print(f"  ! 跳过局部增量 {s_name} -> {t_name}")
            continue
        local_pairs.append((parts, t_name,
                            [_bone_local_rot(src, p) for p in parts],
                            rig.pose.bones[t_name].matrix_basis.to_quaternion()))

    # IK 手臂基准：放松后的手部目标位置 + 臂长比（源素材是另一个人，臂长不同，位移要按比例缩）
    ik_arms = []
    for sh_name, wr_name, ik_name in ik_spec:
        if sh_name not in src.pose.bones or wr_name not in src.pose.bones or ik_name not in rig.pose.bones:
            print(f"  ! 跳过 IK 手臂 {sh_name}/{wr_name} -> {ik_name}")
            continue
        sh0 = (src.matrix_world @ src.pose.bones[sh_name].matrix).translation.copy()
        wr0 = (src.matrix_world @ src.pose.bones[wr_name].matrix).translation.copy()
        ik_pb = rig.pose.bones[ik_name]
        anchor = (rig.matrix_world @ ik_pb.matrix).translation.copy()
        len_s = (wr0 - sh0).length
        len_t = 0.0
        for dname in ("arm.l" if ik_name.endswith(".l") else "arm.r", "arm_stretch.l" if ik_name.endswith(".l") else "arm_stretch.r"):
            db = rig.pose.bones.get(dname)
            if db:
                len_t = ((rig.matrix_world @ db.matrix).translation - anchor).length
                break
        # 源素材与目标骨架的单位不一样（CMU 的 BVH 是英寸级），所以要按「臂长比」归一：
        # 位移先除以源臂长变成无量纲比例，再乘以目标臂长。夹太狠会把比例抬成 0.4，
        # 于是 10 单位的位移被当成 0.48 米塞进去（手会甩出去）。
        ratio = (len_t / len_s) if len_s > 1e-9 and len_t > 1e-9 else 1.0
        ratio = max(1e-4, min(10.0, ratio))
        ik_arms.append((sh_name, wr_name, ik_name, wr0 - sh0, anchor, ratio))
        print(f"  IK 手臂 {ik_name}: 臂长比 {ratio:.2f} / 位移系数 {arms_ik:g}")

    # ── 采样到内存
    sampled = {}
    ik_deltas = {name: [] for _, _, name, _, _, _ in ik_arms}

    def _basis(pb):
        return pb.matrix_basis.to_quaternion()

    for f in range(1, frames + 1):
        t_sec = w0 + (f - 1) * span / float(frames)
        scene.frame_set(int(round(fr[0] + t_sec * src_fps)))
        bpy.context.view_layer.update()
        for s_name, t_name, corr, ref in world_pairs:
            src_rot = (src.matrix_world @ src.pose.bones[s_name].matrix).to_quaternion()
            delta = (corr @ src_rot) @ ref.inverted()
            if scale < 1.0:
                delta = Quaternion().slerp(delta, scale)
            tgt_pb = rig.pose.bones[t_name]
            cur = tgt_pb.matrix.translation.copy()
            tgt_pb.matrix = Matrix.Translation(cur) @ (delta @ ref).to_matrix().to_4x4()
            bpy.context.view_layer.update()
            sampled.setdefault(t_name, []).append(_basis(tgt_pb))
        for parts, t_name, s_rests, t_rest in local_pairs:
            delta = Quaternion()
            for p, s_rest in zip(parts, s_rests):
                delta = delta @ (s_rest.inverted() @ _bone_local_rot(src, p))
            if scale < 1.0:
                delta = Quaternion().slerp(delta, scale)
            tgt_pb = rig.pose.bones[t_name]
            basis = tgt_pb.matrix_basis.copy()
            new_basis = (t_rest @ delta).to_matrix().to_4x4()
            new_basis.translation = basis.translation
            tgt_pb.matrix_basis = new_basis
            sampled.setdefault(t_name, []).append(_basis(tgt_pb))
        for sh_name, wr_name, ik_name, rel0, anchor, ratio in ik_arms:
            sh = (src.matrix_world @ src.pose.bones[sh_name].matrix).translation
            wr = (src.matrix_world @ src.pose.bones[wr_name].matrix).translation
            ik_deltas[ik_name].append((wr - sh) - rel0)
        bpy.context.view_layer.update()

    # ── 后处理：滑动平均 → 循环收口
    if smooth > 0:
        k = max(3, int(round(smooth * fps)))
        for name, series in sampled.items():
            out, half = [], k // 2
            for i in range(len(series)):
                acc = series[max(0, i - half)]
                cnt = 1
                for j in range(max(0, i - half) + 1, min(len(series), i + half + 1)):
                    acc = acc.slerp(series[j], 1.0 / (cnt + 1))
                    cnt += 1
                out.append(acc.copy())
            sampled[name] = out

    if loop_blend > 0:
        m = int(round(loop_blend * fps))
        for name, series in sampled.items():
            if len(series) <= m + 1:
                continue
            first = series[0].copy()
            for i in range(len(series) - m, len(series)):
                w = (i - (len(series) - m) + 1) / float(m)
                series[i] = series[i].slerp(first, min(1.0, w))

    # 手部位移的平滑与收口（向量序列，单独处理）
    if ik_deltas:
        k = max(1, int(round(smooth * fps))) if smooth > 0 else 1
        for name, series in ik_deltas.items():
            if k > 1:
                half = k // 2
                acc2 = []
                for i in range(len(series)):
                    s = Vector((0, 0, 0))
                    c = 0
                    for j in range(max(0, i - half), min(len(series), i + half + 1)):
                        s = s + series[j]
                        c += 1
                    acc2.append(s / float(c))
                series[:] = acc2
        m = int(round(loop_blend * fps)) if loop_blend > 0 else 0
        if m > 0:
            for name, series in ik_deltas.items():
                if len(series) <= m + 1:
                    continue
                for i in range(len(series) - m, len(series)):
                    w = (i - (len(series) - m) + 1) / float(m)
                    series[i] = series[i].lerp(Vector((0, 0, 0)), min(1.0, w))

    # ── 写关键帧
    if not rig.animation_data:
        rig.animation_data_create()
    rig.animation_data.action = None
    new_act = bpy.data.actions.new(clip)
    new_act.use_fake_user = True
    rig.animation_data.action = new_act
    scene.frame_start, scene.frame_end = 1, frames

    for pb in rig.pose.bones:
        pb.keyframe_insert("location", frame=1)
        pb.keyframe_insert("scale", frame=1)
        ch = {0: "rotation_euler", 1: "rotation_quaternion", 2: "rotation_axis_angle"}.get(
            pb.rotation_mode if isinstance(pb.rotation_mode, int) else -1)
        if ch is None:
            ch = "rotation_quaternion" if pb.rotation_mode == "QUATERNION" else (
                "rotation_axis_angle" if pb.rotation_mode == "AXIS_ANGLE" else "rotation_euler")
        pb.keyframe_insert(ch, frame=1)

    for name, series in sampled.items():
        pb = rig.pose.bones[name]
        quat_mode = pb.rotation_mode == "QUATERNION"
        for i, q in enumerate(series):
            basis = pb.matrix_basis.copy()
            nb = q.to_matrix().to_4x4()
            nb.translation = basis.translation
            pb.matrix_basis = nb
            pb.keyframe_insert("rotation_quaternion" if quat_mode else "rotation_euler", frame=i + 1)

    # IK 手部目标的位置关键帧（IK 链是活的，移动目标就会重新解算手臂）
    for sh_name, wr_name, ik_name, rel0, anchor, ratio in ik_arms:
        pb = rig.pose.bones[ik_name]
        rot = pb.matrix.to_3x3().to_4x4()
        quat_mode = pb.rotation_mode == "QUATERNION"
        for i, d in enumerate(ik_deltas[ik_name]):
            pos = anchor + d * (arms_ik * ratio)
            pb.matrix = Matrix.Translation(pos) @ rot
            pb.keyframe_insert("location", frame=i + 1)
            pb.keyframe_insert("rotation_quaternion" if quat_mode else "rotation_euler", frame=i + 1)

    # 量化自检：把生成结果的实际摆幅打出来，用数据判断「有没有动」和「会不会转圈」
    head = rig.pose.bones.get("c_head.x")
    stats = ""
    if head:
        yaws, pitches = [], []
        for f in range(1, frames + 1, max(1, frames // 12)):
            scene.frame_set(f)
            bpy.context.view_layer.update()
            m = (rig.matrix_world @ head.matrix).to_3x3()
            yaws.append(math.degrees(math.atan2(m[1][0], m[0][0])))
            pitches.append(math.degrees(math.asin(max(-1.0, min(1.0, -m[2][1])))))
        stats = (f" / 头 yaw {min(yaws):+.1f}~{max(yaws):+.1f}° "
                 f"pitch {min(pitches):+.1f}~{max(pitches):+.1f}° / 首末帧差 {abs(yaws[-1] - yaws[0]):.1f}°")

    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new()
    track.name = clip
    track.strips.new(clip, 1, new_act).name = clip
    track.mute = True
    print(f"[mocap] → 生成 {clip!r}（{len(world_pairs)} 世界校正 + {len(local_pairs)} 局部增量 / {frames} 帧{stats}）")
    return new_act


# 配件的静止姿势和作者摆的姿势不一样，所以之前是烘成静态几何的；
# 但头一动它们就留在原地（表现为光头 + 头顶飘着发饰）。
# 这里把它们刚性绑到身体骨架的对应骨上：头发/光环跟头，翅膀跟胸。
ACCESSORY_FOLLOW = [
    (r"阿能头发|^hair|头发", "head.x"),
    (r"环体|光环", "head.x"),
    (r"chibang", "c_spine_03.x"),
]


def bind_accessories_to_body(meshes, rig):
    """
    让配件跟着身体骨架动。

    不能用「加顶点组 + 骨架修改器」——那份网格是后烘成静态的，补上的蒙皮会因为
    绑定矩阵对不上而被压成一个点（实测头发 size 变成 0.00，人就光头了）。
    改用骨骼父子：把对象挂到对应骨上，刚性跟随，不参与蒙皮数学。
    """
    report = []
    for obj in meshes:
        if obj.type != "MESH":
            continue
        for pattern, bone in ACCESSORY_FOLLOW:
            if not re.search(pattern, obj.name, re.I):
                continue
            if bone not in rig.data.bones:
                report.append(f"{obj.name}: 骨架里没有 {bone}，跳过")
                break
            world = obj.matrix_world.copy()
            obj.parent = rig
            obj.parent_type = "BONE"
            obj.parent_bone = bone
            obj.matrix_world = world
            report.append(f"{obj.name} → 骨骼父级 {bone}（刚性跟随）")
            break
    bpy.context.view_layer.update()
    return report


def main():
    (out, max_tex, face_tex, with_skins, animate, alive, do_pose,
     inward, down, mocap, mocap_action, mocap_frames, mocap_clip, \
        mocap_window, mocap_scale, mocap_smooth, mocap_loop, mocap_arms_ik) = parse_args()
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
        if alive:
            pruned = prune_shape_keys(picked)
            print(f"[alive] 形态键裁剪（{len(pruned)} 个网格）：")
            for line in pruned:
                print("   -", line)
            prepared = prepare_for_morph_export(picked)
            if prepared:
                print(f"[alive] 修改器预处理（{len(prepared)} 条）：")
                for line in prepared:
                    print("   -", line)
            if mocap:
                retarget_mocap(bpy.data.objects["rig"], mocap, mocap_action,
                              frames=mocap_frames, clip=mocap_clip, window=mocap_window,
                              scale=mocap_scale, smooth=mocap_smooth, loop_blend=mocap_loop,
                              arms_ik=mocap_arms_ik)
            else:
                clips = author_alive_clips(bpy.data.objects["rig"])
                print("[alive] 编好的动作（没有给 --mocap，用的是内置手编循环）：")
                for line in clips:
                    print("   -", line)
        else:
            tracks = add_breathing_loop()
            print("[anim] 呼吸循环关键帧：")
            for line in tracks:
                print("   -", line)
    if with_skins:
        report = prepare_meshes_for_skin(picked, "rig")
        print(f"[skin] 蒙皮/静态分派（{len(report)} 条）：")
        for line in report:
            print("   -", line)
        # 非骨架修改器交给 export_apply 处理：
        # 自己手动应用会在带形态键的网格（比如脸）上失败并回退 convert，
        # 那样连骨架修改器也会被烘掉、蒙皮直接丢失。
        if alive:
            bound = bind_accessories_to_body(picked, bpy.data.objects["rig"])
            if bound:
                print(f"[skin] 配件刚性跟随身体骨架（{len(bound)} 个）：")
                for line in bound:
                    print("   -", line)
        keyed = key_current_pose([a for a in usable if a.name == "rig"]) if not alive else []
        if keyed:
            print("[pose] 身体骨架的当前姿势已钉成关键帧：")
            for line in keyed:
                print("   -", line)

    # 前面为了应用修改器反复改过选择集，导出前必须恢复：use_selection=True 靠它
    bpy.ops.object.select_all(action="DESELECT")
    for obj in picked:
        obj.select_set(True)
    for arm_obj in usable:
        if arm_obj.name in {o.name for o in bpy.context.view_layer.objects}:
            arm_obj.select_set(True)
    bpy.context.view_layer.objects.active = picked[0]

    # 3./4. 导出
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        use_selection=True,
        export_apply=not alive,  # 开关头：export_apply 开着就不导形态键，活人感模式下必须关
        export_skins=with_skins,
        export_animations=with_skins,
        export_frame_range=animate and not alive,
        # 一段 action 一个 clip（idle / talk）；活人感靠运行时 crossfade 切换
        export_animation_mode="NLA_TRACKS" if alive else "ACTIVE_ACTIONS",
        export_morph=alive,
        export_def_bones=with_skins,  # 只要形变骨；rigify 的控制骨一千多根，带上是纯负担
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
    )

    print(f"[export] ok -> {out} ({os.path.getsize(out)/1024/1024:.2f} MB)")


main()
