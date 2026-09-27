const $ = (sel) => document.querySelector(sel);

const state = {
  user: null,
  authMode: "login",
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function showAuth(show) {
  $("#auth").hidden = !show;
  $("#chat").hidden = show;
  $("#menu-btn").hidden = show;
}

function renderMessages(messages) {
  const el = $("#messages");
  el.innerHTML = "";
  if (!messages.length) {
    el.innerHTML = `<div class="empty"><h2>Hello — how can I help?</h2><p>Reminders, memory, drafts that wait for your OK.</p></div>`;
    return;
  }
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = `bubble ${m.role}`;
    div.textContent = m.content;
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

function setProgress(text) {
  const p = $("#progress");
  if (!text) {
    p.hidden = true;
    p.textContent = "";
    return;
  }
  p.hidden = false;
  p.textContent = text;
}

async function refreshDrawer() {
  try {
    const [rem, mem, conn, pend] = await Promise.all([
      api("/api/reminders"),
      api("/api/memory"),
      api("/api/connectors"),
      api("/api/pending"),
    ]);
    $("#reminder-list").innerHTML = (rem.reminders || [])
      .map(
        (r) =>
          `<li><strong>${r.status}</strong> · ${escapeHtml(r.body)}<br/><small>${r.fire_at}</small></li>`,
      )
      .join("") || "<li>No reminders yet</li>";
    $("#memory-list").innerHTML = (mem.shelves || [])
      .map(
        (s) =>
          `<li><strong>${escapeHtml(s.shelf_key)}</strong><br/><small>${escapeHtml(
            (s.content || "").slice(0, 80),
          )}</small></li>`,
      )
      .join("");
    $("#connector-list").innerHTML = (conn.connectors || [])
      .map((c) => `<li>${escapeHtml(c.name)} — <em>${c.status}</em></li>`)
      .join("");
    $("#pending-list").innerHTML = (pend.pending || [])
      .map(
        (p) =>
          `<li>
            ${escapeHtml(p.summary)}
            <div class="confirm-actions">
              <button type="button" class="approve" data-id="${p.id}" data-decision="approve">Confirm</button>
              <button type="button" data-id="${p.id}" data-decision="reject">Cancel</button>
            </div>
          </li>`,
      )
      .join("") || "<li>Nothing waiting</li>";
  } catch {
    /* drawer optional while loading */
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function boot() {
  try {
    const me = await api("/api/me");
    state.user = me.user;
    $("#user-chip").textContent = me.user.display_name || me.user.email;
    showAuth(false);
    const { messages } = await api("/api/messages");
    renderMessages(messages);
    await refreshDrawer();
  } catch {
    showAuth(true);
  }
}

$("#auth-form").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-mode]");
  if (btn) state.authMode = btn.dataset.mode;
});

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    email: String(fd.get("email") || ""),
    password: String(fd.get("password") || ""),
    display_name: String(fd.get("display_name") || "") || undefined,
  };
  const err = $("#auth-error");
  err.hidden = true;
  try {
    const path =
      state.authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const data = await api(path, { method: "POST", body: JSON.stringify(payload) });
    state.user = data.user;
    $("#user-chip").textContent = data.user.display_name || data.user.email;
    showAuth(false);
    renderMessages([]);
    await refreshDrawer();
  } catch (ex) {
    err.hidden = false;
    err.textContent = ex.message;
  }
});

$("#composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#composer-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  const msgs = $("#messages");
  if (msgs.querySelector(".empty")) msgs.innerHTML = "";
  const userBubble = document.createElement("div");
  userBubble.className = "bubble user";
  userBubble.textContent = text;
  msgs.appendChild(userBubble);
  msgs.scrollTop = msgs.scrollHeight;
  setProgress("Thinking…");
  $("#send-btn").disabled = true;

  try {
    // Prefer HTTP turn (works everywhere); WS available at /api/chat/ws for streaming.
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    for (const ev of result.events || []) {
      if (ev.type === "progress" && ev.text) setProgress(ev.text);
    }
    setProgress("");
    const a = document.createElement("div");
    a.className = "bubble assistant";
    a.textContent = result.reply;
    msgs.appendChild(a);
    if ((result.events || []).some((ev) => ev.pendingActionId)) {
      const card = document.createElement("div");
      card.className = "confirm-card";
      card.innerHTML = `<strong>Needs your OK</strong><p>An external action is waiting in the drawer.</p>`;
      msgs.appendChild(card);
    }
    msgs.scrollTop = msgs.scrollHeight;
    await refreshDrawer();
  } catch (ex) {
    setProgress("");
    const a = document.createElement("div");
    a.className = "bubble assistant";
    a.textContent = `Something went wrong: ${ex.message}`;
    msgs.appendChild(a);
  } finally {
    $("#send-btn").disabled = false;
    input.focus();
  }
});

$("#menu-btn").addEventListener("click", () => {
  $("#drawer").hidden = false;
  refreshDrawer();
});
$("#drawer-close").addEventListener("click", () => {
  $("#drawer").hidden = true;
});

$("#pending-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-id]");
  if (!btn) return;
  await api(`/api/pending/${btn.dataset.id}/resolve`, {
    method: "POST",
    body: JSON.stringify({ decision: btn.dataset.decision }),
  });
  const { messages } = await api("/api/messages");
  renderMessages(messages);
  await refreshDrawer();
});

$("#logout-btn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST", body: "{}" });
  state.user = null;
  showAuth(true);
  $("#drawer").hidden = true;
});

$("#radar-btn").addEventListener("click", async () => {
  const data = await api("/api/radar/lite");
  const msgs = $("#messages");
  const a = document.createElement("div");
  a.className = "bubble assistant";
  a.textContent = data.speak
    ? data.digest
    : "(Radar-lite is quiet — nothing needs you right now.)";
  msgs.appendChild(a);
  msgs.scrollTop = msgs.scrollHeight;
});

boot();
