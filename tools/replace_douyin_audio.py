from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE_VIDEO = ROOT / "video_output/qianchuan_douyin_human_slow_trimmed.mp4"
OUT_VIDEO = ROOT / "video_output/qianchuan_douyin_real_voice.mp4"


def main():
    if len(sys.argv) != 2:
        print("Usage: python3 tools/replace_douyin_audio.py /path/to/voice.m4a")
        sys.exit(2)
    voice = Path(sys.argv[1]).expanduser().resolve()
    if not voice.exists():
        print(f"Voice file not found: {voice}")
        sys.exit(1)
    if not BASE_VIDEO.exists():
        print(f"Base video not found: {BASE_VIDEO}")
        sys.exit(1)

    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(BASE_VIDEO),
        "-i",
        str(voice),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        str(OUT_VIDEO),
    ]
    subprocess.run(cmd, check=True)
    print(f"Wrote {OUT_VIDEO}")


if __name__ == "__main__":
    main()
