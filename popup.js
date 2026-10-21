// No settings defaults or validation live here. background.js owns them,
// applies them in getSettings(), and returns the merged, sanitized result from
// GET_SETTINGS -- so this file reads the effective config rather than keeping a
// second copy that silently drifts. (It did: the model name was duplicated
// here, and every model switch had to remember to edit both files.)

function sendMessage(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message, messaging: true });
        else resolve(response);
      });
    } catch (e) { resolve({ ok: false, error: e.message, messaging: true }); }
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve) => chrome.tabs.query(queryInfo, resolve));
}

// Ask the page what sentence mode is doing there. Under `activeTab` -- granted
// when the user opens this popup from the toolbar -- messaging the tab's
// content scripts needs no further permission.
//
// It reaches EVERY frame and Chrome keeps only the first reply; content.js
// staggers its answer so the frame holding the focused editable wins that race.
// No listener at all (a chrome:// page, a PDF, a content script orphaned by an
// extension reload) resolves to null rather than throwing, and the caller says
// so instead of guessing.
function askPage(tabId, msg, timeoutMs = 900) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.tabs.sendMessage(tabId, msg, (response) => {
        void chrome.runtime.lastError;    // no listener: null, not a throw
        finish(response || null);
      });
    } catch {
      finish(null);
    }
  });
}

async function getActiveOrigin() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.url) return { origin: null, tabId: null };
  try {
    const u = new URL(tab.url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return { origin: null, tabId: tab.id };
    return { origin: u.origin, tabId: tab.id };
  } catch {
    return { origin: null, tabId: tab.id };
  }
}

function setStatus(text, isError) {
  const el = document.getElementById("status");
  el.textContent = text || "";
  // Class-based so the dark-mode CSS can restyle it (inline color would win)
  el.classList.toggle("error", !!isError);
}

function normalizeUrl(s) {
  const u = new URL(s);
  return u.origin + u.pathname.replace(/\/+$/, "");
}

// Validate + normalize an Ollama URL. Returns the normalized string, or null
// after setting an error status. Used by both Save and Test connection.
function validateLocalhostUrl(raw) {
  let url;
  try {
    url = normalizeUrl(raw);
    const parsed = new URL(url);
    if (parsed.protocol !== "http:") {
      setStatus("Only http:// URLs are supported.", true);
      return null;
    }
    if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      setStatus("Only localhost URLs are supported.", true);
      return null;
    }
  } catch {
    setStatus("Invalid URL.", true);
    return null;
  }
  return url;
}

// Engine identity is observed and interpreted by the worker.
const ENGINE_TEXT = {
  ok: "installed",
  missing: "not installed — open setup",
  mismatch: "a different version is installed — open setup",
  unknown: "could not check",
};


// A changed notice version is shown again before the next export and recorded
// in the exported file. Export itself grants no sharing or training permission.
const EXPORT_NOTICE_VERSION = "2026-10-21";
const EXPORT_NOTICE_KEY = "exportNoticeSeen";
const EXPORT_NOTICE = "Export log saves a file on your computer. It sends nothing and grants no "
  + "permission to use the file. It contains checked sentences, preceding text, "
  + "sites, proposed changes and later edits, and may contain sensitive information "
  + "about you and other people. Keep it private. For support, contact "
  + PROOFER_MAINTAINER.name + " at " + PROOFER_MAINTAINER.email
  + " before sharing a log. Remove personal, confidential and other people's text "
  + "and share only what is needed. Sharing for support does not authorize model "
  + "training or upload to an AI service. You can request deletion of support "
  + "material at the same address.";

function openSetup() {
  chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  window.close();
}

// What stops Proofer working right now, in plain words, or null. Checked in
// order of what the user can do about it first. The popup names the problem
// and offers setup. A mode switched off by the user is not a problem.
function setupProblem(settings, health, engine) {
  if (!settings) return null;
  const q = settings.qualification;
  const isMac = /Mac/.test(navigator.platform || navigator.userAgent);
  if (health && health.ok === false && !health.messaging && (!health.ollama || health.ollama.state === "unreachable") && settings.sentenceMode) {
    return `Proofer needs Ollama running. Open Ollama from ${isMac ? "Applications" : "the Start menu"}; Proofer carries on by itself.`;
  }
  if (health && !health.messaging && health.ollama && health.ollama.state === "unusable") return "Proofer could not read Ollama's status. Open setup.";
  if (health && !health.messaging && health.ollama && health.ollama.state === "ok" && !health.ollama.versionOk) return "Ollama needs an update. Open setup.";
  if (engine === "missing" || engine === "mismatch") return "The proofreading engine needs to be downloaded again.";
  if (settings.qualified) return null;
  if (q && q.stale === "ollama-updated") return "Ollama was updated, so Proofer needs its speed check again.";
  if (q && /^engine-/.test(String(q.stale || ""))) return "The proofreading engine needs to be downloaded again.";
  if (q && q.category === "running") return "The speed check hasn't finished. Open setup to see it or run it again.";
  if (q && q.category === "operational") return "The speed check didn't finish. Open setup to run it again.";
  if (q && q.pass === false) return "This computer didn't pass Proofer's speed check. Setup says why and can run it again.";
  // Never set up: the activation block says so and offers setup itself.
  return settings.sentenceMode ? "Proofer needs its setup finished before it can correct anything." : null;
}

function renderSetupLine(settings, health, engine) {
  const el = document.getElementById("setupLine");
  const text = setupProblem(settings, health, engine);
  el.style.display = text ? "" : "none";
  document.getElementById("setupLineText").textContent = text || "";
}

async function main() {
  const ollamaUrlEl = document.getElementById("ollamaUrl");
  const originTextEl = document.getElementById("originText");
  const saveBtn = document.getElementById("saveBtn");
  const testBtn = document.getElementById("testBtn");
  const recordAllEl = document.getElementById("recordAll");
  const logStatsEl = document.getElementById("logStats");

  setStatus("");
  const { origin, tabId } = await getActiveOrigin();
  // Both site controls act on the ACTIVE tab's origin. Opened as a tab (or on a
  // chrome:// page) there isn't one, so they get disabled -- previously in
  // silence, under a label that read like the site itself was unsupported. Say
  // what to do instead: the per-site recording toggle is unreachable otherwise.
  originTextEl.textContent = origin
    ? `Site: ${origin}`
    : "No site — open Proofer from the toolbar while the page is in front.";
  const noSiteHint = origin ? "" : "Needs a web page: open Proofer from the toolbar button.";

  const sentenceSiteEl = document.getElementById("sentenceModeSite");
  const sentenceSitesEl = document.getElementById("sentenceSites");
  const sentenceStatsEl = document.getElementById("sentenceStats");
  const sentenceEnableAllEl = document.getElementById("sentenceEnableAllSites");
  const sentenceActivateEl = document.getElementById("sentenceActivate");
  const sentenceOnEl = document.getElementById("sentenceOn");
  const sentenceWhereEl = document.getElementById("sentenceWhere");

  const resp = await sendMessage({ type: "GET_SETTINGS", tabId });
  if (!resp || !resp.ok || !resp.settings) {
    // Without the service worker there is nothing to read and nothing to save
    // to. Failing visibly beats rendering plausible-looking defaults over a
    // config we never actually loaded.
    setStatus("Could not load settings -- reload the extension and try again.", true);
    saveBtn.disabled = true;
    testBtn.disabled = true;
    return;
  }
  const loaded = { ...resp.settings };
  let consent = resp.consent;
  if (!Array.isArray(loaded.disabledSites)) loaded.disabledSites = [];

  // Recording is global, so unlike the per-site controls it stays usable even
  // when there is no active web page to name.
  recordAllEl.checked = loaded.recordAll !== false;

  ollamaUrlEl.value = loaded.ollamaUrl;

  // --- Sentence mode ---
  //
  // One switch and one per-site box (settings v5). The switch is the consent
  // to silent corrections -- suggestion mode is gone, so on means write -- and
  // it is only ever turned ON by the Turn on button, never by a Save. The box
  // is this site's membership of the switch-off lists: there are two
  // (disabledSites and sentenceModeDisabledSites, both read by the worker), and
  // a site in either is off, so the box shows off for either and switching it
  // back on clears both.
  if (!Array.isArray(loaded.sentenceModeDisabledSites)) loaded.sentenceModeDisabledSites = [];
  renderSentenceSwitches(loaded);
  sentenceSiteEl.disabled = !origin;
  sentenceSiteEl.title = noSiteHint;

  function siteIsOff() {
    return consent && consent.siteDisabled === true;
  }

  function renderSentenceSwitches(s) {
    const on = consent && consent.activated === true;
    // The activation block is the only place the mode is turned on, so it is
    // shown exactly while the mode is off -- including after someone switches
    // it back off, which is when "how do I get it back" is a real question.
    if (sentenceActivateEl) sentenceActivateEl.style.display = on ? "none" : "";
    if (sentenceOnEl) sentenceOnEl.style.display = on ? "" : "none";
    // Until the speed check has passed on this computer the one action is
    // setup, not Turn on (the worker refuses Turn on without it anyway).
    const qualified = s.qualified === true;
    document.getElementById("activateOn").style.display = qualified ? "" : "none";
    document.getElementById("activateSetup").style.display = qualified ? "none" : "";
    document.getElementById("activateNeedsSetup").style.display = qualified ? "none" : "";
    sentenceSiteEl.checked = !!origin && !siteIsOff();
  }

  // The write consent has its own message, never a settings save: the worker
  // refuses a SET_SETTINGS that carries it (a v4-shaped payload meant
  // "suggest" by the same bit), and the whole-object Save is the
  // read-modify-write that has already resurrected a revoked permission once.
  async function setSentenceMode(on) {
    const r = await sendMessage({ type: "SET_SENTENCE_MODE", on: !!on, tabId });
    if (!r || !r.ok) {
      setStatus((r && r.error) || (on ? "Could not turn Proofer on." : "Could not turn Proofer off."), true);
      return;
    }
    adoptStoredSettings(r.settings, r.consent);
    refreshSentenceWhere();
    setStatus(on
      ? "On. Corrections are written as you type -- Escape takes one back."
      : "Off. Nothing is corrected until you turn it back on.", false);
  }

  async function reconcileSiteSwitch() {
    const r = await sendMessage({ type: "GET_SETTINGS", tabId });
    if (r && r.ok) {
      adoptStoredSettings(r.settings, r.consent);
      return true;
    }
    renderSentenceSwitches(loaded);
    return false;
  }

  // Applies at once, not on Save: a site switch is one origin toggled against
  // live state, and a box that only takes effect after a second click reads as
  // a box that did nothing.
  //
  // Gated on the CLICK, not on `change`: a scripted el.click() on a checkbox
  // fires a `change` the browser marks trusted (it is the checkbox's own
  // activation behaviour), so an isTrusted test on `change` gates nothing.
  // The click itself is untrusted, and cancelling it undoes the toggle.
  // Keyboard toggling (Space) arrives as a trusted click too.
  sentenceSiteEl.addEventListener("click", async (e) => {
    if (!e.isTrusted || !origin) { e.preventDefault(); return; }
    const use = sentenceSiteEl.checked;
    const settings = { sentenceDisabledSiteToggle: { origin, enabled: !use } };
    if (use) settings.disabledSiteToggle = { origin, enabled: false };
    sentenceSiteEl.disabled = true;
    try {
      const r = await sendMessage({ type: "SET_SETTINGS", tabId, settings });
      if (!r || !r.ok) {
        const confirmed = await reconcileSiteSwitch();
        setStatus(((r && r.error) || "Could not update this site.") +
          (confirmed ? "" : " The current setting could not be confirmed."), true);
        return;
      }
      adoptStoredSettings(r.settings, r.consent);
      setTimeout(refreshSentenceWhere, 150);
      setStatus(use ? `On for ${origin}.` : `Off for ${origin}.`, false);
    } finally {
      sentenceSiteEl.disabled = !origin;
    }
  });

  // Both switch-off lists, as one: a site in either is off (see siteIsOff).
  function offSites() {
    return [...new Set([...(loaded.disabledSites || []), ...loaded.sentenceModeDisabledSites])];
  }

  function renderSentenceSites() {
    const off = offSites();
    const n = off.length;
    sentenceSitesEl.textContent = n
      ? `Switched off on ${n} site${n === 1 ? "" : "s"}: ${off.join(", ")}`
      : "On for every site, in the editors it can write to.";
    // Switching every site back on from wherever the user happens to be;
    // without this the only way back is to visit each site and open the popup
    // there. Switching every site OFF is Turn off above.
    sentenceEnableAllEl.style.display = n ? "" : "none";
  }

  // Re-seed every control and the local mirror from stored settings.
  function adoptStoredSettings(s, currentConsent) {
    if (!s) return;
    consent = currentConsent;
    loaded.sentenceModeDisabledSites = Array.isArray(s.sentenceModeDisabledSites) ? s.sentenceModeDisabledSites : [];
    loaded.sentenceMode = consent && consent.activated === true;
    loaded.qualified = s.qualified === true;
    loaded.qualification = s.qualification || null;
    if (Array.isArray(s.disabledSites)) loaded.disabledSites = s.disabledSites;
    renderSentenceSwitches(s);
    renderSentenceSites();
  }
  renderSentenceSites();

  // --- "Is it actually running here?" --------------------------------------
  //
  // The question this block exists to answer. claude.ai is a ProseMirror
  // composer; before the transport registry, sentence mode attached to nothing
  // there and said nothing about it -- no chip, no flash, no warmup, no log
  // line, no error. The consent was stored and honoured; there was simply no
  // eligible field, and from outside that is indistinguishable from a broken
  // extension. Whatever the answer is, it has to be legible.

  const EDITOR_DETAIL = {
    "unknown-editor": (f) => f
      ? `this site's editor (${f}) is not certified for sentence mode yet`
      : "this site's editor is not one sentence mode can write to safely",
    "not-english": () => "the field is not marked as English",
    "too-large": () => "the field holds too much text (it is a document, not a composer)",
    "read-only": () => "the field is read-only",
    "single-line-input": () => "it is a single-line input, which has no next sentence to trigger on",
    "not-editable": () => "the focused element is not editable",
    "no-segmenter": () => "this browser has no Intl.Segmenter",
    "canvas-host": () => "this site draws its editor on a canvas, so there is no text to read",
  };

  // Why the LAST sentence was left alone. Collapsing these into one line about
  // formatting told users the sentence crossed a mention when what actually
  // happened was that they kept typing, or that the correction did not fit.
  const RANGE_DETAIL = {
    "non-uniform-range": "it crossed formatting, a mention or an embed",
    "stale-range": "it crossed a block boundary",
    "no-range": "the text moved before it could be written",
    "text-moved": "the text moved before it could be written",
    "aborted": "you carried on typing while it was being written",
    "no-selection": "there was no selection to write into",
    "maxlength": "the correction would not fit in this field's character limit",
  };

  // Why sentence mode STOPPED here. These are the five values
  // blockSentenceField records, and they are not interchangeable: two of them
  // say the editor lied about a write and withdraw the whole family, and three
  // say it told the truth. Reading only `not-durable` and describing the rest
  // as "the page rejected it" told a user whose editor wrote a correction into
  // the wrong place that the page had refused it.
  const BLOCK_DETAIL = {
    "not-durable": (ed) => `${ed} discarded a Proofer write after accepting it`,
    "wrote-elsewhere": (ed) => `${ed} put a Proofer write somewhere other than the `
      + `sentence it was asked to replace`,
    "reconciled": () => "a write was made and the page replaced it",
    "write-rejected": (ed) => `${ed} would not accept a write`,
    "write-normalized": (ed) => `${ed} changed surrounding text during the write`,
  };

  function renderSentenceWhere(text, kind) {
    sentenceWhereEl.textContent = text;
    sentenceWhereEl.classList.toggle("ok", kind === "ok");
    sentenceWhereEl.classList.toggle("warn", kind === "warn");
  }

  // The worker owns permission; the popup only formats its explanation.
  function sentenceOffReason() {
    switch (consent && consent.reason) {
      case "upgrading": return "Settings are still being upgraded — try again in a moment.";
      case "switched-off": return "Proofer is switched off.";
      case "qualification-required": return "Proofer needs a current, passing speed check. Open setup.";
      case "no-http-page": return "there is no http or https page in front (it runs only on those).";
      case "site-disabled": return `Proofer is disabled on ${origin}.`;
      default: return "Permission could not be checked.";
    }
  }

  function describePageStatus(r) {
    if ((r.status === "active" || r.status === "unsafe-range") && r.apply !== true) {
      return ["Not running here.", null];
    }
    const family = r.family && r.family !== "textarea" ? r.family : null;
    switch (r.status) {
      case "active":
        return [`Running in the field you focused${family ? ` (${family})` : ""}.`, "ok"];
      case "field-detached":
        return ["The field was removed before the write could be checked. Click into a text field to continue.", "warn"];
      case "unsupported-editor": {
        const why = (EDITOR_DETAIL[r.detail] || (() => `it is unsupported (${r.detail})`))(family);
        return [`Not running: ${why}.`, "warn"];
      }
      case "unsafe-range": {
        const why = RANGE_DETAIL[r.detail] || `it was refused (${r.detail})`;
        return [`Running${family ? ` (${family})` : ""}, but the last sentence was `
          + `left alone: ${why}.`, null];
      }
      case "session-blocked": {
        // Each cause has its own explanation. This branch used to read the detail only
        // for `not-durable` and tell everyone else "a correction was written
        // and the page rejected it" -- true of `reconciled` and false of the
        // other two, which is a diagnostic naming a cause it did not observe.
        // content.js kept only "blocked" for the non-demoting pair until it
        // started recording the reason, so there was nothing here to read.
        const ed = `this editor${family ? ` (${family})` : ""}`;
        const why = (BLOCK_DETAIL[r.detail]
          || ((e) => `${e} refused a correction (${r.detail})`))(ed);
        return [`Stopped: ${why}. Reload the page to try again.`, "warn"];
      }
      case "off":
        return [r.detail === "site-disabled"
          ? "Not running: Proofer is disabled on this site."
          : "Not running here.", null];
      default:
        return ["No text field focused. Click into one on the page, then reopen this popup.", null];
    }
  }

  let sentenceWhereRequest = 0;
  async function refreshSentenceWhere() {
    const request = ++sentenceWhereRequest;
    renderSentenceWhere("Checking permission…", null);
    const current = await sendMessage({ type: "GET_SETTINGS", tabId });
    if (request !== sentenceWhereRequest) return;
    if (!current || !current.ok || !current.settings || !current.consent) {
      renderSentenceWhere("Could not check permission — reopen Proofer to try again.", "warn");
      return;
    }
    adoptStoredSettings(current.settings, current.consent);
    if (consent.allowed !== true) { renderSentenceWhere("Not running here: " + sentenceOffReason(), null); return; }
    if (tabId == null) { renderSentenceWhere("No page to check.", null); return; }
    const r = await askPage(tabId, { type: "SENTENCE_STATUS" });
    if (request !== sentenceWhereRequest) return;
    if (!r || !r.ok) {
      // Not the same as "unsupported" and must not read like it: a content
      // script orphaned by an extension reload, or a page injected before the
      // extension existed, is fixed by reloading the page.
      renderSentenceWhere("Enabled, but this page has not loaded Proofer yet — reload it.", "warn");
      return;
    }
    let [text, kind] = describePageStatus(r);
    // A live `no-field` is the normal way to arrive here: opening this popup
    // blurs the page. So the last field actually focused is the honest answer,
    // and answering "nothing is focused" instead is the same silence in a
    // different costume.
    // `off` joins it for the same reason: enabling the mode from this popup
    // makes content.js re-ask for consent with nothing focused, so the live
    // status resets to off while the useful answer is still remembered.
    if (consent.allowed === true && r.apply === true && (r.status === "no-field" || r.status === "off") && r.last) {
      const [lastText, lastKind] = describePageStatus({ ...r.last, apply: r.apply });
      text = lastText + " (previously focused field in this frame)";
      kind = lastKind;
    }
    renderSentenceWhere(text, kind);
  }
  refreshSentenceWhere();

  document.getElementById("activateOn").addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    setSentenceMode(true);
  });
  for (const id of ["activateSetup", "openSetup", "retestBtn"]) {
    document.getElementById(id).addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      openSetup();
    });
  }
  document.getElementById("turnOff").addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    setSentenceMode(false);
  });

  sentenceEnableAllEl.addEventListener("click", async () => {
    setStatus("");
    const n = offSites().length;
    if (!n) return;
    if (!confirm(`Turn Proofer back on for all ${n} site${n === 1 ? "" : "s"}?`)) return;
    // Both lists, in one write: the box treats a site in either as off.
    const r = await sendMessage({ type: "SET_SETTINGS", tabId,
      settings: { clearSentenceModeDisabledSites: true, disabledSites: [] } });
    if (!r || !r.ok) { setStatus("Could not update settings.", true); return; }
    adoptStoredSettings(r.settings, r.consent);
    refreshSentenceWhere();
    setStatus("Proofer turned on everywhere.", false);
  });

  const engineEl = document.getElementById("engineLine");
  const renderEngine = (resp) => {
    if (resp && resp.messaging) { engineEl.textContent = "Could not contact Proofer; the engine check could not be completed."; return "unknown"; }
    const st = resp && resp.engine ? resp.engine.state : "unknown";
    engineEl.textContent = resp && resp.ollama && resp.ollama.state === "unusable"
      ? "Could not read Ollama's status" : resp && resp.ok ? ENGINE_TEXT[st] || ENGINE_TEXT.unknown : "Ollama is not reachable";
    return st;
  };
  // Fire-and-forget: is the pinned engine there? Its answer also decides the
  // first line.
  const adoptHealth = (health) => {
    if (health && !health.messaging && health.configured && health.settings && health.consent) {
      adoptStoredSettings(health.settings, health.consent);
      refreshSentenceWhere();
    }
  };
  sendMessage({ type: "CHECK_HEALTH", tabId }).then((health) => {
    adoptHealth(health);
    const st = renderEngine(health);
    renderSetupLine(loaded, health, st);
  });
  renderSetupLine(loaded, null, null);

  testBtn.addEventListener("click", async () => {
    setStatus("");
    const url = validateLocalhostUrl(ollamaUrlEl.value.trim());
    if (!url) return;
    setStatus("Testing...");
    const resp = await sendMessage({ type: "CHECK_HEALTH", tabId, urlOverride: url });
    if (resp && resp.messaging) { setStatus("Could not contact Proofer; the connection check could not be completed.", true); return; }
    adoptHealth(resp);
    if (resp && resp.configured) renderSetupLine(loaded, resp, renderEngine(resp));
    if (!resp || !resp.ok || resp.ollama?.state === "unusable") {
      setStatus(resp && resp.ollama && resp.ollama.state === "unusable" ? "Could not read Ollama's status at " + url + "." : "Cannot reach Ollama at " + url + ".", true);
      return;
    }
    const v = resp.version || "?";
    const st = renderEngine(resp);
    if (resp.ollama && !resp.ollama.versionOk) { setStatus(`Connected (Ollama ${v}) -- update Ollama to ${resp.ollama.floor} or later.`, true); return; }
    setStatus(st === "ok"
      ? `Connected (Ollama ${v}) -- the proofreading engine is installed.`
      : `Connected (Ollama ${v}) -- the proofreading engine is ${ENGINE_TEXT[st]}.`, st !== "ok");
  });

  saveBtn.addEventListener("click", async () => {
    setStatus("");
    const next = {};
    const url = validateLocalhostUrl(ollamaUrlEl.value.trim());
    if (!url) return;
    next.ollamaUrl = url;

    // Only the address rides on Save (it is under Advanced now). The site box,
    // the on/off switch and Keep a log all apply at once as single writes: a
    // Save carrying them would resubmit state rendered from the popup's
    // opening snapshot -- the defect the site toggles were built to close.

    const r = await sendMessage({ type: "SET_SETTINGS", tabId, settings: next });
    if (!r || !r.ok) {
      setStatus(r && r.error ? r.error : "Save failed.", true);
      return;
    }
    loaded.ollamaUrl = next.ollamaUrl;
    // Re-seed from what was actually STORED, not from what was sent. The
    // sanitizer drops and dedupes entries, and background.js resolved the site
    // toggles against live state -- so this is also what stops the next Save
    // from this same popup acting on a stale snapshot again.
    adoptStoredSettings(r.settings, r.consent);
    // The consent that just changed is what decides this line, and the content
    // script re-reads it on the same storage change -- so the answer is asked
    // for again rather than left showing the state before Save.
    setTimeout(refreshSentenceWhere, 150);
    setStatus("Saved.", false);
  });

  // --- Recording ---

  // Keep a log applies at once, like the site box: one key, against live
  // state. Gated on the click, which a script cannot make trusted.
  recordAllEl.addEventListener("click", async (e) => {
    if (!e.isTrusted) { e.preventDefault(); return; }
    const want = recordAllEl.checked;
    const r = await sendMessage({ type: "SET_SETTINGS", tabId, settings: { recordAll: want } });
    if (!r || !r.ok) { recordAllEl.checked = !want; setStatus("Could not update recording.", true); return; }
    loaded.recordAll = want;
    setStatus(want ? "Recording on." : "Recording off. Proofer still corrects; nothing new is logged.", false);
  });

  // The same hazard the recent-changes view has, on a view nobody had noticed
  // it applies to: emptying the DOM does not cancel a request already on its
  // way back, so a GET_LOG_STATS started before Clear resolves after it and
  // repaints counts for records that no longer exist -- and Clear is the
  // user's guarantee that their writing is gone. The generation is bumped on
  // Clear and every load paints only if it is still current.
  let statsGen = 0;

  async function refreshLogStats() {
    const gen = ++statsGen;
    const r = await sendMessage({ type: "GET_LOG_STATS" });
    if (gen !== statsGen) return;
    const evictedEl = document.getElementById("logEvicted");
    if (!r || !r.ok) {
      logStatsEl.textContent = "";
      sentenceStatsEl.textContent = "";
      if (evictedEl) evictedEl.style.display = "none";
      renderSentenceBar(null);
      return;
    }
    renderSentenceStats(r.sentence);
    // How full the log is. A count alone cannot say when records start
    // going -- a quota rejection evicts the oldest tenth before the count
    // cap is reached -- so an early eviction is said out loud below.
    const n = (r.sentence && r.sentence.count) || 0;
    const cap = (r.sentence && r.sentence.cap) || 0;
    const bits = [cap ? `${n.toLocaleString()} of ${cap.toLocaleString()} sentences kept` : `${n} sentences kept`];
    if (r.legacyManual) {
      bits.push(`plus ${r.legacyManual} from the old rewrite panel`);
    }
    logStatsEl.textContent = n || r.legacyManual ? bits.join(" · ") : "Nothing recorded yet.";
    if (evictedEl) {
      // Both are said out loud: records dropped early to make room, and
      // records or verdicts that could not be written at all.
      const lines = [];
      if (r.evictions) lines.push("The log ran out of room, so older entries were dropped — export now to keep them.");
      if (r.writeFailures) lines.push("Some entries could not be recorded — export now, then Clear to make room.");
      evictedEl.style.display = lines.length ? "" : "none";
      evictedEl.textContent = lines.join(" ");
    }
  }

  function describeSentenceSkip(reason) {
    if (reason === "splice-failed:untrusted-rejected" || reason === "undo:failed-transport:untrusted-rejected") return `${reason} (the editor did not accept input from Proofer)`;
    return reason;
  }

  function renderSentenceStats(s) {
    // Skips are counted per reason, persisted, exported and cleared -- and were
    // rendered nowhere, which made the one failure mode they exist to describe
    // invisible. A field that refuses every scan (a rich editor whose
    // normalisation keeps failing the provenance compare, page-injected text,
    // an editor that keeps blocking) sends NOTHING, so `s.count` is zero, so
    // this line was blank: the same "a refusal nobody can see" defect the
    // status vocabulary exists to prevent, one level down in the diagnostics.
    // `field:*` entries share this map's plumbing but answer a different
    // question -- which EDITORS were met, not which scans were skipped -- and
    // they are far more numerous. Left in the total they would swamp it and
    // make "mostly <reason>" report a field tally, destroying the one
    // diagnostic this line exists to give. Partitioned, never summed.
    const allSkips = (s && s.skips) || {};
    const skips = {}, fields = {};
    for (const [k, v] of Object.entries(allSkips)) {
      (k.startsWith("field:") ? fields : skips)[k] = v;
    }
    const skipTotal = Object.values(skips).reduce((a, b) => a + (Number(b) || 0), 0);
    const fieldTotal = Object.values(fields).reduce((a, b) => a + (Number(b) || 0), 0);
    if (!s || (!s.count && !skipTotal && !fieldTotal)) {
      sentenceStatsEl.textContent = "";
      // Cleared on the way out, not just on the way through. This returned
      // early and left the previous breakdown rendered, so "Applied silently 1"
      // survived a Clear that had just deleted the record it counted. The bar
      // is on the same path for the same reason.
      renderSentenceBar(null);
      return;
    }
    const bits = s.count ? [`${s.count} sentence${s.count === 1 ? "" : "s"} checked`] : [];
    if (s.noChange) bits.push(`${Math.round((s.noChange / s.count) * 100)}% already clean`);
    if (s.guarded) {
      bits.push(s.topGuard
        ? `${s.guarded} refused by a guard (mostly ${s.topGuard.reason})`
        : `${s.guarded} refused by a guard`);
    }
    // A salvaged refusal carries guard: null, so it is in NEITHER the guarded
    // count nor anything else visible -- without this line the retry's whole
    // effect is a counter nothing renders.
    if (s.retrySalvaged) bits.push(`${s.retrySalvaged} salvaged by a retry`);
    // Kept vs reverted is the number that decides whether this ships at all.
    if (s.keepRate !== null) bits.push(`${s.keepRate}% kept without rejection of ${s.applied + s.reverted} applied corrections`);
    // In neither half of that rate on purpose -- the user did not reject these,
    // they never received them. A lost write is a transport problem, and
    // counting it as a rejection would blame the model for the editor.
    if (s.lost) bits.push(`${s.lost} lost to the editor`);
    if (s.medianMs !== null) bits.push(`${s.medianMs}ms median`);
    if (s.errors) bits.push(`${s.errors} error${s.errors === 1 ? "" : "s"}`);
    // The reason, not just the total, for the same argument `topGuard` makes:
    // "412 skipped" does not distinguish a quiet field from a field where every
    // scan is being refused, and the reason is the whole diagnosis.
    if (skipTotal) {
      let top = null;
      for (const [reason, n] of Object.entries(skips)) {
        if (!top || Number(n) > top.n) top = { reason, n: Number(n) };
      }
      // "skipped before sending" named only one of this map's three sources.
      // sentenceSkip() is also called by dropSentenceResult (a result that WAS
      // sent and then could not be delivered) and on a guard refusal (sent, and
      // refused by the worker). The breakdown below reports the recorded subset
      // of those separately; the two are never added, because this map is a
      // superset over a different retention window.
      bits.push(`${skipTotal} skipped or refused${top ? ` (mostly ${describeSentenceSkip(top.reason)})` : ""}`);
    }
    // Editor coverage. Reported among RICH editors: `single-line-input` is
    // every search box on the web and would drown the number that matters,
    // which is "a real prose editor Proofer could not write to".
    if (fieldTotal) {
      // Every rich-editor field that got NO service belongs in the denominator,
      // not just the unrecognised ones. Counting `unknown-editor` alone read
      // one served field beside nine blocked ones as "1/1 (100%)" -- a number
      // that improves as the feature fails. `not-english` is deliberately left
      // out of both sides: its detail does not say whether the field was a
      // rich editor or a textarea, and guessing would put search boxes in the
      // denominator. Named in editor-coverage-survey.md rather than fudged.
      let served = 0, unserved = 0;
      for (const [k, v] of Object.entries(fields)) {
        const n = Number(v) || 0;
        if (k.startsWith("field:ok:")) { if (k !== "field:ok:textarea") served += n; }
        else if (k === "field:unsupported-editor:unknown-editor"
              || k === "field:unsupported-editor:too-large"
              || k.startsWith("field:session-blocked:")) unserved += n;
      }
      const denom = served + unserved;
      if (denom) {
        bits.push(`rich editors served: ${served}/${denom} (${Math.round((100 * served) / denom)}%)`);
      }
    }
    sentenceStatsEl.textContent = bits.join(" · ");
    renderSentenceBar(s);
  }

  // The owner's note on the sentence above: "really needs a visual cue and not
  // words." A stacked proportion bar over an icon-and-count key.
  //
  // Three things make it correct rather than decorative.
  //
  // It draws the worker's `distribution`, which is a PARTITION -- one bucket
  // per record, `other` a sum of named parts. A bar is a claim about a whole,
  // so anything it is drawn from has to be one; the older `breakdown` is a set
  // of overlapping counts and covers neither guard refusals nor errors, so a
  // bar built from it would silently be a proportion of the wrong denominator.
  //
  // Every segment carries an ICON as well as a colour, and the icon is what
  // distinguishes the categories. Six colours in a 320px strip is exactly the
  // arrangement that stops working for a colour-blind reader, in dark mode, or
  // on a bad panel.
  //
  // A zero-count category keeps its key row at zero width rather than
  // vanishing. "Nothing was lost to the editor" and "we are not counting what
  // is lost to the editor" are different statements and a missing row makes
  // them look the same -- the same reason a counter nothing renders is treated
  // here as a defect in its own right.
  const BAR_SEGMENTS = [
    ["noChange", "=", "#94a3b8", "Already clean"],
    ["guarded", "\u26a0", "#d97706", "Refused by a guard"],
    ["applied", "\u2713", "#16a34a", "Applied"],
    ["rejected", "\u21a9", "#dc2626", "You rejected or undid it"],
    ["lost", "\u2298", "#7c3aed", "Lost to the editor"],
    ["other", "\u2026", "#2563eb", "Other"],
  ];

  function renderSentenceBar(s) {
    const barEl = document.getElementById("sentenceBar");
    const keyEl = document.getElementById("sentenceBarKey");
    if (!barEl || !keyEl) return;
    barEl.textContent = "";
    keyEl.textContent = "";
    const d = s && s.distribution;
    if (!d) return;
    // Validated, not trusted. This is a message payload; a NaN or a negative
    // reaching flexGrow lays the whole strip out wrong with no error anywhere.
    const counts = BAR_SEGMENTS.map(([k]) => {
      const n = Number(d[k]);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    });
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return;
    for (let i = 0; i < BAR_SEGMENTS.length; i++) {
      const [, icon, colour, label] = BAR_SEGMENTS[i];
      const n = counts[i];
      if (n > 0) {
        const seg = document.createElement("div");
        seg.className = "bar-seg";
        seg.style.flexGrow = String(n);
        seg.style.background = colour;
        // The icon rides in the segment only when there is room for it; the
        // key below is what carries the mapping either way.
        seg.textContent = n / total >= 0.08 ? icon : "";
        seg.title = `${label}: ${n}`;
        barEl.appendChild(seg);
      }
      const row = document.createElement("div");
      row.className = n > 0 ? "bar-key-row" : "bar-key-row bar-key-row-zero";
      const dot = document.createElement("span");
      dot.className = "bar-key-icon";
      dot.style.color = colour;
      dot.textContent = icon;
      const k = document.createElement("span");
      k.className = "bar-key-label";
      k.textContent = label;
      const v = document.createElement("span");
      v.className = "bar-key-count";
      v.textContent = String(n);
      row.append(dot, k, v);
      keyEl.appendChild(row);
      // ...and what the bucket is MADE of, immediately under its own row. The
      // partition answers "what happened to the sentences"; these answer "which
      // kind", and two of them are distinctions the log was rebuilt to be able
      // to draw at all -- a write nobody looked at, a write we declined to
      // verify, and a suggestion a human read and clicked Apply on.
      for (const [label, count] of subRowsFor(BAR_SEGMENTS[i][0], s)) {
        const sub = document.createElement("div");
        sub.className = "bar-key-row bar-key-row-sub";
        const pad = document.createElement("span");
        pad.className = "bar-key-icon";
        pad.textContent = "";
        const sk = document.createElement("span");
        sk.className = "bar-key-label";
        sk.textContent = label;
        const sv = document.createElement("span");
        sv.className = "bar-key-count";
        sv.textContent = String(count);
        sub.append(pad, sk, sv);
        keyEl.appendChild(sub);
      }
    }
  }

  // The sub-rows for one bucket, as [label, count] pairs. Only two buckets have
  // any: `applied`, whose three kinds mean very different things and only one of
  // which is a human ratification; and `other`, which is a sum of NAMED parts
  // rather than a remainder, so what it is made of has to be visible or the
  // whole point of not computing it as a remainder is lost.
  function subRowsFor(key, s) {
    const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : 0);
    if (key === "applied") {
      const b = (s && s.breakdown) || {};
      // "You accepted a suggestion" keeps its row AT ZERO, alone among these.
      // It is the strongest positive the log can hold and the only one that is
      // a human ratification, so its absence is itself the answer to "has
      // anyone actually agreed with one of these?" -- a row that vanishes makes
      // "nobody has" indistinguishable from "we do not count that". The other
      // rows say nothing when empty.
      return [
        ["Silently, verified", n(b.appliedSilently)],
        ["Silently, not verified", n(b.appliedUnverified)],
        ["Replacement reached its target; surrounding text changed", n(b.writtenNormalized)],
      ].filter(([, v]) => v > 0);
    }
    if (key === "rejected") {
      const b = (s && s.breakdown) || {};
      return [
        ["Escape: the page discarded the undo", n(b.undoReconciled)],
        ["Escape: the undo was not verified", n(b.undoUnverified)],
      ].filter(([, v]) => v > 0);
    }
    if (key === "other") {
      const d = (s && s.otherDetail) || {};
      const dropped = ((s && s.breakdown) || {}).deliverySkipped || {};
      const rows = [["Suggestion mode (old records)", n(d.legacySuggestion)]];
      rows.push(["Write changed the field without honoring its target", n(d.writtenMisplaced)]);
      // By REASON, not as one number. "21 dropped on delivery" does not
      // distinguish a stale anchor from a blocked field, and the reason is the
      // whole diagnosis -- the same argument `topGuard` makes one line up.
      for (const [reason, v] of Object.entries(dropped).sort((a, c) => c[1] - a[1])) {
        if (n(v) > 0) rows.push([`Dropped on delivery \u2014 ${describeSentenceSkip(reason)}`, n(v)]);
      }
      rows.push(["Errored", n(d.errored)]);
      rows.push(["No verdict recorded", n(d.unresolved)]);
      // Never filtered out when non-zero: an outcome nobody classified is a
      // fact to surface, and it is the one row here that means "look at this".
      rows.push(["Unclassified \u2014 report this", n(d.unclassified)]);
      return rows.filter(([, v]) => v > 0);
    }
    return [];
  }

  document.getElementById("exportLogBtn").addEventListener("click", async (e) => {
    if (!e.isTrusted) return;
    setStatus("");
    const r = await sendMessage({ type: "EXPORT_LOG" });
    if (!r || !r.ok) { setStatus("Could not export the log.", true); return; }
    const { records, warmups, skips } = r.counts;
    const diagnostics = warmups + skips;
    if (!records && !diagnostics) { setStatus("Nothing recorded yet.", true); return; }
    // The notice, the first time (and again whenever its wording changes):
    // what the file holds and what sharing it for support would mean. Declining saves nothing.
    const seen = await new Promise((res) => {
      try { chrome.storage.local.get({ [EXPORT_NOTICE_KEY]: null }, (o) => res(o && o[EXPORT_NOTICE_KEY])); }
      catch { res(null); }
    });
    if (seen !== EXPORT_NOTICE_VERSION) {
      if (!confirm(`${EXPORT_NOTICE}\n\nSave the file now?`)) { setStatus("Nothing was saved.", false); return; }
      try { chrome.storage.local.set({ [EXPORT_NOTICE_KEY]: EXPORT_NOTICE_VERSION }); } catch {}
    }
    // JSONL: one record per line, which is what test/log-to-cases.mjs reads and
    // what stays diffable if you keep an export around. The last row names the
    // notice this person saw, so a contribution carries its own consent
    // provenance (test/contributions.mjs reads it).
    const rows = [...r.records, { v: 1, path: "notice", notice: EXPORT_NOTICE_VERSION, exportedAt: Date.now() }];
    const body = rows.map((rec) => JSON.stringify(rec)).join("\n") + "\n";
    const url = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `proofer-log-${new Date().toISOString().slice(0, 10)}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    // Counts describe this export's inputs, not Clear's orphan-inclusive inventory.
    setStatus(records ? `Exported ${records} interaction records`
      + (diagnostics ? ` + ${diagnostics} diagnostic rows.` : ".")
      : "No interaction records. Exported diagnostics only.", false);
  });

  document.getElementById("clearLogBtn").addEventListener("click", async () => {
    setStatus("");
    const r = await sendMessage({ type: "GET_LOG_STATS" });
    // The worker's own answer to "is there anything Clear would remove",
    // asked of storage by the prefixes Clear sweeps. Deciding it here from
    // counts is how an install holding only old-panel records, orphaned
    // keys or text-free telemetry was told "Nothing to clear." and kept it.
    const c = r && r.ok && r.clearable;
    if (!c) { setStatus("Could not read the log.", true); return; }
    // Deleting the user's own recorded writing is not undoable, so it asks --
    // and only records hold writing, so the confirmation names those.
    const n = Number(c.records) || 0;
    if (n && !confirm(`Delete all ${n} recorded entries from this computer? `
      + "This cannot be undone. Files you already exported are not affected.")) return;
    // CLEAR_LOG is sent even when nothing is stored. A sentence in flight when
    // Clear is pressed writes its record when its response lands, and only
    // CLEAR_LOG advances the generation that drops it: the old "Nothing to
    // clear." return let that record be written after the user cleared
    // (checkpoint 1, 2026-09-25).
    const cl = await sendMessage({ type: "CLEAR_LOG" });
    if (!cl || !cl.ok) { setStatus("Could not clear the log.", true); return; }
    await refreshLogStats();
    invalidateRecent();
    setStatus(c.any ? "Log cleared." : "Nothing to clear.", false);
  });

  // --- Recent changes ------------------------------------------------------
  //
  // The receipt for the silent path. A silent apply gets a 1600ms flash and one
  // undo slot, so "what did Proofer change in that message?" had no answer a
  // minute later short of exporting JSONL.
  //
  // Loaded on demand rather than with the popup, so the ordinary case -- open
  // the popup, change a setting, close it -- never pulls the user's recorded
  // prose into this page at all.
  const recentBtn = document.getElementById("recentBtn");
  const recentEl = document.getElementById("recentChanges");
  let recentOpen = false;
  // Emptying the DOM does not cancel a request already on its way back. Without
  // a generation, a load started before Clear resolves after it and paints the
  // deleted prose -- with a Copy button on it -- into a view the user just
  // emptied; the same response can also repopulate a view they closed. Every
  // load carries the generation it began in and only paints if it is still the
  // current one.
  let recentGen = 0;

  function renderRecent(rows) {
    // textContent and createTextNode throughout, never innerHTML. These strings
    // are the user's own writing and a language model's output, both of which
    // this project treats as untrusted by standing rule -- and this is the
    // first path that puts either into the popup's DOM. A single interpolated
    // template here would make a proofread sentence into markup.
    recentEl.textContent = "";
    if (!rows.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Nothing yet. Proofer writes that changed a text field show up here.";
      recentEl.appendChild(p);
      return;
    }
    for (const row of rows) {
      const card = document.createElement("div");
      card.className = "recent-row";

      const head = document.createElement("div");
      head.className = "recent-head";
      const where = document.createElement("span");
      let host = "";
      try { host = row.origin ? new URL(row.origin).host : ""; } catch { host = ""; }
      where.textContent = [host, row.outcome].filter(Boolean).join(" — ");
      const when = document.createElement("span");
      when.textContent = row.ts ? new Date(row.ts).toLocaleString() : "";
      head.append(where, when);

      const before = document.createElement("div");
      before.className = "recent-before";
      before.appendChild(document.createTextNode(row.input));
      const after = document.createElement("div");
      after.className = "recent-after";
      after.appendChild(document.createTextNode(row.output));

      // Copy, not Restore. Putting text back at offsets recorded minutes ago,
      // into a document that has moved on and a field that is not even focused,
      // is the aliased-insertion hazard in its worst form. This cannot land in
      // the wrong place because it does not land anywhere.
      const copy = document.createElement("button");
      copy.className = "recent-copy";
      copy.textContent = "Copy my original";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(row.input);
          copy.textContent = "Copied";
          setTimeout(() => { copy.textContent = "Copy my original"; }, 1200);
        } catch { copy.textContent = "Could not copy"; }
      });

      card.append(head, before, after, copy);
      recentEl.appendChild(card);
    }
  }

  async function loadRecent() {
    const gen = recentGen;
    const r = await sendMessage({ type: "GET_RECENT_SENTENCES" });
    // Stale, or the view was closed or cleared while this was in flight.
    if (gen !== recentGen || !recentOpen) return;
    if (!r || !r.ok) { recentEl.textContent = "Could not read recent changes."; return; }
    renderRecent(r.rows || []);
  }

  if (recentBtn && recentEl) {
    recentBtn.addEventListener("click", async () => {
      recentOpen = !recentOpen;
      // Bumped on BOTH edges: closing must strand an in-flight load, or it
      // resolves afterwards and repaints the prose into the hidden element.
      recentGen++;
      recentEl.style.display = recentOpen ? "" : "none";
      recentBtn.textContent = recentOpen ? "Hide recent changes" : "Show recent changes";
      if (recentOpen) await loadRecent();
      // Closing drops the rendered prose rather than leaving it in the DOM.
      else recentEl.textContent = "";
    });
  }

  // Clearing the log is the user's guarantee that their writing is gone. An
  // open receipt list would leave it on screen and copyable at the one moment
  // that guarantee is being exercised, so the view is emptied with it.
  function invalidateRecent() {
    if (!recentEl) return;
    // Strand anything already in flight FIRST. Emptying the DOM afterwards is
    // pointless if a response from before the clear can still paint into it.
    recentGen++;
    recentEl.textContent = "";
    if (recentOpen) loadRecent();
  }

  refreshLogStats();
}

main();
