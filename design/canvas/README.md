# Sniffo UI canvas

Source of the design reference canvas — every screen in the Signal theme, dark and light, plus the
mascot app icon. Live version: https://claude.ai/artifact/LJW28FF4TtSLaaLJYqeeEi

- `project/canvas.json` — the canvas index: pages (Scuro / Chiaro / Icona), artboard positions, titles.
- `project/*.dc.html` — one artboard per file. `Main.dc.html` draws the main window (props `dark`,
  `view`: json | empty | ws | ssl, `showConsole`); the `Scr*.dc.html` dialogs draw on top of it, and the
  `*Light.dc.html` files are the same screens with `dark` off.

These are Claude "Design" artboards: they render inside that canvas (they load its `support.js`
runtime), not as standalone pages. To view or edit, open the link above. If the artifact is ever lost,
ask Claude to create a new Design canvas and publish these files into it (`project/` as they are).

The running app has its own live gallery of the real screens: `pnpm dev`, then open `/?gallery`.

Keep this folder in step with the canvas: after changing the canvas, copy its `project/` files here.
