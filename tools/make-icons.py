#!/usr/bin/env python3
"""Generate the Video Downloader Ultra toolbar/extension icons as PNGs.

Draws the official geometric studio mark (the poster's media stream extractor
glyph in terracotta #B5562F) at 16, 48, and 128px with transparent backgrounds
and saves them to extension/icons/.
"""
import pathlib
import subprocess
import tempfile
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"
ACCENT = "#B5562F"

SVG_CONTENT = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="128" height="128">
  <!-- Top datum rail with centered ingress opening -->
  <path d="M 4 7 L 12 7" stroke="{ACCENT}" stroke-width="2.2" stroke-linecap="round" fill="none" />
  <path d="M 20 7 L 28 7" stroke="{ACCENT}" stroke-width="2.2" stroke-linecap="round" fill="none" />
  
  <!-- Downward media stream vector -->
  <line x1="16" y1="4" x2="16" y2="20" stroke="{ACCENT}" stroke-width="2.2" stroke-linecap="round" />
  <path d="M 10 14 L 16 20 L 22 14" stroke="{ACCENT}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" />
  
  <!-- Baseline buffer tray with architectural vertical stops -->
  <path d="M 5 24 L 5 28 L 27 28 L 27 24" stroke="{ACCENT}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none" />
</svg>"""


def html_for(size: int, stroke_width: float) -> str:
    return f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ width: {size}px; height: {size}px; background: transparent; overflow: hidden; }}
svg {{ display: block; width: {size}px; height: {size}px; }}
</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="{size}" height="{size}">
  <path d="M 4 7 L 12 7" stroke="{ACCENT}" stroke-width="{stroke_width}" stroke-linecap="round" fill="none" />
  <path d="M 20 7 L 28 7" stroke="{ACCENT}" stroke-width="{stroke_width}" stroke-linecap="round" fill="none" />
  <line x1="16" y1="4" x2="16" y2="20" stroke="{ACCENT}" stroke-width="{stroke_width}" stroke-linecap="round" />
  <path d="M 10 14 L 16 20 L 22 14" stroke="{ACCENT}" stroke-width="{stroke_width}" stroke-linecap="round" stroke-linejoin="round" fill="none" />
  <path d="M 5 24 L 5 28 L 27 28 L 27 24" stroke="{ACCENT}" stroke-width="{stroke_width}" stroke-linecap="round" stroke-linejoin="round" fill="none" />
</svg>
</body>
</html>"""


def find_browser():
    for name in ("chromium", "google-chrome", "chrome", "brave"):
        p = shutil.which(name)
        if p:
            return p
    return None


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    browser = find_browser()
    if not browser:
        raise RuntimeError("No Chromium/Chrome binary found to render PNG icons")

    # Also save vector icon.svg
    svg_path = OUT / "icon.svg"
    svg_path.write_text(SVG_CONTENT)
    print(f"wrote {svg_path}")

    # Render PNGs at 16, 48, 128
    sizes = [(16, 2.4), (48, 2.2), (128, 2.2)]
    with tempfile.TemporaryDirectory() as tmpdir:
        for size, stroke in sizes:
            html_file = pathlib.Path(tmpdir) / f"icon-{size}.html"
            html_file.write_text(html_for(size, stroke))
            png_path = OUT / f"icon-{size}.png"
            cmd = [
                browser,
                "--headless",
                "--disable-gpu",
                "--default-background-color=00000000",
                f"--window-size={size},{size}",
                f"--screenshot={png_path}",
                f"file://{html_file}",
            ]
            subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            print(f"wrote {png_path} ({png_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()