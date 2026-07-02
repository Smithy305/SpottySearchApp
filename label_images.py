"""
Spotty Pots image labeller.
 
Shows each photo with a text box, saves your description, and moves on.
Run it from your project folder:  python label_images.py
 
- Descriptions are saved to labels.json (keyed by filename) after every action,
  so closing the window or a crash never loses your work.
- It starts at the first unlabelled image, so you can stop and resume any time.
- Re-opening an already-labelled image shows the existing text so you can edit it.
"""
 
import os
import json
import tkinter as tk
from PIL import Image, ImageTk
 
# --- config ---
IMG_DIR = "Data"      # folder of photos (use an absolute path if needed)
LABELS_FILE = "labels.json"       # where descriptions are saved
MAX_SIZE = (520, 520)             # max display size for the image
 
# --- load image list and any existing labels ---
image_files = sorted(
    f for f in os.listdir(IMG_DIR) if f.lower().endswith((".jpg", ".jpeg", ".png"))
)
if not image_files:
    raise SystemExit(f"No images found in {IMG_DIR!r}")
 
labels = {}
if os.path.exists(LABELS_FILE):
    with open(LABELS_FILE) as f:
        labels = json.load(f)
 
# start at the first image without a label
state = {"i": next((k for k, f in enumerate(image_files) if f not in labels), 0)}
 
 
def save_labels():
    with open(LABELS_FILE, "w") as f:
        json.dump(labels, f, indent=2)
 
 
def load_image(idx):
    """Display image idx and pre-fill its existing description, if any."""
    file = image_files[idx]
    img = Image.open(os.path.join(IMG_DIR, file))
    img.thumbnail(MAX_SIZE)
    photo = ImageTk.PhotoImage(img)
    image_label.config(image=photo)
    image_label.image = photo                 # keep a reference so it isn't garbage collected
    status.config(text=f"{idx + 1} / {len(image_files)}    |    {file}")
    text.delete("1.0", "end")
    text.insert("1.0", labels.get(file, ""))
    text.focus_set()
 
 
def store_current():
    file = image_files[state["i"]]
    desc = text.get("1.0", "end-1c").strip()
    if desc:
        labels[file] = desc
    elif file in labels:
        del labels[file]                      # clearing the box removes the label
    save_labels()
 
 
def go(delta, save=True):
    if save:
        store_current()
    new = state["i"] + delta
    if 0 <= new < len(image_files):
        state["i"] = new
        load_image(new)
    elif new >= len(image_files):
        store_current()
        status.config(text=f"All {len(image_files)} images done. Saved to {LABELS_FILE}.")
        text.delete("1.0", "end")
 
 
# --- build the window ---
root = tk.Tk()
root.title("Spotty Pots labeller")
 
image_label = tk.Label(root)
image_label.pack(padx=12, pady=12)
 
status = tk.Label(root, font=("Helvetica", 12, "bold"))
status.pack()
 
text = tk.Text(root, height=5, width=60, wrap="word", font=("Helvetica", 12))
text.pack(padx=12, pady=8)
 
row = tk.Frame(root)
row.pack(pady=(0, 12))
tk.Button(row, text="\u2190 Prev", width=10, command=lambda: go(-1)).pack(side="left", padx=4)
tk.Button(row, text="Skip \u2192", width=10, command=lambda: go(1, save=False)).pack(side="left", padx=4)
tk.Button(row, text="Save & Next", width=14, command=lambda: go(1)).pack(side="left", padx=4)
 
root.bind("<Control-Return>", lambda e: go(1))   # keyboard shortcut for save + next
 
load_image(state["i"])
root.mainloop()
 