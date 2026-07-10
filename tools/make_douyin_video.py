from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import textwrap

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "video_output"
FRAMES = OUT / "frames"
FRAMES.mkdir(parents=True, exist_ok=True)

W, H = 1080, 1920
FONT = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"

screens = {
    "overview": ROOT / "local-backend/data/visual/auto-1782919667445-investOverview.png",
    "tasks": ROOT / "local-backend/data/visual/auto-1782919667445-controlTable.png",
    "live": ROOT / "local-backend/data/visual/auto-1782919667445-liveScreen.png",
}


def font(size, light=False):
    return ImageFont.truetype(FONT_LIGHT if light else FONT, size)


def cover_crop(img, width=W, height=H):
    iw, ih = img.size
    scale = max(width / iw, height / ih)
    nw, nh = int(iw * scale), int(ih * scale)
    img = img.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - width) // 2
    top = (nh - height) // 2
    return img.crop((left, top, left + width, top + height))


def rounded_rect(draw, xy, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def wrap_text(draw, text, fnt, max_width):
    lines = []
    current = ""
    for ch in text:
        test = current + ch
        if draw.textbbox((0, 0), test, font=fnt)[2] <= max_width:
            current = test
        else:
            if current:
                lines.append(current)
            current = ch
    if current:
        lines.append(current)
    return lines


def draw_multiline(draw, text, xy, fnt, fill, max_width, line_gap=12):
    x, y = xy
    for line in wrap_text(draw, text, fnt, max_width):
        draw.text((x, y), line, font=fnt, fill=fill)
        y += fnt.size + line_gap
    return y


def make_bg(key):
    img = Image.open(screens[key]).convert("RGB")
    bg = cover_crop(img).filter(ImageFilter.GaussianBlur(18))
    overlay = Image.new("RGBA", (W, H), (8, 12, 18, 188))
    bg = bg.convert("RGBA")
    bg.alpha_composite(overlay)
    return bg


def add_header(draw, step, label):
    rounded_rect(draw, (64, 64, 1016, 128), 26, (0, 0, 0, 82), (255, 255, 255, 54))
    draw.text((92, 82), "千川自动化项目纪实", font=font(28), fill=(255, 255, 255, 230))
    draw.text((828, 82), f"{step}/8  {label}", font=font(24, True), fill=(152, 223, 255, 240))


def add_footer(draw):
    draw.text((64, 1815), "AI 盯盘 / 人工审批 / 日志沉淀", font=font(30), fill=(255, 255, 255, 180))


def add_screenshot_card(canvas, key, box):
    img = Image.open(screens[key]).convert("RGB")
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    fitted = cover_crop(img, w, h).filter(ImageFilter.GaussianBlur(3))
    card = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    card.paste(fitted.convert("RGBA"), (0, 0))
    mask = Image.new("L", (w, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle((0, 0, w, h), radius=30, fill=255)
    shadow = Image.new("RGBA", (w + 32, h + 32), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle((16, 16, w + 16, h + 16), radius=34, fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(14))
    canvas.alpha_composite(shadow, (x1 - 16, y1 - 16))
    canvas.paste(card, (x1, y1), mask)


def pill(draw, xy, text, fill=(36, 161, 120, 255), txt=(255, 255, 255, 255)):
    x, y = xy
    f = font(28)
    tw = draw.textbbox((0, 0), text, font=f)[2]
    rounded_rect(draw, (x, y, x + tw + 44, y + 54), 27, fill)
    draw.text((x + 22, y + 12), text, font=f, fill=txt)


slides = [
    {
        "key": "overview",
        "label": "背景",
        "title": "我用 AI 做了一个\n千川直播间自动盯盘系统",
        "sub": "不是概念稿，第一版半自动链路已经跑通",
        "bullets": ["直播间长时间跟播", "人工盯消耗、ROI、预算、任务状态", "异常容易漏，判断难沉淀"],
        "shot": None,
        "duration": 17,
    },
    {
        "key": "live",
        "label": "痛点",
        "title": "为什么要做？",
        "sub": "运营需要在多个页面之间来回切换",
        "bullets": ["千川投放总览", "直播大屏", "任务中心", "AI 复盘和调控日志"],
        "shot": "live",
        "duration": 22,
    },
    {
        "key": "overview",
        "label": "链路",
        "title": "开发思路",
        "sub": "先辅助盯盘，再进入半自动执行",
        "bullets": ["Chrome 插件采集页面和接口", "Node 本地后台汇总状态", "规则引擎 + DeepSeek AI 判断", "动作先进入人工审批"],
        "shot": "overview",
        "duration": 25,
    },
    {
        "key": "overview",
        "label": "进展",
        "title": "目前已经完成",
        "sub": "调控台、插件、后台、AI、日志都已经接上",
        "bullets": ["实时指标卡片", "任务健康度表格", "AI Decision 审批弹窗", "视觉补采和截图归档"],
        "shot": "overview",
        "duration": 24,
    },
    {
        "key": "tasks",
        "label": "测试",
        "title": "测试结果",
        "sub": "不是只做页面，真实数据链路已经能跑",
        "bullets": ["totalTrend 接口一次解析 52 个趋势点", "读取综合消耗、ROI、成交金额", "任务级预算、消耗、ROI、曝光、点击可识别"],
        "shot": "tasks",
        "duration": 26,
    },
    {
        "key": "tasks",
        "label": "AI",
        "title": "AI 会怎么判断？",
        "sub": "根据 SOP、四象限和安全规则输出建议",
        "bullets": ["例：追投任务消耗 154 元", "ROI 为 0，成交为 0", "建议暂停止损，但先进入待审批"],
        "shot": "tasks",
        "duration": 23,
    },
    {
        "key": "live",
        "label": "效果",
        "title": "跑通后的效果",
        "sub": "运营不用多个页面来回切",
        "bullets": ["数据集中到一个调控台", "异常任务自动浮出", "AI 说明原因和预期", "人只需要同意或拒绝"],
        "shot": "live",
        "duration": 22,
    },
    {
        "key": "overview",
        "label": "卡点",
        "title": "目前卡点",
        "sub": "距离真正全自动投放，还差关键能力",
        "bullets": ["数据源需要更稳定", "订单数、订单成本、5 分钟流速还要继续补齐", "真正执行需要 API 或可靠权限", "自动投放必须有安全边界和回滚"],
        "shot": None,
        "duration": 31,
    },
]


def draw_slide(i, slide):
    canvas = make_bg(slide["key"])
    draw = ImageDraw.Draw(canvas)
    add_header(draw, i + 1, slide["label"])
    add_footer(draw)

    y = 210
    title_f = font(66)
    for line in slide["title"].split("\n"):
        draw.text((64, y), line, font=title_f, fill=(255, 255, 255, 255))
        y += 82
    y += 16
    draw_multiline(draw, slide["sub"], (68, y), font(34, True), (166, 231, 255, 238), 920, 12)

    if slide["shot"]:
        add_screenshot_card(canvas, slide["shot"], (86, 650, 994, 1150))
        bullet_y = 1230
    else:
        bullet_y = 610

    for n, item in enumerate(slide["bullets"], start=1):
        bx, by = 78, bullet_y + (n - 1) * 138
        rounded_rect(draw, (64, by - 18, 1016, by + 92), 28, (0, 0, 0, 96), (255, 255, 255, 48))
        pill(draw, (88, by), f"{n:02d}", fill=(24, 118, 219, 255))
        draw_multiline(draw, item, (178, by + 4), font(36), (255, 255, 255, 238), 760, 10)

    if i == 0:
        pill(draw, (64, 1520), "第一版半自动盯盘已跑通", fill=(32, 183, 135, 255))
    if i == 4:
        pill(draw, (64, 1520), "实测：52 个趋势点", fill=(239, 148, 45, 255))
    if i == 7:
        pill(draw, (64, 1520), "下一步：执行闭环", fill=(32, 183, 135, 255))

    path = FRAMES / f"slide_{i + 1:02d}.png"
    canvas.convert("RGB").save(path, quality=95)
    return path


def main():
    for i, slide in enumerate(slides):
        draw_slide(i, slide)
    concat = OUT / "slides.ffconcat"
    with concat.open("w", encoding="utf-8") as f:
        f.write("ffconcat version 1.0\n")
        for i, slide in enumerate(slides):
            f.write(f"file 'frames/slide_{i + 1:02d}.png'\n")
            f.write(f"duration {slide['duration']}\n")
        f.write("file 'frames/slide_08.png'\n")
    print(f"Generated {len(slides)} slides in {FRAMES}")
    print(f"Wrote {concat}")


if __name__ == "__main__":
    main()
