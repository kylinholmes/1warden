# 图标制作记录

正式图标按用户批准的 SVG／脚本方案制作，源文件是 app.svg、compact.svg 和 tray-template.svg；原始设计未修改。

此前使用内置 image_gen 编辑工具尝试过两张位图（未使用 CLI）。输出没有实际 alpha 通道，因此未进入产品。以下仅保留当时的提示词，便于追溯；最终精确的像素形状以本目录 SVG 为准。

## 大尺寸尝试（未采用）

```text
Use case: precise-object-edit. Image 1 is the edit target, the approved 1Warden logo. Make ONE production-ready large application icon, not a presentation sheet.
Keep the recognizable closed broad shield with its V-shaped pointed bottom, central numeral "1", coarse pixel-stepped silhouette, dark desaturated navy tile, ivory face and narrow muted antique-brass lower-right bevel. Preserve the design and retro character; do not invent a different shield.
Changes: remove the entire off-white outside canvas and replace it with genuine alpha transparency (not a checkerboard). Enlarge the square navy tile so its straight edges are only 3% inset from the square image boundaries; retain its pixel-stepped clipped corners. Outside the tile must be transparent. Reduce the outer slate frame to a single subtle narrow pixel bevel. Clean up the noisy dither specks around the shield into a few deliberate coherent stepped clusters and make the numeral a little bolder. The ivory shield and numeral remain the primary contrast, brass is edging only. Reduce unnecessary soft shading; crisp intentional pixels with no blur. At application-icon size the silhouette and the 1 should both remain legible.
Colors stay navy approximately #1B2734, warm ivory #E7E1CF, antique brass #8D7953, restrained slate #43515B. No cyan/pink/purple, gradients, glow, photorealistic metallic reflection, surrounding scene, added text, labels, captions, watermark or second icon. Exactly one centered square icon with transparent exterior, no white matte.
```

## 小尺寸尝试（未采用）

```text
Use case: precise-object-edit. Image 1 is the approved 1Warden logo and edit target.
Create its optical small-size variant for a browser toolbar and desktop tray. Keep its identity: a fully CLOSED wide shield ending in a deep V point, a single clear central numeral "1", retro stepped pixel geometry, navy and ivory with restrained brass. This is one finished square icon, not a sheet or mockup.
Small-icon simplification: use a deliberate coarse 24-unit grid. Enlarge the numeral and the empty space around it. The shield ring should be about two grid units thick, not massive; keep top horizontal band closed, wide shoulders and tapered V tip. Draw the numeral as a bold vertical stroke with a short diagonal flag and a small baseline, legible as "1". Keep a navy square tile with stepped clipped corners and no decorative frame, occupying almost the whole image with only about 3% transparent exterior. Use crisp FLAT solid navy #1B2734 and warm ivory #E7E1CF. At most a single narrow offset antique-brass #8D7953 edge along the lower-right of the shield, never multiple shadows.
Remove all dithering, speckles, texture, grain, tiny highlights, bevels on the numeral, soft shadow, gradients and glow. Intentional clean pixels, no blur. Outside the navy tile must be genuinely transparent alpha, not a painted checkerboard or white background. No mockup, labels, extra text, title, watermark, additional objects, repeated copies or tiled preview. Exactly one centered, compact, finished app icon.
```
