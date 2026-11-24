# Excalidraw Smooth Zoom

Changes mouse scroll wheel behaviour to smoothly zoom in & out of the canvas.
<br>Optionally; change the middle mouse grab n' drag behaviour to infinite dragging, by locking the mouse cursor.
<br>Additional support for Wacom Pen Tablets.

## Requirements

- [**Obsidian**](https://obsidian.md/) on desktop, Windows, macOS or Linux.
- The [**Excalidraw**](https://community.obsidian.md/plugins/obsidian-excalidraw-plugin) community plugin must be installed.

## Mouse Controls

| Input | What it does |
|---|---|
| **Wheel** (plain or Ctrl) | Eased exponential zoom at the cursor |
| **Middle Mouse Button click  n' drag** | 1:1 pan with a captive cursor, locked so it can't run off the canvas |
| **Middle Mouse Button click + left click + Drag up and down** | Drag up or down to zoom. |
| **Ctrl + Middle Mouse Button click + Drag up and down** | Drag up or down to zoom.  |

## Wacom Controls

| Input | What it does |
|---|---|
| **Pinch** (touch) | Eased exponential zoom at the fingers/cursor |
| **Ctrl + pen tip** drag | Drag up or down for exponential zoom at the pen. The tip doesn't draw while Ctrl is held |
| **Ctrl + side button** drag | Same zoom, without touching the tip down |
| **Pen side button (Right-click Behaviour) Quickly, without moving the mouse** Opens the Edit menu (stroke, background, stroke width, pressure, opacity) next to the cursor |
| **Pen side button (Right-click Behaviour)**, drag | Pans the drawing |

The side button's click threshold (8 px by default) is in settings.

## Install

From Obsidian: **Settings → Community plugins → Browse**, search for **Excalidraw Smooth Zoom**, install it and enable it.

Manually: download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/excalidraw-smooth-zoom/`, reload Obsidian, then enable the plugin under **Settings → Community plugins**.

There's no build step: `main.js` is the source. After editing it, toggle the plugin off and on to reload it.

## Tuning

Every constant from the userscript is in the plugin's settings tab. Each slider has a number box beside it for typing an exact value (arrow keys in the box nudge it by one slider step) and a reset button.

Depending on your monitor's resolution & scaling; **Zoom speed** will probably need adjusting.
<br> For additional help; turn on **Log input events**, open the console (Ctrl+Shift+I) with its level filter set to include **Verbose**.


## License

[MIT](LICENSE) © 2026 Yeove