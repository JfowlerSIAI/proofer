// Proofer's setup page (see ARCHITECTURE.md#setup-and-the-speed-check).
// One state is shown at a time,
// and every state is rebuilt from what is verifiably true -- Ollama answering,
// the engine installed under the pinned digest, a stored speed check -- never
// from what an earlier visit of this tab remembered.
//
// What this page does itself, and why:
//   - It consumes the worker's service/engine observations and OWNS the
//     download (POST /api/pull, streamed): a worker can be stopped mid-stream,
//     a visible tab is not.
//   - Everything that decides whether Proofer may write is the worker's:
//     checking the download (SETUP_VERIFY), the speed check (SETUP_BEGIN /
//     SETUP_STEP, run by the worker on fixtures it owns -- this page sends
//     ids, never text, models, options or URLs), the stored result, and Turn
//     on (SET_SENTENCE_MODE, which the worker refuses without a passing speed
//     check).
//
// "No click that only says continue": the page polls for Ollama every ~2 s
// while it is visible and checks at once when it becomes visible again, the
// download starts as soon as Ollama is found, and the speed check follows the
// download. Buttons exist for real choices (Pause, Resume, Turn on) and on
// failure screens.

"use strict";

const POLL_MS = 2000;
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message, messaging: true } : response);
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message), messaging: true });
    }
  });
}

// --- Showing one state ------------------------------------------------------

let current = null;
function show(state) {
  current = state;
  for (const el of document.querySelectorAll("section[data-state]")) el.hidden = el.dataset.state !== state;
  const stepOf = {
    checking: "ollama", unsupported: "ollama", "install-needed": "ollama", "update-needed": "ollama",
    "not-ollama": "ollama", downloading: "download", paused: "download", interrupted: "download",
    verifying: "download", testing: "check", "too-slow": "check", unexpected: "check",
    operational: "check", ready: "on",
  }[state];
  const order = ["ollama", "download", "check", "on"];
  const at = order.indexOf(stepOf);
  for (const li of document.querySelectorAll("#steps li")) {
    const i = order.indexOf(li.dataset.step);
    li.className = i < at ? "done" : i === at ? "now" : "";
    li.firstElementChild.textContent = i < at ? "✓" : String(i + 1);
  }
  // Its own attribute, not data-state: the body stamped with data-state was
  // itself matched by a [data-state] selector, and hidden on the next change.
  document.body.dataset.screen = state;
}

// --- The computer ------------------------------------------------------------

// Which OS, and whether it is reliably too old. Browser platform data cannot
// tell every Windows 10 release apart, so an old-looking Windows 10 is
// "unknown", never refused.
async function platformInfo() {
  const uad = navigator.userAgentData;
  let platform = (uad && uad.platform) || "";
  let version = null;
  try {
    if (uad && uad.getHighEntropyValues) version = (await uad.getHighEntropyValues(["platformVersion"])).platformVersion || null;
  } catch {}
  if (!platform) {
    const ua = navigator.userAgent;
    platform = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  }
  const major = version ? parseInt(String(version).split(".")[0], 10) : NaN;
  let supported = "yes", why = "";
  if (platform === "Windows" && Number.isFinite(major)) {
    // UA-CH platformVersion: 0 is Windows 7/8/8.1, 1-10 is Windows 10, 13+ is 11.
    if (major === 0) { supported = "no"; why = "This computer runs a Windows version older than Windows 10."; }
    else if (major < 13) { supported = "unknown"; why = "Proofer can't tell whether this copy of Windows 10 is recent enough (version 22H2 or later). If Ollama's installer refuses to run, it isn't."; }
  } else if (platform === "macOS" && Number.isFinite(major) && major < 14) {
    supported = "no"; why = `This Mac runs macOS ${version}; Ollama needs macOS 14 or later.`;
  }
  return { platform, version, supported, why };
}

const OLLAMA_PAGES = {
  Windows: "https://ollama.com/download/windows",
  macOS: "https://ollama.com/download/mac",
  Linux: "https://ollama.com/download/linux",
};

function installCopy(platform) {
  const steps = platform === "macOS" ? [
    "Click Get Ollama and open the file it downloads.",
    "Drag Ollama into Applications, then open it from Applications once. Confirm the prompt saying it was downloaded from the internet.",
    "If Ollama offers to install its command-line tool, you can skip it: Proofer doesn't need it.",
    "Come back to this tab. It carries on by itself.",
  ] : platform === "Linux" ? [
    "Click Get Ollama and follow the instructions on Ollama's page.",
    "Come back to this tab. It carries on by itself.",
  ] : [
    "Click Get Ollama and run the installer it downloads.",
    "Ollama starts by itself when the installer finishes. If a window of its own opens, you can close it: Ollama keeps running in the background.",
    "Come back to this tab. It carries on by itself.",
  ];
  const ol = $("installSteps");
  ol.textContent = "";
  for (const s of steps) { const li = document.createElement("li"); li.textContent = s; ol.appendChild(li); }
  $("whereToOpen").textContent = platform === "macOS" ? "from Applications" : platform === "Windows" ? "from the Start menu" : "the way you usually start it";
}

// --- Ollama ------------------------------------------------------------------

let ollamaUrl = "http://localhost:11434";
let pinned = null;          // { tag, digest, sizeBytes } from SETUP_READY

// The worker's barrier before this page talks to Ollama: the URL and pin to
// use, once the Origin rule for that URL is installed and checked. Asked
// before refresh and again before the download's POST, so the
// page never races a rule being installed or one left on an earlier URL.
async function ready() {
  const r = await sendMessage({ type: "SETUP_READY" });
  if (!r || !r.ok) return false;
  ollamaUrl = String(r.ollamaUrl || ollamaUrl).replace(/\/+$/, "");
  pinned = r.pinnedModel || pinned;
  return r.ready === true;
}

// --- The download ------------------------------------------------------------

let pullAbort = null;
const PAUSED_KEY = "setupPaused";
const getPaused = () => new Promise((r) => chrome.storage.local.get({ [PAUSED_KEY]: false }, (o) => r(!!(o && o[PAUSED_KEY]))));
const setPaused = (v) => new Promise((r) => chrome.storage.local.set({ [PAUSED_KEY]: !!v }, () => r()));

const GB = (n) => (n / 1e9).toFixed(n >= 1e10 ? 0 : 1);

// Streams POST /api/pull. Resolves "success", "paused", or { error, kind }.
// NDJSON arrives in arbitrary chunks, so a line can be split across two reads.
async function pull() {
  pullAbort = new AbortController();
  const layers = new Map();
  if (!(await ready())) return { kind: "rule" };
  let res;
  try {
    res = await fetch(`${ollamaUrl}/api/pull`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: pinned.tag, stream: true }), signal: pullAbort.signal,
    });
  } catch (e) {
    return pullAbort.signal.aborted ? "paused" : { kind: "stopped" };
  }
  if (!res.ok || !res.body) return { kind: res.status === 404 ? "not-found" : "bad-stream", status: res.status };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let sawSuccess = false;
  const onLine = (line) => {
    if (!line.trim()) return null;
    let j;
    try { j = JSON.parse(line); } catch { return { kind: "bad-stream" }; }
    if (j.error) return { kind: classifyPullError(j.error) };
    if (j.digest && typeof j.total === "number") layers.set(j.digest, { total: j.total, completed: j.completed || 0 });
    if (j.status === "success") sawSuccess = true;
    let total = 0, done = 0;
    for (const l of layers.values()) { total += l.total; done += Math.min(l.completed, l.total); }
    const size = Math.max(total, pinned.sizeBytes || 0);
    if (size) {
      $("dlBar").style.width = `${Math.min(100, (100 * done) / size).toFixed(1)}%`;
      $("dlText").textContent = `${GB(done)} of ${GB(size)} GB`;
    }
    if (/verifying|writing/.test(j.status || "")) $("dlText").textContent = "Finishing…";
    return null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const bad = onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (bad) { pullAbort.abort(); return bad; }
      }
    }
    const bad = onLine(buf + dec.decode());
    if (bad) return bad;
  } catch {
    if (pullAbort.signal.aborted) return "paused";
    return { kind: "stopped" };
  }
  return sawSuccess ? "success" : { kind: "stopped" };
}

function classifyPullError(msg) {
  const m = String(msg || "").toLowerCase();
  if (/no space|disk full|not enough space/.test(m)) return "disk-full";
  if (/not found|does not exist|manifest unknown|pull model manifest/.test(m)) return "not-found";
  return "bad-stream";
}

const INTERRUPTED = {
  stopped: "The connection to Ollama was lost. If Ollama was closed, open it again.",
  "disk-full": "The disk is full. Free up about 2 GB and try again.",
  "not-found": "Ollama couldn't find the proofreading engine to download. Check the internet connection and try again.",
  "bad-stream": "Ollama sent something unexpected while downloading.",
  network: "The internet connection dropped while downloading.",
  rule: "Proofer couldn't prepare its connection to Ollama. Try again; if it keeps happening, restart the browser.",
};

async function runDownload() {
  if (busy) return;
  busy = true;
  show("downloading");
  $("dlText").textContent = "Starting…";
  $("dlBar").style.width = "0%";
  const r = await pull();
  busy = false;
  if (r === "paused") { show("paused"); return; }
  if (r === "success") { await verifyThenTest(); return; }
  // Tell a closed Ollama from a network failure: it is the one we can see.
  let kind = r.kind;
  if (kind === "stopped") {
    const status = await sendMessage({ type: "SETUP_STATUS" });
    if (status && status.ok && status.ollama.state === "ok") kind = "network";
  }
  $("interruptedWhy").textContent = INTERRUPTED[kind] || INTERRUPTED["bad-stream"];
  show("interrupted");
}

// --- Checking the download, and the speed check ------------------------------

let busy = false;

async function verifyThenTest() {
  busy = true;
  show("verifying");
  const v = await sendMessage({ type: "SETUP_VERIFY" });
  busy = false;
  if (!v || !v.ok || !v.verified) {
    $("interruptedWhy").textContent = v && v.reason === "digest"
      ? "The engine that arrived is not the one Proofer was tested with. Try the download again."
      : "The download couldn't be checked. Try again.";
    show("interrupted");
    return;
  }
  await runSpeedCheck();
}

async function runSpeedCheck() {
  if (busy) return;
  busy = true;
  show("testing");
  $("testBar").style.width = "0%";
  $("testText").textContent = "Starting…";
  const begin = await sendMessage({ type: "SETUP_BEGIN" });
  if (!begin || !begin.ok) { busy = false; operational(begin); return; }
  let result = null;
  for (let guard = 0; guard < 500; guard++) {
    const r = await sendMessage({ type: "SETUP_STEP", runId: begin.runId });
    if (!r || !r.ok) { busy = false; operational(r); return; }
    if (typeof r.progress === "number") $("testBar").style.width = `${Math.round(100 * r.progress)}%`;
    if (r.label) $("testText").textContent = r.label;
    if (r.done) { result = r.result; break; }
    // A deliberate pause inside the test (the engine's idle release). The
    // worker is pinged meanwhile so it stays awake.
    if (r.waitMs) {
      const until = Date.now() + r.waitMs;
      while (Date.now() < until) { await sleep(Math.min(5000, until - Date.now())); await sendMessage({ type: "SETUP_PING", runId: begin.runId }); }
    }
  }
  busy = false;
  if (!result) { operational({ error: "no-result" }); return; }
  await refresh();
}

const OPERATIONAL = {
  "run-lost": "The speed check was interrupted. Run it again.",
  "ollama-stopped": "Ollama stopped answering during the speed check. If it was closed, open it again.",
  "ollama-status": "Ollama answered, but Proofer couldn't read a usable status or response. Restart Ollama and try again.",
  "ollama-updated": "Ollama was updated during the speed check. Run it again.",
  "engine-missing": "The proofreading engine is missing or different. Run setup again to download it.",
  "config-changed": "Proofer's settings changed during the speed check. Run it again.",
};
let operationalReason = null;
function operational(r) {
  const why = (r && (r.reason || r.error)) || "";
  operationalReason = why;
  if (why === "ollama-version") { refresh(); return; }
  $("operationalWhy").textContent = OPERATIONAL[why] || "Something went wrong before the speed check could finish. Try again.";
  show("operational");
}

// --- Ready -------------------------------------------------------------------

let demoTimer = null;
// A correction landing, then Escape taking it back -- the two things a user
// needs to know before Turn on. A loop of
// text, not a live field: content scripts do not run on extension pages.
function playDemo() {
  const el = $("demo");
  if (demoTimer) return;
  const typed = "We recieved the invoice yesterday. ";
  let i = 0;
  const later = (fn, ms) => { demoTimer = setTimeout(fn, ms); };
  const step = () => {
    if (i <= typed.length) { el.textContent = typed.slice(0, i++); later(step, 45); return; }
    el.textContent = "";
    el.append("We ");
    const fixed = document.createElement("span");
    fixed.className = "fixed";
    fixed.textContent = "received";
    el.append(fixed, " the invoice yesterday. ");
    later(() => {
      fixed.classList.add("fade");
      const esc = document.createElement("span");
      esc.className = "kbd";
      esc.textContent = "Esc";
      later(() => {
        el.append(esc);
        later(() => {
          el.textContent = typed + "  ← taken back";
          later(() => { i = 0; step(); }, 2200);
        }, 900);
      }, 1100);
    }, 1400);
  };
  step();
}

async function showReady(settings) {
  show("ready");
  $("readyLead").textContent = "This computer passed the speed check.";
  // The check passed with the long-context sentence dropped: say what that
  // means in use (SETUP_CASE_MAX_MS in background.js). SETUP_STATUS carries it
  // as lastResult; Turn on answers with the settings, which hold the verdict.
  const verdict = settings && (settings.lastResult || settings.qualification);
  const dropped = verdict && (verdict.longDropped ?? (verdict.numbers && verdict.numbers.longDropped));
  $("longNote").hidden = !(dropped > 0);
  const consent = settings && settings.consent;
  const on = !!(consent && consent.activated);
  if (consent && consent.reason === "upgrading") {
    $("readyLead").textContent = "Settings are still being upgraded. Try Turn on again in a moment.";
  }
  $("turnOnActions").hidden = on;
  $("onNote").hidden = !on;
  $("readyTitle").textContent = on ? "Proofer is on" : "Ready";
  playDemo();
  try {
    const us = chrome.action && chrome.action.getUserSettings ? await chrome.action.getUserSettings() : null;
    $("pinBox").hidden = !us || us.isOnToolbar === true;
  } catch { $("pinBox").hidden = true; }
}

// --- Rebuilding the state ------------------------------------------------------

let platform = null;

async function refresh() {
  if (busy) return;
  // Not ready yet (the rule is still going in): look again on the next poll.
  if (!(await ready())) { if (pinned) show("checking"); else operational({ error: "no-settings" }); return; }
  const status = await sendMessage({ type: "SETUP_STATUS" });
  if (!status || !status.ok) { operational({ error: "no-status" }); return; }
  if (!pinned) { operational({ error: "no-settings" }); return; }

  const { ollama, engine } = status;
  if (ollama.state === "unreachable") {
    if (platform.supported === "no") { $("unsupportedWhy").textContent = platform.why; show("unsupported"); return; }
    $("osCompat").hidden = platform.supported !== "unknown";
    $("osCompat").textContent = platform.why;
    installCopy(platform.platform);
    show("install-needed");
    return;
  }
  if (ollama.state === "unusable") { show("not-ollama"); return; }
  if (!ollama.versionOk) {
    $("floorVersion").textContent = ollama.floor;
    $("haveVersion").textContent = ollama.version;
    show("update-needed");
    return;
  }
  if (engine.state === "unknown") { show("checking"); return; }
  if (engine.state === "missing" || engine.state === "mismatch") {
    if (await getPaused()) { show("paused"); return; }
    runDownload();
    return;
  }
  // Installed. What does the worker's stored speed check say? (SETUP_STATUS
  // has just compared it with the Ollama answering now.)
  const q = status;
  if (q && q.qualified) { await showReady(q); return; }
  // A verdict about this computer as it is now is shown, not re-run. An
  // interrupted or failed-to-run check is not a verdict: it runs again.
  const r = q && q.lastResult;
  if (r && !r.stale && r.pass === false && r.current && (r.category === "too-slow" || r.category === "unexpected")) {
    show(r.category);
    return;
  }
  // Never checked, or checked under something that has changed since (an
  // Ollama update, a new Proofer): the check runs by itself.
  await verifyThenTest();
}

// --- Buttons -------------------------------------------------------------------

function trusted(fn) { return (e) => { if (e.isTrusted) fn(e); }; }

function openOllamaPage() {
  const url = OLLAMA_PAGES[platform && platform.platform] || "https://ollama.com/download";
  chrome.tabs.create({ url });
}
$("getOllama").addEventListener("click", trusted(openOllamaPage));
$("getOllamaUpdate").addEventListener("click", trusted(openOllamaPage));
$("pauseBtn").addEventListener("click", trusted(async () => {
  await setPaused(true);
  if (pullAbort) pullAbort.abort();
}));
$("resumeBtn").addEventListener("click", trusted(async () => { await setPaused(false); runDownload(); }));
$("retryDownload").addEventListener("click", trusted(() => { busy = false; refresh(); }));
// On Ready too: a laptop's first check may have been plugged in, and the
// acceptance test repeats it on battery. A retest replaces the stored verdict
// with its own result, whatever it is.
for (const id of ["retestSlow", "retestOdd", "retestReady"]) $(id).addEventListener("click", trusted(() => runSpeedCheck()));
$("retestOps").addEventListener("click", trusted(() => operationalReason === "engine-missing" ? refresh() : runSpeedCheck()));
$("turnOn").addEventListener("click", trusted(async () => {
  const r = await sendMessage({ type: "SET_SENTENCE_MODE", on: true });
  if (r && r.ok) { await showReady({ ...r.settings, consent: r.consent }); return; }
  $("readyLead").textContent = (r && r.error) || "Proofer couldn't be turned on. Run the speed check again.";
}));

async function saveReport() {
  const dlg = $("reportDialog");
  dlg.showModal();
  const choice = await new Promise((r) => dlg.addEventListener("close", () => r(dlg.returnValue), { once: true }));
  if (choice !== "save") return;
  const r = await sendMessage({ type: "SETUP_REPORT" });
  if (!r || !r.ok) return;
  const report = { ...r.report, computer: await computerInfo(), laptopModel: $("laptopModel").value.trim().slice(0, 80) || null };
  const blob = new Blob([JSON.stringify(report, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `proofer-test-report-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
for (const id of ["saveReport", "saveReportSlow", "saveReportOdd", "saveReportOps"]) $(id).addEventListener("click", trusted(saveReport));

// What the browser can tell about the hardware, and nothing it can't: the
// report holds no text, sites or paths.
async function computerInfo() {
  const out = { platform: platform.platform, platformVersion: platform.version,
    logicalCores: navigator.hardwareConcurrency || null,
    deviceMemoryGB: navigator.deviceMemory || null, // capped at 8 by the browser
    browser: null, gpu: null, onBattery: null };
  try {
    const uad = navigator.userAgentData;
    if (uad && uad.getHighEntropyValues) {
      const hv = await uad.getHighEntropyValues(["fullVersionList"]);
      out.browser = (hv.fullVersionList || []).filter((b) => !/Not.?A.?Brand/i.test(b.brand)).map((b) => `${b.brand} ${b.version}`);
    }
  } catch {}
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    out.gpu = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null;
  } catch {}
  try {
    if (navigator.getBattery) { const b = await navigator.getBattery(); out.onBattery = !b.charging; }
  } catch {}
  return out;
}

// --- Polling -------------------------------------------------------------------

// While visible, every ~2 s; at once when the tab becomes visible again, so
// coming back from Ollama's installer carries on without a click.
let pollTimer = null;
function schedule() {
  clearTimeout(pollTimer);
  if (document.visibilityState !== "visible") return;
  pollTimer = setTimeout(async () => {
    if (["checking", "install-needed", "update-needed", "not-ollama"].includes(current)) await refresh();
    schedule();
  }, POLL_MS);
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") { clearTimeout(pollTimer); return; }
  if (["checking", "install-needed", "update-needed", "not-ollama", "ready"].includes(current)) await refresh();
  schedule();
});

(async () => {
  platform = await platformInfo();
  await refresh();
  schedule();
})();
