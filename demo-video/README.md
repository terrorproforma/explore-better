# Explore Better hype demo

This folder contains the reproducible renderer for the 1080p Explore Better launch cut.

Run from the repository root:

```powershell
node demo-video/render.mjs
```

The renderer uses the real application captures in `site/assets` and `artifacts`, creates an original procedural electronic score, and writes the finished H.264/AAC video plus a poster, contact sheet, and claim manifest to `demo-video/output`.

The performance card preserves the published benchmark caveat: the PowerShell comparison includes fresh process startup.
