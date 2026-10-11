#!/usr/bin/env python3
"""Remove the white background from the pickaxe icon to make it transparent."""
from PIL import Image

INPUT = "/home/z/my-project/public/pickaxe.png"
OUTPUT = "/home/z/my-project/public/pickaxe.png"

img = Image.open(INPUT).convert("RGBA")
pixels = img.load()
w, h = img.size

# Threshold: pixels close to white become transparent.
WHITE_THRESHOLD = 235

for y in range(h):
    for x in range(w):
        r, g, b, a = pixels[x, y]
        if r >= WHITE_THRESHOLD and g >= WHITE_THRESHOLD and b >= WHITE_THRESHOLD:
            pixels[x, y] = (255, 255, 255, 0)
        elif r >= 215 and g >= 215 and b >= 215:
            minc = min(r, g, b)
            alpha = int(255 * (WHITE_THRESHOLD - minc) / max(1, (WHITE_THRESHOLD - 215)))
            pixels[x, y] = (r, g, b, max(0, min(255, alpha)))

img.save(OUTPUT)
print(f"Saved transparent pickaxe to {OUTPUT} ({w}x{h})")
