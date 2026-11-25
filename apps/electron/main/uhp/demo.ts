/**
 * Browser demo for the UHP server, served at GET /demo.
 *
 * Same-origin with the API, so no CORS changes are needed. The page is static;
 * API calls require the bearer key entered by the user. The key is kept in
 * sessionStorage only (never in the URL).
 *
 * Written as a String.raw template: inner JS deliberately avoids backticks and
 * ${...} interpolation so this stays a single bundled string.
 */
export const UHP_DEMO_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>UHP Demo</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f5f2;
    --panel: #fff;
    --text: #1f2328;
    --muted: #6b7280;
    --border: #d8d5ce;
    --accent: #2f6fed;
    --accent-weak: #e8f0ff;
    --danger: #b42318;
    --ok: #067647;
    --code: #f2f0eb;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14161a;
      --panel: #1b1e24;
      --text: #e7e9ee;
      --muted: #9aa1ad;
      --border: #303640;
      --accent: #7aa2ff;
      --accent-weak: #1f2b45;
      --danger: #ff8a80;
      --ok: #7ee2b8;
      --code: #22262d;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    padding: 18px 22px 12px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: baseline;
    gap: 12px;
    flex-wrap: wrap;
  }
  h1 { font-size: 18px; margin: 0; letter-spacing: -0.01em; }
  header p { margin: 0; color: var(--muted); font-size: 13px; }
  main {
    display: grid;
    grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
    gap: 16px;
    padding: 16px 22px 28px;
    align-items: start;
  }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
  }
  .panel + .panel { margin-top: 14px; }
  h2 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
  label { display: block; font-size: 12px; color: var(--muted); margin: 8px 0 4px; }
  input, select, textarea {
    width: 100%;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 9px;
    font: inherit;
    outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-weak); }
  textarea { resize: vertical; min-height: 96px; font-family: inherit; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .row3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .checks { display: flex; gap: 14px; flex-wrap: wrap; margin: 10px 0 2px; }
  .checks label { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--text); font-size: 13px; }
  .checks input { width: auto; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  button {
    border: 1px solid var(--border);
    background: var(--panel);
    color: var(--text);
    border-radius: 8px;
    padding: 7px 12px;
    font: inherit;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.danger { color: var(--danger); border-color: var(--danger); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .status { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--muted); min-height: 22px; }
  .chip { border: 1px solid var(--border); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
  .chip.ok { color: var(--ok); border-color: var(--ok); }
  .chip.err { color: var(--danger); border-color: var(--danger); }
  .error { color: var(--danger); font-size: 13px; white-space: pre-wrap; margin-top: 8px; }
  .output {
    min-height: 140px;
    background: var(--code);
    border-radius: 8px;
    padding: 10px;
    white-space: pre-wrap;
    word-break: break-word;
    font: 13px/1.6 var(--mono);
  }
  .log {
    height: 260px;
    overflow: auto;
    background: var(--code);
    border-radius: 8px;
    padding: 8px 10px;
    font: 12px/1.5 var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .log .t { color: var(--muted); }
  .sessions { display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow: auto; }
  .session {
    display: flex; align-items: center; gap: 6px;
    border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;
  }
  .session .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session button { padding: 3px 7px; font-size: 12px; }
  .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
  .fileline { display: flex; gap: 8px; align-items: center; margin-top: 8px; font-size: 12px; color: var(--muted); }
  .fileline code { font-family: var(--mono); color: var(--text); }
  a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>UHP Demo</h1>
  <p>Unified Harness Protocol · 2026-10-19 · 同源调用 <code>/v1</code></p>
</header>
<main>
  <div>
    <section class="panel">
      <h2>连接</h2>
      <label for="key">API Key（只存 sessionStorage）</label>
      <input id="key" type="password" autocomplete="off" placeholder="Settings → UHP → API Key" />
      <div class="row">
        <div>
          <label for="harness">Harness</label>
          <select id="harness"><option value="">加载中…</option></select>
        </div>
        <div>
          <label for="model">Model（canonical）</label>
          <input id="model" list="model-list" placeholder="provider/modelId" />
          <datalist id="model-list"></datalist>
        </div>
      </div>
      <div class="actions">
        <button id="discover">Discover</button>
        <button id="refresh">刷新 Harness / Model</button>
      </div>
      <div id="status" class="status"></div>
      <div id="error" class="error" role="alert"></div>
    </section>

    <section class="panel">
      <h2>任务</h2>
      <label for="prompt">输入</label>
      <textarea id="prompt">Reply with exactly: pong</textarea>
      <label for="prev">previous_response_id（留空 = 新会话）</label>
      <input id="prev" placeholder="resp_..." />
      <div class="checks">
        <label><input id="stream" type="checkbox" checked /> stream</label>
        <label><input id="background" type="checkbox" /> background</label>
        <label><input id="attach" type="checkbox" /> 附加已上传文件</label>
      </div>
      <div class="row3">
        <div>
          <label for="timeout">timeout_seconds</label>
          <input id="timeout" inputmode="numeric" placeholder="可选" />
        </div>
        <div>
          <label for="maxsteps">max_step</label>
          <input id="maxsteps" inputmode="numeric" placeholder="可选" />
        </div>
        <div>
          <label for="maxtokens">max_output_tokens</label>
          <input id="maxtokens" inputmode="numeric" placeholder="可选" />
        </div>
      </div>
      <div class="row">
        <div>
          <label for="file">上传文件（POST /v1/files）</label>
          <input id="file" type="file" />
        </div>
        <div>
          <label>&nbsp;</label>
          <div class="fileline" id="fileline">未上传</div>
        </div>
      </div>
      <div class="actions">
        <button id="send" class="primary">发送</button>
        <button id="cancel" class="danger" disabled>取消当前响应</button>
        <button id="clear">清空输出</button>
      </div>
      <div class="hint">发送成功后会自动把 response id 填入 previous_response_id；清空即可开新会话。</div>
    </section>
  </div>

  <div>
    <section class="panel">
      <h2>输出</h2>
      <div id="output" class="output"></div>
    </section>
    <section class="panel">
      <h2>事件流 / 响应 JSON</h2>
      <div id="log" class="log"></div>
    </section>
    <section class="panel">
      <h2>会话</h2>
      <div class="actions" style="margin-top:0">
        <button id="sessions">加载 /v1/sessions</button>
      </div>
      <div id="session-list" class="sessions" style="margin-top:10px"></div>
    </section>
  </div>
</main>
<script>
(function () {
  "use strict";

  var VERSION = "2026-10-19";
  var $ = function (id) { return document.getElementById(id); };
  var state = { responseId: null, fileId: null, busy: false, text: "", thinking: "" };

  var keyInput = $("key");
  keyInput.value = sessionStorage.getItem("uhp.demo.key") || "";
  keyInput.addEventListener("change", function () {
    sessionStorage.setItem("uhp.demo.key", keyInput.value.trim());
    refresh();
  });

  function base() {
    return location.protocol === "http:" || location.protocol === "https:"
      ? location.origin
      : "http://127.0.0.1:8788";
  }
  function headers(extra, noAuth) {
    var h = { "UHP-Version": VERSION };
    if (!noAuth && keyInput.value.trim()) h.Authorization = "Bearer " + keyInput.value.trim();
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function setError(text) {
    $("error").textContent = text || "";
  }
  function setStatus(text, tone) {
    var el = $("status");
    el.innerHTML = "";
    if (!text) return;
    var chip = document.createElement("span");
    chip.className = "chip" + (tone ? " " + tone : "");
    chip.textContent = text;
    el.appendChild(chip);
  }
  function log(text) {
    var el = $("log");
    var line = document.createElement("div");
    var time = new Date().toLocaleTimeString();
    var t = document.createElement("span");
    t.className = "t";
    t.textContent = "[" + time + "] ";
    line.appendChild(t);
    line.appendChild(document.createTextNode(text));
    el.appendChild(line);
    while (el.childNodes.length > 300) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }
  function setOutput(text) {
    $("output").textContent = text || "";
  }
  function pretty(value) {
    try { return JSON.stringify(value, null, 2); } catch (e) { return String(value); }
  }

  async function api(path, options) {
    var opts = options || {};
    var res = await fetch(base() + path, {
      method: opts.method || "GET",
      headers: headers(opts.headers, opts.noAuth),
      body: opts.body
    });
    if (!res.ok) {
      var body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      var msg = body && body.error && body.error.message
        ? body.error.message + " (" + body.error.code + ")"
        : "HTTP " + res.status;
      throw new Error(msg);
    }
    if (opts.raw) return res;
    return await res.json();
  }

  async function discover() {
    setError("");
    try {
      var d = await api("/v1/uhp", { noAuth: true });
      var caps = d.capabilities || {};
      var on = Object.keys(caps).filter(function (k) { return caps[k]; });
      setStatus(d.conformance_class + " · " + d.default_version + " · " + on.length + " capabilities", "ok");
      log("discovery: " + pretty(d));
    } catch (e) {
      setStatus("discovery failed", "err");
      setError(String(e.message || e));
    }
  }

  async function loadHarnesses() {
    setError("");
    try {
      var body = await api("/v1/harnesses");
      var list = Array.isArray(body.data) ? body.data : [];
      var select = $("harness");
      select.innerHTML = "";
      if (!list.length) {
        select.innerHTML = '<option value="">无 harness</option>';
        return;
      }
      list.forEach(function (h, i) {
        var opt = document.createElement("option");
        opt.value = h.id;
        opt.textContent = (h.name || h.id) + " · " + h.base + (h.defaultModel ? " · " + h.defaultModel : "");
        select.appendChild(opt);
        if (i === 0 && h.defaultModel) $("model").value = h.defaultModel;
      });
      await loadModels();
    } catch (e) {
      setError(String(e.message || e));
      setStatus("harness load failed", "err");
    }
  }

  async function loadModels() {
    var harness = $("harness").value;
    if (!harness) return;
    try {
      var body = await api("/v1/harnesses/" + encodeURIComponent(harness) + "/models");
      var list = Array.isArray(body.models) ? body.models : [];
      var datalist = $("model-list");
      datalist.innerHTML = "";
      list.forEach(function (m) {
        var opt = document.createElement("option");
        opt.value = m.id;
        if (m.label) opt.label = m.label;
        datalist.appendChild(opt);
      });
      if (! $("model").value && body.default) $("model").value = body.default;
      log("models: " + list.length + " available");
    } catch (e) {
      log("models failed: " + String(e.message || e));
    }
  }

  function buildInput() {
    var text = $("prompt").value;
    if ($("attach").checked && state.fileId) {
      return [{ role: "user", content: [
        { type: "input_text", text: text },
        { type: "input_file", file_id: state.fileId }
      ] }];
    }
    return text;
  }

  async function uploadFile() {
    var file = $("file").files && $("file").files[0];
    if (!file) { setError("请选择文件"); return; }
    setError("");
    var form = new FormData();
    form.append("file", file, file.name);
    try {
      var res = await fetch(base() + "/v1/files", {
        method: "POST",
        headers: headers(),
        body: form
      });
      var body = await res.json().catch(function () { return null; });
      if (!res.ok) {
        throw new Error(body && body.error ? body.error.message : "HTTP " + res.status);
      }
      state.fileId = body.id;
      $("fileline").textContent =
        "已上传 " + body.id + " · " + body.filename + " · " + body.bytes + " bytes";
      $("attach").checked = true;
      log("uploaded file: " + pretty(body));
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  function handleEvent(ev) {
    var seq = typeof ev.sequence_number === "number" ? ev.sequence_number : "?";
    var type = ev.type || "?";
    log(seq + " " + type + (ev.delta ? " " + JSON.stringify(ev.delta) : ""));
    if (type === "response.created") {
      state.responseId = ev.response.id;
      $("cancel").disabled = false;
      setStatus("in_progress · " + state.responseId, "");
    } else if (type === "response.output_text.delta") {
      state.text += ev.delta || "";
      setOutput(state.text);
    } else if (type === "response.output_text.done") {
      state.text = ev.text || state.text;
      setOutput(state.text);
    } else if (type === "response.reasoning_summary_text.delta") {
      state.thinking += ev.delta || "";
    } else if (type === "response.output_item.added") {
      var item = ev.item || {};
      if (item.type === "function_call") log("tool call: " + (item.name || "?") + " " + (item.arguments || ""));
    } else if (type === "response.output_item.done") {
      var done = ev.item || {};
      if (done.type === "function_call_output") log("tool output: " + (done.output || ""));
    } else if (type === "error") {
      setError(ev.message || ev.code || "stream error");
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      state.busy = false;
      $("send").disabled = false;
      $("cancel").disabled = true;
      var resp = ev.response || {};
      $("prev").value = resp.id || state.responseId || "";
      setStatus((resp.status || "terminal") + " · " + (resp.id || ""), resp.status === "completed" ? "ok" : "err");
      setOutput(state.text || renderText(resp));
      log("terminal: " + pretty(resp));
    }
  }

  function renderText(resp) {
    var out = [];
    (resp.output || []).forEach(function (item) {
      if (item.type !== "message") return;
      (item.content || []).forEach(function (part) {
        if (part.type === "output_text" && part.text) out.push(part.text);
      });
    });
    return out.join("\\n");
  }

  function consumeSse(buffer, onEvent) {
    buffer = buffer.replace(/\\r\\n/g, "\\n");
    var idx;
    while ((idx = buffer.indexOf("\\n\\n")) !== -1) {
      var block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      var data = block.split("\\n").filter(function (line) {
        return line.indexOf("data: ") === 0;
      }).map(function (line) {
        return line.slice(6);
      }).join("\\n");
      if (!data) continue;
      try { onEvent(JSON.parse(data)); } catch (e) { log("bad event JSON: " + String(e)); }
    }
    return buffer;
  }

  async function send() {
    if (state.busy) return;
    state.busy = true;
    state.text = "";
    state.thinking = "";
    setOutput("");
    setError("");
    $("send").disabled = true;
    $("cancel").disabled = true;
    $("log").innerHTML = "";

    var harness = $("harness").value;
    var body = {
      input: buildInput(),
      stream: $("stream").checked,
      metadata: {}
    };
    if (harness) body.metadata.harness_id = harness;
    var model = $("model").value.trim();
    if (model) body.model = model;
    var prev = $("prev").value.trim();
    if (prev) body.previous_response_id = prev;
    if ($("background").checked) body.background = true;
    var timeout = $("timeout").value.trim();
    if (timeout) body.timeout_seconds = Number(timeout);
    var maxSteps = $("maxsteps").value.trim();
    if (maxSteps) body.max_step = Number(maxSteps);
    var maxTokens = $("maxtokens").value.trim();
    if (maxTokens) body.max_output_tokens = Number(maxTokens);

    try {
      if ($("stream").checked && !body.background) {
        var res = await fetch(base() + "/v1/responses", {
          method: "POST",
          headers: headers({ "Content-Type": "application/json", Accept: "text/event-stream" }),
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          var errBody = await res.json().catch(function () { return null; });
          throw new Error(errBody && errBody.error ? errBody.error.message : "HTTP " + res.status);
        }
        if (!res.body) throw new Error("no response body");
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        while (true) {
          var chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          buffer = consumeSse(buffer, handleEvent);
        }
        buffer += decoder.decode();
        consumeSse(buffer + "\\n\\n", handleEvent);
        state.busy = false;
        $("send").disabled = false;
        $("cancel").disabled = true;
      } else {
        var json = await api("/v1/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        state.responseId = json.id;
        setStatus((json.status || "") + " · " + json.id, json.status === "completed" ? "ok" : "err");
        setOutput(renderText(json));
        $("prev").value = json.id || "";
        log("response: " + pretty(json));
        if (json.background === true || json.status === "in_progress") {
          $("cancel").disabled = false;
        }
        state.busy = false;
        $("send").disabled = false;
      }
    } catch (e) {
      state.busy = false;
      $("send").disabled = false;
      setStatus("request failed", "err");
      setError(String(e.message || e));
    }
  }

  async function cancel() {
    if (!state.responseId) return;
    setError("");
    try {
      var body = await api("/v1/responses/" + encodeURIComponent(state.responseId) + "/cancel", {
        method: "POST"
      });
      setStatus((body.status || "cancelled") + " · " + state.responseId, "err");
      log("cancel: " + pretty(body));
      $("cancel").disabled = true;
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  async function loadSessions() {
    setError("");
    try {
      var body = await api("/v1/sessions?limit=20");
      var list = Array.isArray(body.data) ? body.data : [];
      var el = $("session-list");
      el.innerHTML = "";
      if (!list.length) {
        el.textContent = "暂无 UHP 会话";
        return;
      }
      list.forEach(function (s) {
        var row = document.createElement("div");
        row.className = "session";
        var title = document.createElement("span");
        title.className = "title";
        title.textContent = (s.title || "(untitled)") + " · " + s.id;
        title.title = s.id;
        var turns = document.createElement("button");
        turns.textContent = "Turns";
        turns.onclick = function () { return loadTurns(s.id); };
        var files = document.createElement("button");
        files.textContent = "Files";
        files.onclick = function () { return loadFiles(s.id); };
        row.appendChild(title);
        row.appendChild(turns);
        row.appendChild(files);
        el.appendChild(row);
      });
    } catch (e) {
      setError(String(e.message || e));
    }
  }

  async function loadTurns(id) {
    try {
      var body = await api("/v1/sessions/" + encodeURIComponent(id) + "/turns");
      log("turns: " + pretty(body));
    } catch (e) { setError(String(e.message || e)); }
  }
  async function loadFiles(id) {
    try {
      var body = await api("/v1/sessions/" + encodeURIComponent(id) + "/files");
      log("files: " + pretty(body));
    } catch (e) { setError(String(e.message || e)); }
  }

  async function refresh() {
    setError("");
    await loadHarnesses();
  }

  $("discover").onclick = discover;
  $("refresh").onclick = refresh;
  $("send").onclick = send;
  $("cancel").onclick = cancel;
  $("sessions").onclick = loadSessions;
  $("clear").onclick = function () {
    state.text = "";
    state.thinking = "";
    setOutput("");
    $("log").innerHTML = "";
    setStatus("", "");
    setError("");
  };
  $("file").onchange = uploadFile;
  $("harness").onchange = loadModels;

  discover();
  if (keyInput.value.trim()) refresh();
  log("ready. 打开本页请使用 http://127.0.0.1:8788/demo");
})();
</script>
</body>
</html>`;
