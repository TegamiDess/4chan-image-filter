# Image Filter

A local image-matching server + browser userscript that detects and replaces unwanted images on 4chan using perceptual hashing (dHash) and style matching (CLIP).

---

## How It Works

1. **Server** runs locally, exposes an API on `http://127.0.0.1:5150`
2. **Userscript** sends each new thumbnail to the server for checking
3. Server compares against a **hash database** (dHash + BK-tree) and optionally against **style reference images** (CLIP cosine similarity)
4. If matched, the userscript swaps or removes the post and any replies to it
5. **Alt+Click** any thumbnail to add its hash to the ban list on the fly

### Privacy

The server binds to `127.0.0.1` only — nothing leaves your machine. The sole outbound network activity is a one-time ~600 MB CLIP model download from Hugging Face on first launch.

---

## Directory Structure

```
filter/
├── server.py
├── userscript.js
├── requirements.txt
└── data/
    ├── replacements/   ← images to swap in (png/jpg/gif/webp)
    ├── style/
    │   ├── CLIP1/      ← reference images for style category 1
    │   ├── CLIP2/      ← reference images for style category 2
    │   └── CLIP3/      ← reference images for style category 3
    └── hashes.json     ← auto-generated hash database

```

---

## Install

### 1. Python & Dependencies

**Requirements:** Python 3.9+

If Python isn't installed, grab it from [python.org/downloads](https://www.python.org/downloads/). On Windows, **check "Add Python to PATH"** during the installer.

Open a terminal:

- **Windows:** `Win+R` → type `cmd` → Enter
- **Mac:** Applications → Utilities → Terminal
- **Linux:** You know where it is

> **Tip:** Copy-paste each command rather than typing it. On Windows cmd, right-click to paste. On Mac, `Cmd+V`. On Linux terminals, `Ctrl+Shift+V`.

#### Install PyTorch first

The default `pip install torch` pulls ~2.5 GB of CPU-only binaries. If you have an NVIDIA GPU or Apple Silicon and want faster CLIP inference, install the appropriate build from [pytorch.org/get-started](https://pytorch.org/get-started/locally/) **before** the next step. CPU works fine — it's just slower on heavy threads.

#### Install everything else

```bash
pip install -r requirements.txt
```

Or manually:

```bash
pip install flask flask-cors pillow imagehash torch transformers pybktree waitress
```

### 2. Create the folder structure

**Windows:**

```cmd
mkdir filter
cd filter
mkdir data
mkdir data\replacements
mkdir data\style
```

**Mac / Linux:**

```bash
mkdir -p filter/data/{replacements,style}
cd filter
```

Place `server.py` and `userscript.js` inside `filter/`.

### 3. Add replacement images (optional)

Drop at least one image into `data/replacements/`. These are randomly served as swap-ins when a match is found.

If the folder is empty or missing, matched posts are **removed entirely** instead of swapped. This is intentional — leave it empty if you just want posts gone.

### 4. Add style references (optional)

Drop reference images into subfolders within data/style/. Each subfolder corresponds to a category defined in STYLE_CATEGORIES at the top of server.py, and each category has its own CLIP similarity threshold.

```
STYLE_CATEGORIES = {
    "category1": {"folder": "style/CLIP1", "threshold": 0.76},
    "category2": {"folder": "style/CLIP2", "threshold": 0.86},
    "category3": {"folder": "style/CLIP3", "threshold": 0.86},
}
```

Add or remove categories by editing this dictionary. Each entry needs a subfolder path (relative to data/) and a cosine similarity threshold. Higher = stricter.

"Style matching" here means "CLIP visual similarity to your reference images" — it is not a general aesthetic classifier. The quality of results depends entirely on what you put in each folder.

This is particularly effective against AI-generated images that mimic a specific artist's style. Drop a few examples of the artist's work into data/style/ and CLIP will flag visually similar outputs, even if they've never been posted before. Unlike hash matching, which only catches known images, style matching generalizes — one set of references can catch an unlimited number of new generations in that style.

### 5. Start the server

```bash
python server.py
```

First launch downloads the CLIP model (~600 MB) from Hugging Face. The download is cached (typically in `~/.cache/huggingface/`) and reused on subsequent launches. To clear it, delete that cache directory.

Verify it's running by visiting `http://127.0.0.1:5150/` — you should see a JSON status response. Press `Ctrl+C` in the terminal to stop.

### 6. Install the userscript

Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey), then:

1. Click the Tampermonkey icon → **"Create a new script..."**
2. Delete everything in the editor
3. Paste the entire contents of `userscript.js`
4. `Ctrl+S` to save

No configuration needed — it connects to `127.0.0.1:5150` by default.

---

## Usage

| Action | What happens |
|---|---|
| **Browse normally** | Every reply thumbnail is automatically checked against the hash DB and style DB. OP images are skipped. |
| **Alt+Click a thumbnail** | Adds its dHash to the ban list and swaps/removes the post immediately. |
| **Add images to `data/style/`** | POST to `/reload_hashes` (or restart the server) to pick up new CLIP references. |
| **Drop images in `data/`** | POST to `/reload_hashes` (or restart the server) to ingest new hashes. See warning below. |

> **⚠️ Destructive ingest:** Images placed **loose** in the top-level `data/` directory (not in a subfolder) are hashed, added to the database, **then permanently deleted**. Subfolders like `replacements/` and `style/` are never touched. Always **copy**, never move, originals here.

> **Thumbnail matching:** The hash database operates on **thumbnails**, not full-size images. Alt+Click captures the thumbnail automatically. If you're adding images manually by dropping them into `data/`, use the thumbnail version for the best accuracy. Full-size images produce different hashes and may not match.

### Performance notes

- **Hash check** (dHash + BK-tree lookup) is near-instant.
- **CLIP check** is the expensive step. On CPU it may add noticeable latency in fast-moving threads (~20 second **initial** start-up on a ~400 post thread). GPU (CUDA) or Apple Silicon (MPS) is detected automatically and speeds this up significantly.
- The userscript limits concurrent server requests with `MAX_CONCURRENT` (default `3`). Lower it if the server can't keep up; raise it on fast hardware.

---

## API Reference

All endpoints are served at `http://127.0.0.1:5150`.

### `GET /`

Status and counts.

```json
{
  "status": "running",
  "hashes": 142,
  "categories": {
    "category1": { "references": 5, "threshold": 0.76 },
    "category2": { "references": 3, "threshold": 0.86 },
    "category3": { "references": 2, "threshold": 0.86 }
  }
}
```

### `POST /check`

Check a thumbnail against the hash DB and style DB.

**Request:**

```json
{ "thumbnail_b64": "<base64 data URL or raw base64>" }
```

**Response (no match):**

```json
{ "swap": false }
```

**Response (hash match):**

```json
{ "swap": true, "method": "hash" }
```

**Response (style match):**

```json
{ "swap": true, "method": "style", "category": "category1", "similarity": 0.812 }
```

**Response (bad input):**

```json
{ "swap": false }
```

### `POST /save_thumbnail`

Add a thumbnail's dHash to the ban list.

**Request:**

```json
{ "thumbnail_b64": "<base64>" }
```

**Response:**

```json
{ "saved": "a1b2c3d4e5f6a7b8", "count": 143 }
```

**Error (500):**

```json
{ "error": "..." }
```

### `GET /random_image_base64`

Returns a random image from `data/replacements/` as a base64 data URL.

**Response:**

```json
{ "filename": "cat.png", "data": "data:image/png;base64,..." }
```

**Error (404) — folder is empty or missing:**

```json
{ "error": "No images found" }
```

### `POST /reload_hashes`

Reloads hashes from disk (including ingesting and deleting loose files in `data/`), then reloads CLIP style embeddings from `data/style/`.

**Response:**

```json
{ "count": 143, "categories": { "category1": 5, "category2": 3, "category3": 2 } }
```

---

## Tuning

These constants are at the top of `server.py`:

| Constant | Default | What it does |
|---|---|---|
| `THRESHOLD` | `10` | Max hamming distance for a dHash match. Lower = stricter. `5` catches near-exact duplicates only. `15` catches heavy recompression but risks false positives. |
| `STYLE_CATEGORIES` | `(see server.py)` | Dictionary of style categories. Each entry defines a folder of reference images and a threshold for CLIP cosine similarity. Higher threshold = stricter matching. |
| `HASH_SIZE` | `8` | dHash dimension (8 → 64-bit hashes). Increasing to `16` gives finer discrimination but needs a proportionally lower `THRESHOLD`. |

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `pip` or `python` not found | Python isn't on your PATH. Reinstall with "Add to PATH" checked, or try `python3` / `pip3`. |
| Port 5150 already in use | Another instance is running. Kill it, or change the port in both `server.py` and the `API` constant in the userscript. |
| CLIP model download stalls | Check your connection. Behind a proxy? Set `HTTP_PROXY` / `HTTPS_PROXY` env vars. The download is ~600 MB. |
| Userscript doesn't detect images | Confirm the server is up (`http://127.0.0.1:5150/` returns JSON). Open `F12` → Console and look for `[dHash]` errors. |
| Images that should match don't | Make sure you hashed the **thumbnail**, not the full-size image. Try raising `THRESHOLD` or lowering `STYLE_THRESHOLD`. |
| False positives | Lower `THRESHOLD` or raise `STYLE_THRESHOLD`. You can also delete individual entries from `hashes.json` manually. |
| `torch` install pulls 2+ GB / wrong platform | Install PyTorch separately from [pytorch.org/get-started](https://pytorch.org/get-started/locally/) before running `pip install -r requirements.txt`. |
