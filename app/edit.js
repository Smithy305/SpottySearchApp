/* SpottySearch — shared "Edit entry" dialog (Phase 7)
   Used by the Log page (tap one of today's pieces) and the Search page
   ("Edit details ✎" in a result's dialog).

   Usage:  SpottyEdit.open(sb, pieceId, (updatedPiece) => { ...refresh UI... })

   Saves through the update-piece edge function, which validates the fields,
   keeps the status who/when columns consistent and re-embeds the notes for
   search. Row-level security means workers can only edit their own shop's
   pieces. */
/* exported SpottyEdit */

"use strict";

const SpottyEdit = (() => {
  const BUCKET = "pottery-photos";
  let dlg = null;
  let current = null; // { sb, id, onSaved }

  // Build the dialog once, on first use (keeps both HTML pages in sync).
  function build() {
    dlg = document.createElement("dialog");
    dlg.id = "edit-dialog";
    dlg.innerHTML = `
      <form id="edit-form" method="dialog" novalidate>
        <h2 class="edit-title">Edit entry</h2>
        <img id="edit-photo" alt="Pottery being edited" />
        <p id="edit-logged" class="muted"></p>

        <label>Customer name
          <input type="text" id="edit-name" autocomplete="off" autocapitalize="words" maxlength="80" required />
        </label>

        <label>Number of items
          <input type="number" id="edit-count" inputmode="numeric" min="1" max="100" step="1" required />
        </label>

        <label>Notes <span class="optional">(optional — included in search)</span>
          <textarea id="edit-notes" rows="3" maxlength="500"
            placeholder="e.g. Birthday present for Nan — wants it wrapped. Two mugs + a coaster."></textarea>
          <span class="char-count" id="edit-notes-count"></span>
        </label>

        <label>Customer email <span class="optional">(optional — used for the "ready to collect" email)</span>
          <input type="email" id="edit-email" autocomplete="off" inputmode="email" maxlength="200" />
        </label>

        <label>Status
          <select id="edit-status">
            <option value="awaiting">Waiting for kiln</option>
            <option value="ready">Ready to collect</option>
            <option value="collected">Collected</option>
          </select>
        </label>

        <p id="edit-msg" class="error" role="alert"></p>
        <div class="dialog-btns">
          <button type="submit" class="btn btn-primary" id="edit-save">Save changes</button>
          <button type="button" class="btn" id="edit-cancel">Cancel</button>
        </div>
      </form>`;
    document.body.append(dlg);

    const notes = dlg.querySelector("#edit-notes");
    notes.addEventListener("input", () => {
      dlg.querySelector("#edit-notes-count").textContent = `${notes.value.length}/500`;
    });
    dlg.querySelector("#edit-cancel").addEventListener("click", () => dlg.close());
    dlg.querySelector("#edit-form").addEventListener("submit", (e) => {
      e.preventDefault();
      save();
    });
  }

  const el = (id) => dlg.querySelector("#" + id);

  async function open(sb, id, onSaved) {
    if (!dlg) build();
    current = { sb, id, onSaved };
    el("edit-form").reset();
    el("edit-msg").textContent = "";
    el("edit-photo").removeAttribute("src");
    el("edit-logged").textContent = "Loading…";
    el("edit-save").disabled = true;
    dlg.showModal();

    const { data: p, error } = await sb
      .from("pieces")
      .select("id, photo_path, customer_name, item_count, notes, contact_email, status, created_at, edited_at")
      .eq("id", id)
      .maybeSingle();
    if (error || !p) {
      el("edit-logged").textContent = "";
      el("edit-msg").textContent = "Couldn't load this entry — check your connection.";
      return;
    }

    el("edit-name").value = p.customer_name;
    el("edit-count").value = p.item_count;
    el("edit-notes").value = p.notes ?? "";
    el("edit-notes-count").textContent = `${(p.notes ?? "").length}/500`;
    el("edit-email").value = p.contact_email ?? "";
    el("edit-status").value = p.status;
    current.original = p;

    const fmt = (d) => new Date(d).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    el("edit-logged").textContent =
      `Logged ${fmt(p.created_at)}` + (p.edited_at ? ` · last edited ${fmt(p.edited_at)}` : "");
    el("edit-save").disabled = false;

    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrl(p.photo_path, 3600);
    if (signed?.signedUrl) el("edit-photo").src = signed.signedUrl;
  }

  async function save() {
    const name = el("edit-name").value.trim();
    const count = Number(el("edit-count").value);
    const email = el("edit-email").value.trim();
    const msg = el("edit-msg");

    if (!name) return (msg.textContent = "Customer name can't be empty.");
    if (!Number.isInteger(count) || count < 1 || count > 100) return (msg.textContent = "Number of items must be 1–100.");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return (msg.textContent = "That email doesn't look right.");

    const o = current.original;
    if (o.contact_email && !email &&
        !confirm("Remove this customer's email? They won't get the 'ready to collect' email.")) return;
    if (o.status === "collected" && el("edit-status").value !== "collected" &&
        !confirm("Mark this piece as NOT collected?")) return;

    el("edit-save").disabled = true;
    msg.textContent = "";

    const { data, error } = await current.sb.functions.invoke("update-piece", {
      body: {
        id: current.id,
        customer_name: name,
        item_count: count,
        notes: el("edit-notes").value,
        contact_email: email,
        status: el("edit-status").value,
      },
    });

    el("edit-save").disabled = false;
    if (error || !data?.piece) {
      // Validation errors come back as JSON { error } with a 4xx status.
      let text = "Couldn't save — check your connection and try again.";
      try { text = (await error.context.json()).error || text; } catch (_) {}
      msg.textContent = text;
      return;
    }
    dlg.close();
    current.onSaved?.(data.piece, o);
  }

  return { open };
})();
