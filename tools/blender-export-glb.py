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


def parse_args():
    argv = sys.argv
    rest = argv[argv.index("--") + 1:] if "--" in argv else []
    out = rest[0] if rest else None
    max_tex = 1024
    if "--max-tex" in rest:
        max_tex = int(rest[rest.index("--max-tex") + 1])
    return out, max_tex, "--skins" in rest


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


def main():
    out, max_tex, with_skins = parse_args()
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
        cap = max(max_tex, 2048) if re.search(r"face|eye|眼睛|脸", img.name, re.I) else max_tex
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

    # 3./4. 导出
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_skins=with_skins,
        export_animations=with_skins,
        export_def_bones=with_skins,  # 只要形变骨；rigify 的控制骨一千多根，带上是纯负担
        export_yup=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
    )

    print(f"[export] ok -> {out} ({os.path.getsize(out)/1024/1024:.2f} MB)")


main()
