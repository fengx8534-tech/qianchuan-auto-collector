from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance
import math
import random
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "video_output"
AUDIO = OUT / "real_voice_rhythm_polished.m4a"
VIDEO = OUT / "qianchuan_douyin_scifi_real_voice.mp4"

W, H = 1080, 1920
FPS = 24
FONT = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"

screens = [
    ROOT / "local-backend/data/visual/auto-1782919667445-investOverview.png",
    ROOT / "local-backend/data/visual/auto-1782919667445-controlTable.png",
    ROOT / "local-backend/data/visual/auto-1782919667445-liveScreen.png",
]

sections = [
    (0.0, 6.0, "PROJECT ORIGIN", "为什么要做", ["长时段直播跟播", "消耗 ROI 预算持续变化", "人工巡检容易漏异常"], 0),
    (6.0, 13.5, "AUTOMATION FLOW", "开发链路", ["页面采集", "本地后台汇总", "规则 + AI 判断", "人工确认"], 1),
    (13.5, 21.5, "SYSTEM READY", "当前进展", ["Chrome 插件", "Node 后台", "DeepSeek 决策", "AI 审批弹窗"], 0),
    (21.5, 30.5, "LIVE DATA", "测试结果", ["totalTrend 已解析", "52 个趋势点", "消耗 / ROI / 成交金额"], 2),
    (30.5, 40.0, "TASK RADAR", "任务识别", ["预算、消耗、ROI", "曝光、点击、成交", "追投任务健康度"], 1),
    (40.0, 48.5, "AI DECISION", "AI 判断", ["结合 SOP 和四象限", "ROI 为 0 自动预警", "建议暂停但先审批"], 1),
    (48.5, 56.0, "BLOCKERS", "当前卡点", ["数据源稳定性", "官方 API / 执行权限", "安全边界和回滚"], 2),
    (56.0, 61.3, "NEXT STEP", "下一步", ["稳定数据源", "打通执行闭环", "沉淀投放经验系统"], 0),
]


def fnt(size, light=False):
    return ImageFont.truetype(FONT_LIGHT if light else FONT, size)


def cover(img, w, h):
    iw, ih = img.size
    scale = max(w / iw, h / ih)
    nw, nh = int(iw * scale), int(ih * scale)
    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
    return img.crop(((nw - w) // 2, (nh - h) // 2, (nw + w) // 2, (nh + h) // 2))


def load_screen(path):
    img = Image.open(path).convert("RGB")
    img = cover(img, 820, 470)
    img = img.filter(ImageFilter.GaussianBlur(4))
    img = ImageEnhance.Contrast(img).enhance(0.75)
    img = ImageEnhance.Color(img).enhance(0.55)
    tint = Image.new("RGB", img.size, (15, 95, 135))
    img = Image.blend(img, tint, 0.22)
    return img.convert("RGBA")


screen_imgs = [load_screen(p) for p in screens]
random.seed(42)
stars = [(random.randrange(W), random.randrange(H), random.random()) for _ in range(160)]
particles = [(random.random(), random.random(), random.random()) for _ in range(90)]


def active_section(t):
    for idx, sec in enumerate(sections):
        if sec[0] <= t < sec[1]:
            return idx, sec
    return len(sections) - 1, sections[-1]


def glow_line(draw, p1, p2, color, width=2):
    for w, alpha in [(width + 8, 24), (width + 4, 48), (width, color[3])]:
        draw.line([p1, p2], fill=(color[0], color[1], color[2], alpha), width=w)


def round_rect(draw, xy, r, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)


def text(draw, xy, s, font, fill):
    draw.text(xy, s, font=font, fill=fill)


def make_frame(t, frame_i):
    idx, sec = active_section(t)
    s0, s1, code, title, bullets, img_idx = sec
    local = (t - s0) / max(0.001, s1 - s0)

    img = Image.new("RGBA", (W, H), (3, 8, 18, 255))
    draw = ImageDraw.Draw(img)

    # Background vertical gradient.
    for y in range(0, H, 4):
        k = y / H
        r = int(3 + 9 * k)
        g = int(8 + 18 * k)
        b = int(18 + 34 * k)
        draw.rectangle((0, y, W, y + 4), fill=(r, g, b, 255))

    # Starfield and moving particles.
    for x, y, z in stars:
        pulse = 0.4 + 0.6 * math.sin(t * 1.7 + z * 9)
        a = int(45 + 110 * pulse * z)
        draw.point((x, (y + int(t * 12 * z)) % H), fill=(90, 210, 255, a))
    for px, py, pz in particles:
        x = int((px * W + t * (18 + pz * 50)) % W)
        y = int((py * H + math.sin(t + pz * 8) * 18) % H)
        a = int(35 + 70 * pz)
        draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(0, 230, 255, a))

    # Perspective grid.
    horizon = 1180
    van_x = W // 2 + int(math.sin(t * 0.25) * 40)
    for i in range(-10, 11):
        x = W // 2 + i * 95
        glow_line(draw, (van_x, horizon), (x, H), (24, 170, 255, 72), 1)
    for j in range(13):
        yy = horizon + int((j / 12) ** 1.85 * (H - horizon))
        glow_line(draw, (0, yy), (W, yy), (24, 170, 255, 55), 1)

    # Scanline.
    scan_y = int((t * 95) % H)
    draw.rectangle((0, scan_y - 2, W, scan_y + 2), fill=(90, 240, 255, 50))

    # Top HUD.
    round_rect(draw, (54, 58, 1026, 138), 24, (0, 0, 0, 150), (78, 225, 255, 180), 2)
    text(draw, (82, 82), "QIANCHUAN LIVE OPS / AI CONTROL ROOM", fnt(25), (230, 250, 255, 235))
    text(draw, (858, 82), f"{idx + 1:02d}/08", fnt(28), (120, 236, 255, 255))

    # Main title.
    text(draw, (68, 206), title, fnt(72), (245, 252, 255, 255))
    text(draw, (70, 302), code, fnt(31, True), (69, 226, 255, 230))

    # Screenshot hologram card.
    card_x = 105 + int(math.sin(t * 0.7) * 5)
    card_y = 475
    card_w, card_h = 870, 530
    shadow = Image.new("RGBA", (card_w + 70, card_h + 70), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((35, 35, card_w + 35, card_h + 35), radius=30, fill=(0, 220, 255, 38))
    shadow = shadow.filter(ImageFilter.GaussianBlur(20))
    img.alpha_composite(shadow, (card_x - 35, card_y - 35))

    round_rect(draw, (card_x, card_y, card_x + card_w, card_y + card_h), 30, (2, 12, 28, 210), (88, 232, 255, 190), 2)
    screen = screen_imgs[img_idx].copy()
    sx = card_x + 25
    sy = card_y + 44
    img.alpha_composite(screen, (sx, sy))
    # hologram scan and corners
    for k in range(0, 470, 18):
        y = sy + k + int((t * 25) % 18)
        draw.line((sx, y, sx + 820, y), fill=(108, 240, 255, 22), width=1)
    corner = 58
    c = (112, 245, 255, 235)
    for x, y, sxn, syn in [
        (card_x + 18, card_y + 18, 1, 1),
        (card_x + card_w - 18, card_y + 18, -1, 1),
        (card_x + 18, card_y + card_h - 18, 1, -1),
        (card_x + card_w - 18, card_y + card_h - 18, -1, -1),
    ]:
        draw.line((x, y, x + corner * sxn, y), fill=c, width=3)
        draw.line((x, y, x, y + corner * syn), fill=c, width=3)

    # Rotating radar rings.
    cx, cy = 870, 330
    for r in [52, 84, 116]:
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(60, 210, 255, 70), width=2)
    ang = t * 2.3
    draw.line((cx, cy, cx + math.cos(ang) * 116, cy + math.sin(ang) * 116), fill=(100, 255, 220, 180), width=3)
    draw.ellipse((cx - 7, cy - 7, cx + 7, cy + 7), fill=(120, 255, 236, 255))

    # Bullet panels.
    by = 1115
    for n, b in enumerate(bullets, start=1):
        y = by + (n - 1) * 145
        show = max(0, min(1, (local * 1.6 - (n - 1) * 0.18)))
        xoff = int((1 - show) * 70)
        alpha = int(70 + show * 150)
        round_rect(draw, (70 + xoff, y, 1010 + xoff, y + 100), 18, (0, 12, 28, alpha), (64, 214, 255, int(70 + show * 120)), 1)
        round_rect(draw, (95 + xoff, y + 21, 158 + xoff, y + 81), 14, (0, 118, 255, int(120 + show * 110)))
        text(draw, (113 + xoff, y + 33), f"{n}", fnt(25), (255, 255, 255, 255))
        text(draw, (190 + xoff, y + 25), b, fnt(38), (248, 253, 255, int(120 + show * 135)))

    # Bottom status strip.
    round_rect(draw, (64, 1780, 1016, 1858), 18, (0, 0, 0, 130), (78, 225, 255, 110), 1)
    progress = t / sections[-1][1]
    draw.rectangle((88, 1829, 88 + int(760 * progress), 1837), fill=(0, 230, 255, 210))
    text(draw, (88, 1798), "REAL VOICE / SCI-FI HUD / SEMI-AUTO OPS", fnt(25), (230, 250, 255, 210))
    text(draw, (870, 1798), f"{int(t):02d}s", fnt(25), (122, 238, 255, 230))

    # Fine noise overlay for texture.
    if frame_i % 2 == 0:
        for _ in range(120):
            x = random.randrange(W)
            y = random.randrange(H)
            draw.point((x, y), fill=(255, 255, 255, 12))

    return img.convert("RGB")


def main():
    duration = sections[-1][1]
    total = int(duration * FPS)
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
        "-i", str(AUDIO),
        "-shortest", "-c:v", "libx264", "-preset", "medium", "-crf", "19",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(VIDEO),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for i in range(total):
        frame = make_frame(i / FPS, i)
        proc.stdin.write(frame.tobytes())
        if i % 120 == 0:
            print(f"frame {i}/{total}")
    proc.stdin.close()
    proc.wait()
    if proc.returncode:
        raise SystemExit(proc.returncode)
    print(f"Wrote {VIDEO}")


if __name__ == "__main__":
    main()
