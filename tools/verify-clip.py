"""把导出的 GLB 重新导入，逐帧量姿态：头有多大幅度、会不会累积漂移、循环是否闭合、手臂动没动。

   "D:\\Blender\\4.2\\blender.exe" -b --factory-startup --python tools/verify-clip.py -- public/assets/model/character.glb

它做的事和自检不同：tools/check.mjs 只验证「动画时钟在走、骨骼坐标在变」，
分不出「8.5° 的环顾」和「每秒转 8° 的自转」——这个脚本逐帧量朝向，
SLOPE 那一行就是当初那个 bug 的量化指标（出问题时约 +8°/秒）。
"""
import sys
import math
import bpy

argv = sys.argv
path = argv[argv.index("--") + 1] if "--" in argv else "public/assets/model/character.glb"

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
bpy.ops.import_scene.gltf(filepath=path)

arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
print("ARMATURES", [a.name for a in arms])
print("ACTIONS", [(a.name, tuple(int(v) for v in a.frame_range)) for a in bpy.data.actions])
# 取带动作（或带 NLA 条）的那个骨架；GLB 常把动画塞进 NLA 轨道
arm, act = None, None
for a in arms:
    ad = a.animation_data
    if ad and ad.action:
        arm, act = a, ad.action
        break
    if ad and len(ad.nla_tracks):
        strips = [s for t in ad.nla_tracks for s in t.strips]
        if strips:
            arm, act = a, strips[0].action
            break
if arm is None:
    arm = arms[0] if arms else None
if arm is None:
    raise SystemExit("GLB 里没有骨架")
if act is None:
    # 动作存在但没挂上：直接按名字挑帧数最多的那个
    act = max(bpy.data.actions, key=lambda a: a.frame_range[1] - a.frame_range[0]) if bpy.data.actions else None
if act is None:
    raise SystemExit("GLB 里没有动画")
if not arm.animation_data:
    arm.animation_data_create()
arm.animation_data.action = act
fr = act.frame_range
print("CLIP", act.name, "frames", int(fr[0]), "->", int(fr[1]), "fps", bpy.context.scene.render.fps)

head = None
for cand in ("headx", "head.x", "head"):
    if cand in arm.pose.bones:
        head = arm.pose.bones[cand]
        break
if head is None:
    head = next((b for b in arm.pose.bones if b.name.lower().startswith("head")), None)
if head is None:
    raise SystemExit("找不到头骨")
print("HEAD BONE", head.name)

scene = bpy.context.scene
# 不能用欧拉分解：头骨的 Y 轴接近竖直，YXZ 的 yaw/roll 会退化（实测单帧跳 175°，那是度量坏了）
# 改成量「相对首帧姿势的旋转」：水平面内的偏转 + 总偏角
from mathutils import Vector

def wq():
    return (arm.matrix_world @ head.matrix).to_quaternion()

scene.frame_set(int(fr[0]))
bpy.context.view_layer.update()
q0 = wq()
ref = Vector((0.0, 1.0, 0.0))
n = int(fr[1] - fr[0]) + 1
yaws, total = [], []
prev = None
for i in range(n):
    scene.frame_set(int(fr[0]) + i)
    bpy.context.view_layer.update()
    rel = q0.inverted() @ wq()
    v = ref.copy()
    v.rotate(rel)
    a = math.degrees(math.atan2(v.x, v.y))
    if prev is not None:
        while a - prev > 180:
            a -= 360
        while a - prev < -180:
            a += 360
    yaws.append(a)
    prev = a
    total.append(math.degrees(rel.angle))

span = lambda a: max(a) - min(a)
mean = lambda a: sum(a) / len(a)
half = len(yaws) // 2
first_half, second_half = mean(yaws[:half]), mean(yaws[half:])
xs = list(range(len(yaws)))
mx, my = mean(xs), mean(yaws)
slope = sum((x - mx) * (y - my) for x, y in zip(xs, yaws)) / max(1e-9, sum((x - mx) ** 2 for x in xs))
fps = bpy.context.scene.render.fps or 24
step = max(1, n // 24)

print("SAMPLES", n, "（全部 %d 帧都量了）" % n)
print("HEADING min %.2f max %.2f span %.2f（相对首帧，水平面内）" % (min(yaws), max(yaws), span(yaws)))
print("TOTALDEV max %.2f（相对首帧的总偏角）" % max(total))
print("SLOPE %.3f 度/秒（累计漂移检测：|值|>1 就是在持续自转）" % (slope * fps))
print("HALVES first %.2f second %.2f diff %.2f" % (first_half, second_half, second_half - first_half))
print("LOOP first %.2f last %.2f diff %.2f" % (yaws[0], yaws[-1], abs(yaws[-1] - yaws[0])))
print("SERIES", " ".join("%.1f" % yaws[i] for i in range(0, n, step)))
print("MAX_FRAME_JUMP %.2f 度/帧" % max(abs(yaws[i + 1] - yaws[i]) for i in range(n - 1)))

# 手臂：网格蒙皮在 *_stretch / *_twist 上，所以要量它们（arm.l 不是被蒙皮的骨）
ARMB = [b.name for b in arm.pose.bones
        if any(k in b.name for k in ("arm_stretch", "forearm_stretch", "forearm_twist"))
        or b.name.replace(".", "") in ("handl", "handr", "hand.l", "hand.r")]
dirs = {b: [] for b in ARMB}
for i in range(n):
    scene.frame_set(int(fr[0]) + i)
    bpy.context.view_layer.update()
    for b in ARMB:
        m = (arm.matrix_world @ arm.pose.bones[b].matrix).to_3x3()
        v = m.col[1].normalized()
        dirs[b].append(v.copy())
print("ARMS", len(ARMB), "块骨")
for b in ARMB:
    ds = dirs[b]
    drop = [-v.z for v in ds]   # Blender 是 Z-up，向下是 -z（three.js 那边才是 -y）
    side = [abs(v.x) for v in ds]
    # 相邻帧方向变化角度（平滑性）
    jumps = [math.degrees(ds[i].angle(ds[i + 1])) for i in range(len(ds) - 1)]
    print("ARM %-20s 垂度 %.2f~%.2f  侧展 %.2f~%.2f  最大帧间 %.2f度" % (
        b, min(drop), max(drop), min(side), max(side), max(jumps) if jumps else 0))
    if b.endswith(".l") and "forearm_stretch" in b:
        print("SERIES_SIDE_L", " ".join("%.2f" % side[i] for i in range(0, n, max(1, n // 24))))
    if b.replace(".", "") == "handl":
        print("SERIES_HANDL_DROP", " ".join("%.2f" % drop[i] for i in range(0, n, max(1, n // 24))))

# 胸（肩的父级）转了多少：这是手臂被带动的来源
for nm in ("c_spine_03.x", "spine_03.x", "c_spine_02.x", "shoulder.l"):
    if nm in arm.pose.bones:
        vals = []
        for i in range(n):
            scene.frame_set(int(fr[0]) + i)
            bpy.context.view_layer.update()
            m = (arm.matrix_world @ arm.pose.bones[nm].matrix).to_3x3()
            vals.append(math.degrees(m.col[1].normalized().angle(Vector((0, 1, 0)))))
        print("CHEST %-14s 与静止朝向偏差 %.2f~%.2f" % (nm, min(vals), max(vals)))
