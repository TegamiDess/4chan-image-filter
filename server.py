import os
import random
import base64
import io
import json
import threading
import imagehash
import torch
from PIL import Image
from flask import Flask, jsonify, request
from flask_cors import CORS
from transformers import CLIPProcessor, CLIPModel
from pybktree import BKTree

BASE_FOLDER = os.path.dirname(os.path.abspath(__file__))
DATA_FOLDER = os.path.join(BASE_FOLDER, "data")
REPLACEMENT_FOLDER = os.path.join(DATA_FOLDER, "replacements")
STYLE_FOLDER = os.path.join(DATA_FOLDER, "style")
HASH_EXPORT_PATH = os.path.join(DATA_FOLDER, "hashes.json")
HASH_SIZE = 8
THRESHOLD = 10
VALID_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.webp'}
MIME_MAP = {'.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.gif': 'gif', '.webp': 'webp'}

STYLE_CATEGORIES = {
    "category1":       {"folder": "style/CLIP1",       "threshold": 0.76},
    "category2": {"folder": "style/CLIP2",  "threshold": 0.86},
    "category3":  {"folder": "style/CLIP3",   "threshold": 0.86},
}

app = Flask(__name__)
CORS(app)

hash_lock = threading.Lock()
clip_lock = threading.Lock()

banned_hash_set = set()
banned_hash_list = []
bk_tree = None
style_data = {}

device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
print(f"[Init] Using device: {device.upper()}")

clip_model = CLIPModel.from_pretrained("openai/clip-vit-base-patch32").to(device)
clip_processor = CLIPProcessor.from_pretrained("openai/clip-vit-base-patch32")
clip_model.eval()


def hamming_distance(a, b):
    return imagehash.hex_to_hash(a) - imagehash.hex_to_hash(b)


def get_clip_embedding(img):
    inputs = clip_processor(images=img, return_tensors="pt", input_data_format="channels_last")
    inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.no_grad():
        outputs = clip_model.get_image_features(**inputs)
        emb = outputs if isinstance(outputs, torch.Tensor) else getattr(outputs, 'image_embeds', outputs.pooler_output)
    emb = emb / emb.norm(dim=-1, keepdim=True)
    return emb.cpu()


def clip_check(emb):
    for name, cat in style_data.items():
        sims = (emb @ cat["embeddings"].T).squeeze(0)
        max_sim = sims.max().item()
        if max_sim > cat["threshold"]:
            return True, name, max_sim
    return False, None, 0.0


def get_images(folder):
    if not os.path.exists(folder):
        return []
    return [os.path.join(folder, f) for f in os.listdir(folder) if os.path.splitext(f)[1].lower() in VALID_EXTENSIONS]


def save_hashes_to_json():
    with open(HASH_EXPORT_PATH, 'w') as f:
        json.dump({"hashes": banned_hash_list}, f)


def add_hash(h):
    with hash_lock:
        if h not in banned_hash_set:
            banned_hash_set.add(h)
            banned_hash_list.append(h)
            bk_tree.add(h)
            save_hashes_to_json()


def load_hashes():
    global banned_hash_set, banned_hash_list, bk_tree
    banned_hash_set = set()
    banned_hash_list = []

    if os.path.exists(HASH_EXPORT_PATH):
        try:
            with open(HASH_EXPORT_PATH, 'r') as f:
                content = f.read().strip()
                if content:
                    data = json.loads(content)
                    banned_hash_list = data.get('hashes', [])
                    banned_hash_set = set(banned_hash_list)
        except Exception as e:
            print(f"[Import] Failed to read hashes.json: {e}")

    new_count = 0
    top_level_images = [os.path.join(DATA_FOLDER, f) for f in os.listdir(DATA_FOLDER)
                        if os.path.isfile(os.path.join(DATA_FOLDER, f)) and os.path.splitext(f)[1].lower() in VALID_EXTENSIONS]

    for path in top_level_images:
        try:
            with Image.open(path) as img:
                h = str(imagehash.dhash(img, hash_size=HASH_SIZE))
                if h not in banned_hash_set:
                    banned_hash_set.add(h)
                    banned_hash_list.append(h)
                    new_count += 1
        except Exception as e:
            print(f"Error reading {path}: {e}")

    bk_tree = BKTree(hamming_distance, banned_hash_list)
    save_hashes_to_json()

    if new_count > 0:
        for path in top_level_images:
            try:
                os.remove(path)
            except Exception as e:
                print(f"Error deleting {path}: {e}")

    print(f"Loaded {len(banned_hash_list)} hashes ({new_count} new)")


def load_style_embeddings():
    global style_data
    style_data = {}
    for name, cfg in STYLE_CATEGORIES.items():
        folder = os.path.join(DATA_FOLDER, cfg["folder"])
        embs = []
        for path in get_images(folder):
            try:
                img = Image.open(path).convert("RGB")
                with clip_lock:
                    embs.append(get_clip_embedding(img))
                img.close()
            except Exception as e:
                print(f"[CLIP] Error loading {path}: {e}")
        if embs:
            style_data[name] = {
                "embeddings": torch.cat(embs, dim=0),
                "threshold": cfg["threshold"]
            }
        print(f"[CLIP] {name}: {len(embs)} references, threshold {cfg['threshold']}")


def decode_b64_image(data):
    if ',' in data:
        data = data.split(',', 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(data)))


@app.route('/check', methods=['POST'])
def check():
    thumb_b64 = request.json.get('thumbnail_b64', '')
    try:
        img = decode_b64_image(thumb_b64)
    except Exception:
        return jsonify({"swap": False})

    result = {"swap": False, "scores": {}}

    try:
        h = str(imagehash.dhash(img, hash_size=HASH_SIZE))
        with hash_lock:
            matches = bk_tree.find(h, THRESHOLD)
        if matches:
            print(f"[Hash] Match found: {h}")
            img.close()
            result["swap"] = True
            result["method"] = "hash"
            return jsonify(result)
    except Exception as e:
        print(f"[Hash] Error: {e}")

    try:
        rgb = img.convert("RGB")
        with clip_lock:
            emb = get_clip_embedding(rgb)
        for name, cat in style_data.items():
            sims = (emb @ cat["embeddings"].T).squeeze(0)
            max_sim = sims.max().item()
            result["scores"][name] = round(max_sim, 4)
            if not result["swap"] and max_sim > cat["threshold"]:
                result["swap"] = True
                result["method"] = "style"
                result["category"] = name
                result["similarity"] = max_sim
                print(f"[CLIP] {name} match, similarity: {max_sim:.3f}")
    except Exception as e:
        print(f"[CLIP] Error: {e}")

    img.close()
    return jsonify(result)


@app.route('/reload_hashes', methods=['POST'])
def reload_hashes():
    with hash_lock:
        load_hashes()
    with clip_lock:
        load_style_embeddings()
    return jsonify({
        "count": len(banned_hash_list),
        "categories": {name: len(cat["embeddings"]) for name, cat in style_data.items()}
    })


@app.route('/random_image_base64')
def random_image_base64():
    files = get_images(REPLACEMENT_FOLDER)
    if not files:
        return jsonify({"error": "No images found"}), 404
    path = random.choice(files)
    ext = os.path.splitext(path)[1].lower()
    mime = MIME_MAP.get(ext, ext.lstrip('.'))
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    return jsonify({"filename": os.path.basename(path), "data": f"data:image/{mime};base64,{b64}"})


@app.route('/')
def index():
    return jsonify({
        "status": "running",
        "hashes": len(banned_hash_list),
        "categories": {name: {"references": len(cat["embeddings"]), "threshold": cat["threshold"]} for name, cat in style_data.items()}
    })


@app.route('/save_thumbnail', methods=['POST'])
def save_thumbnail():
    thumb_b64 = request.json.get('thumbnail_b64', '')
    try:
        img = decode_b64_image(thumb_b64)
        h = str(imagehash.dhash(img, hash_size=HASH_SIZE))
        img.close()
        add_hash(h)
        return jsonify({"saved": h, "count": len(banned_hash_list)})
    except Exception as e:
        print(f"[Save] Failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/config', methods=['GET'])
def get_config():
    return jsonify({
        "scanning": True,
        "threshold": THRESHOLD,
        "categories": {
            name: cat["threshold"] for name, cat in style_data.items()
        }
    })


@app.route('/config', methods=['POST'])
def update_config():
    global THRESHOLD
    data = request.json
    if 'threshold' in data:
        THRESHOLD = int(data['threshold'])
        print(f"[Config] Hash threshold updated to {THRESHOLD}")
    for name, val in data.get('categories', {}).items():
        if name in style_data:
            style_data[name]["threshold"] = float(val)
            print(f"[Config] {name} threshold updated to {val}")
    return jsonify({"ok": True})



if __name__ == '__main__':
    load_hashes()
    load_style_embeddings()
    try:
        from waitress import serve
        print("[Server] Starting with Waitress on http://127.0.0.1:5150")
        serve(app, host='127.0.0.1', port=5150)
    except ImportError:
        print("[Server] Waitress not installed, falling back to Flask dev server")
        app.run(port=5150, threaded=True)