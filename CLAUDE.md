# Overview & Architecture

Slopsmith is a self-hosted web app for Rocksmith 2014 Custom DLC. It uses a **FastAPI** backend (`server.py`), plain **JavaScript/Tailwind** frontend (`static/`), and Python core libraries (`lib/`).

---

## Plugin System

Plugins reside in `plugins/<name>/` and require a `plugin.json` manifest. They can extend the frontend, backend, or settings.

### 1. Settings & Diagnostics Opt-ins

* **`settings.server_files`:** An allowlist of relative paths under `config_dir` included in user backups. Uses JSON format for `.json` files and Base64 for binaries.
* **`diagnostics`:** Provides troubleshooting data via `server_files` (copied verbatim) and `callable` (a `"module:func"` string returning data saved as JSON, text, or binary). Frontend scripts can contribute via `window.slopsmith.diagnostics.contribute()`. Payloads should be < 100 KB and exclude secrets.

### 2. Backend Routes & Sibling Imports

* `routes.py` must export a `setup(app, context)` function.
* **Crucial Rule:** Do not use bare imports for local plugin files (causes name collisions). Use `context["load_sibling"]("module_name")` to load modules safely within a unique namespace.

### 3. Frontend & Visualizations

Plugins interact with playback via wrappers around `window.playSong`. For visual extensions, choose the correct contract:

#### A. The `setRenderer` Contract (For customized note highways)

Used for plugins that replace the main highway drawing loop (`type: "visualization"`).

* **Factory:** Must export a factory function on `window.slopsmithViz_<id>` returning an object with `contextType` ('2d' or 'webgl2'), `init(canvas, bundle)`, `draw(bundle)`, and optional `resize`/`destroy` methods.
* **Canvas Swapping:** The framework automatically replaces the HTML `<canvas>` element if a newly selected renderer requires a different `contextType`. Use the `highway:canvas-replaced` event to re-register listeners if necessary.
* **Auto Mode:** Add a static `matchesArrangement(songInfo)` predicate to the factory so Slopsmith can automatically select the renderer based on song metadata.

#### B. The Overlay Contract (For layered add-ons)

Used for HUDs, chord labels, or fretboards that sit on top of the active renderer.

* **Rules:** Overlays must manage their own `<canvas>` and `requestAnimationFrame` loop, read public state every frame using `highway.getNotes()`, `getStringCount()`, etc., and respect lefty/inverted toggles.
* If using 2D positioning helpers (`project`/`fretX`), gate rendering with `highway.isDefaultRenderer()`.

#### C. Note-State Provider

Scoring plugins can inject per-note judgments into the active renderer using `highway.setNoteStateProvider((note, chartTime) => state)`. Return `'hit'`, `'active'`, or `'miss'` (or an object with `alpha` and `color`) to make the note gems and sustain trails light up dynamically.

### 4. Audio Mixer Integration

Plugins generating external audio (synths, guitar amps) can add a custom volume fader to the main player UI by calling `window.slopsmith.audio.registerFader({ id, label })`.
