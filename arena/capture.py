"""Capture a deterministic gameplay loop from the arena for the README preview.

Loads the game in headless Chromium with ?demo=1&record=<fps>, steps the
simulation one output frame at a time through window.__step(), and screenshots
the canvas after each step, so the capture does not depend on how fast the
software rasteriser happens to run.

Usage: python capture.py <out_dir> [frames=84] [fps=12] [width=1000] [height=420] [bots=8] [url=http://127.0.0.1:8765/arena/]
"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

out = Path(sys.argv[1] if len(sys.argv) > 1 else "capture")
frames = int(sys.argv[2]) if len(sys.argv) > 2 else 84
fps = int(sys.argv[3]) if len(sys.argv) > 3 else 12
w = int(sys.argv[4]) if len(sys.argv) > 4 else 1000
h = int(sys.argv[5]) if len(sys.argv) > 5 else 420
bots = int(sys.argv[6]) if len(sys.argv) > 6 else 8
base = sys.argv[7] if len(sys.argv) > 7 else "http://127.0.0.1:8765/arena/"
out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
    page.on("console", lambda m: print("[console]", m.type, m.text) if m.type in ("error", "warning") else None)
    page.goto(f"{base}?demo=1&record={fps}&bots={bots}", wait_until="networkidle")
    page.wait_for_function("window.__ready === true", timeout=60000)
    # let the bots spread out before the first frame
    for _ in range(fps * 2):
        page.evaluate("window.__step()")
    for i in range(frames):
        page.evaluate("window.__step()")
        page.screenshot(path=str(out / f"frame_{i + 1:04d}.png"), clip={"x": 0, "y": 0, "width": w, "height": h})
        if i % 12 == 0:
            print(f"frame {i + 1}/{frames}")
    browser.close()
print("done", out)
