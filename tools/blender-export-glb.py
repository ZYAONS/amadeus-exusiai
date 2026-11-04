# 在 Blender 里把一个 .blend 导出成 web 能加载的 GLB。
# 用法（命令行，不进 Blender 界面）：
#   blender -b "你的模型.blend" --python tools/blender-export-glb.py -- "D:\agentle\out.glb"
# 然后在项目里：node tools/fetch-model.mjs D:\agentle\out.glb
#
# 只导出当前场景里可见的网格/骨架/动画，带上贴图（打包进 .glb 单文件）。
import sys
import os

import bpy


def main():
    argv = sys.argv
    out = None
    if "--" in argv:
        rest = argv[argv.index("--") + 1:]
        if rest:
            out = rest[0]
    if not out:
        raise SystemExit("缺少输出路径：blender -b 文件.blend --python tools/blender-export-glb.py -- 输出.glb")

    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    # 只导出可见对象：导出前把隐藏的（参考图、备用件、绑定用辅助体）关掉，否则会一起吐出来
    for obj in bpy.context.view_layer.objects:
        if obj.hide_get() or obj.hide_viewport:
            obj.select_set(False)

    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        use_selection=False,
        export_apply=True,          # 应用修改器：不加这句，细分/布料/头发在 web 里会消失
        export_skins=True,          # 骨架
        export_animations=True,     # 自带动画（有的话）
        export_yup=True,            # glTF 是 Y 轴朝上，Blender 是 Z 轴朝上，必须转
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=False,
        export_lights=False,
    )

    size = os.path.getsize(out)
    print(f"[export] ok -> {out} ({size/1024/1024:.2f} MB)")


main()
