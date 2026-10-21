(() => {
  // tabs.sendMessage keeps the FIRST response across frames. Both listeners
  // use these bounded priority buckets; renderer scheduling can decide a tie.
  // Focused editable: 0 ms. Remembered status: 60 ms below 30 seconds, 120 ms
  // otherwise. Empty top frame: 150 ms. Empty subframe: no reply.
  // Age is from sentenceLastField.at, updated by setSentenceStatus, not from
  // the last keystroke. Canvas hosts have neither a tracked field nor history.
  const SN_STATUS_REPLY_MS = { live: 0, remembered: 60, empty: 150 };
  const SN_STATUS_STALENESS_MS = 60;

  function replySentenceStatus(focused, last, report, sendResponse) {
    const staleness = last
      ? Math.min(SN_STATUS_STALENESS_MS, Math.round((Date.now() - last.at) / 60000) * SN_STATUS_STALENESS_MS)
      : 0;
    const delay = focused ? SN_STATUS_REPLY_MS.live
      : last ? SN_STATUS_REPLY_MS.remembered + staleness
      : window === window.top ? SN_STATUS_REPLY_MS.empty
      : -1;
    if (delay < 0) return;                     // let a better-placed frame answer
    setTimeout(() => { try { sendResponse(report()); } catch {} }, delay);
    return true;
  }

  // Skip entirely on sites that use canvas-based editors — Proofer can't support them
  const UNSUPPORTED_HOSTS = ["docs.google.com", "sheets.google.com", "slides.google.com", "figma.com"];
  if (UNSUPPORTED_HOSTS.some(h => window.location.hostname.endsWith(h))) {
    // ...but answer the popup on the way out. Returning here without a listener
    // means SENTENCE_STATUS gets no reply at all, and "no reply" is rendered as
    // "this page has not loaded Proofer yet — reload it": an instruction that
    // cannot possibly work, given to the user on the one class of site where
    // the refusal is permanent and completely understood. The whole point of
    // this status is that a refusal says which refusal it is.
    try {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== "SENTENCE_STATUS") return;
        return replySentenceStatus(null, null, () => ({
          ok: true, status: "unsupported-editor", detail: "canvas-host",
          family: null, frame: window.location.host || null,
          top: window === window.top, apply: false, last: null,
        }), sendResponse);
      });
    } catch {}
    return;
  }

  const globalAC = new AbortController();
  let contextDead = false;
  let focusedEditable = null;
  // One namespace per content instance, including frames and reloads. Mint it
  // only on first send so source-only sandboxes need no crypto implementation.
  let sentenceRequestNamespace = null;
  let rewriteRequestId = 0;

  function nextSentenceRequestId() {
    if (sentenceRequestNamespace === null) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      sentenceRequestNamespace = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    return "sn_" + sentenceRequestNamespace + "_" + (++rewriteRequestId);
  }
  // True while one of our own writes is in the field. The splice recipes set
  // it; provenance, the input handler and the edit and durability watchers read
  // it so a write of ours is never mistaken for the user's.
  let applyingRewrite = false;

  // --- Messaging ---

  // Messaging failures resolve with a generic message — raw lastError /
  // exception text must not reach the page DOM (isolated-world console is
  // fine for the detail; pages can't intercept it).
  const MESSAGING_ERROR = "Proofer is unavailable -- reload this page";

  const messagingFailure = () => ({ ok: false, error: MESSAGING_ERROR, messaging: true });

  function sendMessage(msg) {
    if (contextDead) return Promise.resolve(messagingFailure());
    // Reloading or updating the extension orphans every content script already
    // on a page: `chrome` survives, `chrome.runtime` does not. Reaching for
    // .sendMessage on it throws a TypeError that Chrome files in the
    // extension's own error console -- and the throw is the FIRST notice this
    // script gets, so the state has to be repaired from a catch block instead
    // of being known up front. Ask before reaching.
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
      markContextDead();
      return Promise.resolve(messagingFailure());
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) {
            if (err.message && err.message.includes("Extension context invalidated")) {
              markContextDead();
            }
            console.warn("[Proofer] sendMessage failed:", err.message);
            resolve(messagingFailure());
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        // Backstop: the context can die between the check above and the call.
        markContextDead();
        console.warn("[Proofer] sendMessage threw:", e);
        resolve(messagingFailure());
      }
    });
  }

  function markContextDead() {
    if (contextDead) return;
    contextDead = true;
    onContextInvalidated();
  }

  // Reloading or updating the extension orphans this script. Every document
  // listener goes with the abort; the sentence state is dropped so nothing
  // keeps firing against a worker that is gone. There is no page UI left to
  // carry a "reload this page" hint (the red button did until the manual path
  // was removed): the popup asks the page for its status, an orphaned script
  // cannot answer, and the popup already reads no answer as "reload it".
  function onContextInvalidated() {
    globalAC.abort();
    try { teardownSentence(); } catch {}
  }

  // --- Utilities ---

  function isEditableElement(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.tagName === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return type === "text" && !el.disabled && !el.readOnly;
    }
    return el.isContentEditable;
  }

  function getEditableRoot(el) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el;
    let root = el;
    while (root.parentElement && root.parentElement.isContentEditable) {
      if (root.parentElement === document.body || root.parentElement === document.documentElement) break;
      root = root.parentElement;
    }
    return root;
  }

  // hostname and heading only -- these are the two fields background.js reads
  // into the model's context line. document.title was collected and sent on
  // every request without ever being used.
  function getPageContext() {
    const hostname = window.location.hostname;
    const heading = (focusedEditable?.closest("article, section, main, [role='main']")
      ?.querySelector("h1, h2, h3")?.textContent?.trim() || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80);
    return { hostname, heading };
  }

  // Settings-listener registration waits until a field is actually focused.
  // This script is injected into every frame -- all_frames is required for
  // iframe-based editors -- and the overwhelming majority of those frames (ads,
  // trackers, embeds) never contain an editable element. Loading eagerly cost
  // two storage IPCs per frame on every page load, each one waking the service
  // worker, for settings nothing in that frame would ever read.
  let settingsPromise = null;

  function loadSettings() {
    if (settingsPromise) return settingsPromise;
    settingsPromise = new Promise((resolve) => {
      try {
        chrome.storage.onChanged.addListener((changes) => {
          if (changes.sentenceDebug) sentenceDebug = !!changes.sentenceDebug.newValue;
          // Consent is computed in background.js from the top-level origin, so
          // it cannot be recomputed here -- re-ask instead. Revoking has to take
          // effect without a reload; this is the path that writes to the field.
          // The speed check's verdict and the Ollama URL are part of consent
          // too (a stale verdict, a new URL): a result waiting for a pause is
          // dropped with the rest (the configuration generation check).
          if (changes.sentenceMode || changes.sentenceModeDisabledSites || changes.disabledSites
              || changes.setupQualification || changes.ollamaUrl) {
            invalidateSentenceConsent();
          }
        });
        resolve();
      } catch {
        // Extension context gone -- chrome.storage disappears with
        // chrome.runtime. Unblock every awaiting caller rather than leaving the
        // promise pending forever, and record WHY: this is usually the first
        // call an orphaned script makes, so it is the first chance to know.
        markContextDead();
        resolve();
      }
    });
    return settingsPromise;
  }

  // --- Shared by the sentence path ---
  //
  // Sentence delivery, undo, the flash and changedRanges/joinRanges all use these
  // helpers. They were extracted intact before the manual rewrite UI was removed.

  // Nothing here checks whether recording is on -- background.js owns that
  // decision and drops outcomes for requests it never recorded. Keeping it in
  // one place means content.js cannot leak by forgetting to ask.
  function reportOutcome(requestId, verdict, finalText) {
    if (!requestId) return;
    const msg = { type: "REWRITE_OUTCOME", requestId, verdict };
    if (typeof finalText === "string") msg.finalText = finalText;
    sendMessage(msg);
  }

  function announceToScreenReader(message) {
    let live = document.getElementById("proofer-sr-live");
    if (!live) {
      live = document.createElement("span");
      live.id = "proofer-sr-live";
      live.setAttribute("aria-live", "polite");
      live.setAttribute("role", "status");
      live.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;";
      document.documentElement.appendChild(live);
    }
    live.textContent = message;
  }

  function computeWordDiff(original, rewritten) {
    const wordsA = original.split(/(\s+)/);
    const wordsB = rewritten.split(/(\s+)/);
    const result = [];
    let ia = 0, ib = 0;

    while (ia < wordsA.length && ib < wordsB.length) {
      if (wordsA[ia] === wordsB[ib]) {
        result.push({ type: "same", text: wordsA[ia] });
        ia++; ib++;
        continue;
      }
      // Greedy lookahead: try to find wordsA[ia] in wordsB ahead (up to 10)
      let foundB = -1;
      for (let look = 1; look <= 10 && ib + look < wordsB.length; look++) {
        if (wordsB[ib + look] === wordsA[ia]) { foundB = ib + look; break; }
      }
      let foundA = -1;
      for (let look = 1; look <= 10 && ia + look < wordsA.length; look++) {
        if (wordsA[ia + look] === wordsB[ib]) { foundA = ia + look; break; }
      }

      if (foundB >= 0 && (foundA < 0 || foundB - ib <= foundA - ia)) {
        // Insertion in B
        while (ib < foundB) { result.push({ type: "ins", text: wordsB[ib] }); ib++; }
      } else if (foundA >= 0) {
        // Deletion from A
        while (ia < foundA) { result.push({ type: "del", text: wordsA[ia] }); ia++; }
      } else {
        // Single replacement
        result.push({ type: "del", text: wordsA[ia] });
        result.push({ type: "ins", text: wordsB[ib] });
        ia++; ib++;
      }
    }
    while (ia < wordsA.length) { result.push({ type: "del", text: wordsA[ia] }); ia++; }
    while (ib < wordsB.length) { result.push({ type: "ins", text: wordsB[ib] }); ib++; }
    return result;
  }

  // --- CE text extraction ---

  const BLOCK_TAGS = new Set([
    "DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6",
    "PRE", "BLOCKQUOTE", "TR", "TD", "TH", "TABLE",
  ]);

  function buildSegmentsForElement(root) {
    const segments = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue || "";
        if (value) segments.push({ type: "text", node, value });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.tagName === "BR") { segments.push({ type: "break" }); return; }
      for (const child of node.childNodes) walk(child);
      if (BLOCK_TAGS.has(node.tagName) && node !== root) segments.push({ type: "break" });
    };
    walk(root);

    let text = "";
    const spans = [];
    for (const seg of segments) {
      const start = text.length;
      if (seg.type === "text") {
        text += seg.value;
        spans.push({ type: "text", node: seg.node, start, end: text.length });
      } else {
        text += "\n";
        spans.push({ type: "break", start, end: text.length });
      }
    }
    return { text, spans };
  }

  function rangeForInnerTextOffset(root, offset, length, segments) {
    const { text, spans } = segments || buildSegmentsForElement(root);
    if (offset < 0 || length <= 0) return null;
    const endOffset = offset + length;
    if (endOffset > text.length) return null;

    let startNode = null, startInNode = 0, endNode = null, endInNode = 0;

    for (const sp of spans) {
      if (sp.type !== "text") continue;
      if (startNode === null && offset >= sp.start && offset <= sp.end) {
        startNode = sp.node;
        startInNode = offset - sp.start;
      }
      if (endNode === null && endOffset >= sp.start && endOffset <= sp.end) {
        endNode = sp.node;
        endInNode = endOffset - sp.start;
      }
      if (startNode && endNode) break;
    }

    // Snap break-boundary offsets to nearest adjacent text node
    if (!startNode) {
      for (let i = 0; i < spans.length; i++) {
        if (spans[i].type !== "break" || offset < spans[i].start || offset >= spans[i].end) continue;
        for (let j = i - 1; j >= 0; j--) {
          if (spans[j].type === "text") { startNode = spans[j].node; startInNode = spans[j].node.nodeValue.length; break; }
        }
        if (!startNode) {
          for (let j = i + 1; j < spans.length; j++) {
            if (spans[j].type === "text") { startNode = spans[j].node; startInNode = 0; break; }
          }
        }
        break;
      }
    }
    if (!endNode) {
      for (let i = 0; i < spans.length; i++) {
        if (spans[i].type !== "break" || endOffset < spans[i].start || endOffset > spans[i].end) continue;
        for (let j = i + 1; j < spans.length; j++) {
          if (spans[j].type === "text") { endNode = spans[j].node; endInNode = 0; break; }
        }
        if (!endNode) {
          for (let j = i - 1; j >= 0; j--) {
            if (spans[j].type === "text") { endNode = spans[j].node; endInNode = spans[j].node.nodeValue.length; break; }
          }
        }
        break;
      }
    }

    if (!startNode || !endNode) return null;
    const range = document.createRange();
    try {
      range.setStart(startNode, startInNode);
      range.setEnd(endNode, endInNode);
      return range;
    } catch { return null; }
  }

  // --- domOffsetToTextOffset ---

  function domOffsetToTextOffset(container, offset, spans) {
    if (container.nodeType === Node.TEXT_NODE) {
      for (const span of spans) {
        if (span.type === "text" && span.node === container) {
          return span.start + Math.min(offset, span.end - span.start);
        }
      }
      return null;
    }

    if (container.nodeType === Node.ELEMENT_NODE) {
      const children = container.childNodes;

      if (offset >= children.length) {
        for (let i = spans.length - 1; i >= 0; i--) {
          const span = spans[i];
          if (span.type === "text" && container.contains(span.node)) return span.end;
          if (span.type === "break") {
            const prev = i > 0 ? spans[i - 1] : null;
            const next = i < spans.length - 1 ? spans[i + 1] : null;
            if ((prev?.type === "text" && container.contains(prev.node)) ||
                (next?.type === "text" && container.contains(next.node))) {
              return span.end;
            }
          }
        }
        return null;
      }

      const targetChild = children[offset];

      if (targetChild.nodeType === Node.TEXT_NODE) {
        for (const span of spans) {
          if (span.type === "text" && span.node === targetChild) return span.start;
        }
      }

      if (targetChild.nodeName === "BR") {
        for (let i = 0; i < spans.length; i++) {
          const span = spans[i];
          if (span.type === "break") {
            const prevText = findPrevTextSpan(spans, i);
            const nextText = findNextTextSpan(spans, i);
            if (prevText && isBeforeInDOM(prevText.node, targetChild) &&
                (!nextText || isBeforeInDOM(targetChild, nextText.node))) {
              return span.start;
            }
          }
        }
      }

      for (const span of spans) {
        if (span.type === "text" && targetChild.contains(span.node)) return span.start;
      }

      if (targetChild.childNodes.length > 0) {
        return domOffsetToTextOffset(targetChild, 0, spans);
      }
      return null;
    }

    return null;
  }

  function findPrevTextSpan(spans, index) {
    for (let i = index - 1; i >= 0; i--) {
      if (spans[i].type === "text") return spans[i];
    }
    return null;
  }

  function findNextTextSpan(spans, index) {
    for (let i = index + 1; i < spans.length; i++) {
      if (spans[i].type === "text") return spans[i];
    }
    return null;
  }

  function isBeforeInDOM(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // ===========================================================================
  // Sentence mode
  // ===========================================================================
  //
  // Proofread each sentence as the user finishes it, conditioned on everything
  // they have written so far, and put the correction in behind the caret while
  // they type the next one. See ARCHITECTURE.md.
  //
  // TEXTAREA, plus a contenteditable whose editor is in SN_TRANSPORTS -- see
  // sentenceEligibleEl and editorAdapterFor. This started textarea-only, and
  // each of the three reasons was answered rather than waived:
  // setSelectionWithSync's microtask + rAF + 16ms selection window is gone
  // (spliceSentenceCE sets the range and inserts in one tick, and the Slate
  // path buffers and replays anything typed during the ~30ms settle behind its
  // write, and yields the window to anything it cannot replay); "does this
  // sentence cross a bold run" is answered by snRangeIsUniform rather than by
  // the segment spans; and the uncacheable segment walk is simply paid, with
  // SENTENCE_CE_MAX_CHARS bounding it.
  //
  // Writing to a rich editor means getting its own model to agree, so every
  // family in the registry is there because it was measured on the real editor
  // -- a Slate-shaped fixture cannot demonstrate that for anything.
  //
  // Refusal is not silence. A field the mode cannot use records WHY in
  // sentenceStatus, and the popup reports it: the mode attaching to nothing and
  // saying nothing is indistinguishable from a broken extension. Surface the
  // refusal so users can tell an unsupported editor from a failed request.

  const MIN_SENTENCE_CHARS = 10;      // asserted equal to background.js's copy
  const SENTENCE_MAX_CHARS = 500;
  // Characters typed past the terminator before the finished sentence is sent.
  // Small on purpose: "edits behind you" means the fix lands a few characters
  // into the next sentence, not after it.
  const SENTENCE_TRIGGER_CHARS = 3;
  // The pause path, and the only one that catches the last sentence before Send.
  const SENTENCE_IDLE_MS = 600;
  // The largest EDIT that can plausibly be one keystroke.
  //
  // The original 25 came from "nobody types 25 characters between two input
  // events", which was reasoning about net length growth. Against a real
  // prefix/suffix diff the right number is far smaller, because a keystroke is
  // exactly one character: at 25, a silently assigned `.value = "This sentance
  // is wrong."` (23) was still treated as typing and proofread. 8 leaves room
  // for a surrogate pair or a short batched insertion and nothing else.
  const SENTENCE_BULK_CHARS = 8;
  const SENTENCE_CONTEXT_CHARS = 2500;
  const SENTENCE_MAX_JOB_MS = 5000;
  // The flash is now the ONLY signal that a silent correction happened, so it
  // has to outlast a glance. 600ms was tuned when a chip sat next to it for
  // four seconds; on its own it was over before the eye reached the word.
  const SENTENCE_FLASH_MS = 1600;
  const SENTENCE_BREAKER_BASE_MS = 30000;
  const SENTENCE_BREAKER_MAX_MS = 300000;
  // Minimum spacing between SENTENCE_WARMUP pings. The warmup is a typing
  // LEASE since 2026-08-25: the sentence path's keep_alive is 20s (down from a
  // shared 90s), so residency is held by renewal rather than by a long tail --
  // ping while keystrokes flow, and the runner unloads ~20s after they stop.
  // The first keystroke after a pause still warms (its ping is by definition
  // past the throttle), and continuous typing now DOES re-fire it, on purpose:
  // a long sentence puts 20s+ between requests, which is exactly the lease,
  // so the requests alone no longer keep the runner up. background.js dedups
  // every ping against SENTENCE_WARM_STALE_MS, and the invariant that keeps a
  // renewal inside the lease -- stale + renew < keep_alive -- is asserted
  // cross-file by sentence-settings-test.mjs.
  const SENTENCE_WARM_RENEW_MS = 10000;
  // How long to keep looking for the editor to apply an edit we saw announced.
  // Same shape and same ceiling as the write verification poll, for the same
  // reason: React and Slate re-render on a task boundary, so the gap can be
  // made small and cannot be closed.
  const SN_OBSERVE_SETTLE_MS = 30;

  // Input types that mean "this was not typed". None of them is sufficient on
  // its own -- see onSentenceInput -- but each is a free signal.
  const BULK_INPUT_TYPES = new Set([
    "insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop",
    "insertFromYank", "insertReplacementText", "insertTranspose",
    "historyUndo", "historyRedo",
  ]);

  const hasSegmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function";

  let sentenceAllowed = false;
  let sentenceDebug = false;
  let sentenceConsentPromise = null;
  let sentenceTrack = null;        // { el, watermark, prefix, lastText }
  let sentenceJob = null;          // the one in-flight request for this frame
  let sentenceIdleTimer = null;
  let sentenceBreakerUntil = 0;
  let sentenceBreakerFails = 0;
  let sentenceSkipCounts = Object.create(null);
  let sentenceSkipTimer = null;
  // Distinct editable fields this frame has already tallied. Coverage is a
  // question about FIELDS, not focus events: without this, clicking in and out
  // of one unsupported editor inflates the numerator while the denominator
  // stands still, and the answer gets worse the more the user fights it.
  const sentenceSeenFields = new WeakSet();
  let sentenceWarmSentAt = 0;      // module-level throttle, see maybeWarmSentenceModel
  let sentenceUndo = null;         // { el, requestId, start, endAfter, before, after }
  let sentenceFlashTeardown = null;
  let sentenceFlashGuard = null;   // what must stay true for the overlay to be correct
  let sentenceEditWatcher = null;
  let sentenceComposing = false;   // an IME session is open on the tracked field
  let sentenceDeferred = null;     // { job, replacement } — a silent apply waiting for a pause
  let sentenceDeferTimer = null;
  // An apply that is past its write and has not yet installed the watermark.
  //
  // `applySentence` must await the splice -- the INTENT recipe cannot be
  // synchronous -- so between the write landing and `setWatermark` the field
  // holds the CORRECTION while the watermark still holds the PRE-correction
  // offset. `fireSentenceRequest` chains straight into `maybeFireSentence` in
  // that window, and on a correction that SHORTENS the sentence the chained
  // scan targets a fragment: measured, `The the report was late.` corrected
  // while `We recieved the invoice yesterday.` was finished produced a request
  // for `recieved the invoice yesterday.`
  //
  // This is the documented CRITICAL pattern -- advancing an offset from a
  // captured value across an async boundary -- reached from the other side, and
  // it was introduced by routing the textarea splice through an `async`
  // function: that path used to have no await at all before the watermark went
  // in. Same shape as `sentenceDeferred`, same answer: stand down, and re-run
  // the scan once the two agree again.
  let sentenceApplying = false;
  // Fields we have stopped writing to, and WHY. One strike and we stop writing
  // to it for the rest of the session. Keyed on the element, which does NOT
  // survive React replacing the composer -- which is why the durability veto
  // also demotes the whole family, see sentenceDemotedFamilies.
  //
  // A WeakMap rather than a WeakSet, for exactly the reason sentenceDemotedFamilies
  // is a Map rather than a Set: a set records THAT we refused and loses the
  // cause, so sentenceFieldStatus had nothing to report but a hardcoded
  // `write-rejected`. "The editor refused the write" and "the write landed and
  // the page reconciled it away" then read identically in the popup, and that
  // misattribution sent two readers to the wrong branch in a single day. A
  // diagnostic that names a cause it did not observe is worse than one that
  // says nothing -- it is the "reporting a messaging failure as a service
  // failure" pattern, one level down.
  const sentenceBlockedEls = new WeakMap();

  // --- Status --------------------------------------------------------------
  //
  // What sentence mode is doing in this frame, in the words the popup reports.
  // The whole reason this exists: on a ProseMirror composer the mode attached
  // to nothing and said nothing -- no chip, no flash, no warmup, no log line,
  // no error -- and from outside that is indistinguishable from a broken
  // extension. A curated allowlist is defensible; one that never says it
  // refused is not.
  //
  //   off                mode switched off here (globally, per site, or the site is disabled)
  //   no-field           nothing eligible is focused
  //   field-detached     the field was removed before the write could be checked
  //   unsupported-editor an editable was focused and we cannot write to it
  //   unsafe-range       the last sentence crossed markup, an atom or a block
  //   session-blocked    a write was rejected or reverted; we stopped
  //   active             attached and running
  let sentenceStatus = { status: "off", detail: null, family: null };
  // The last verdict about an actual FIELD, kept across blur. Focusing the
  // composer and then opening the popup blurs it, so a live status of
  // `no-field` is the normal way to arrive -- and answering "nothing is
  // focused" to someone asking why their editor does nothing is the same
  // silence in a different costume.
  let sentenceLastField = null;

  function setSentenceStatus(status, detail, family) {
    sentenceStatus = { status, detail: detail || null, family: family || null };
    if (status !== "off" && status !== "no-field") {
      sentenceLastField = { ...sentenceStatus, at: Date.now() };
    }
    sentenceLog("status", status, detail || "");
  }

  function markSentenceFieldDetached(el, lastField) {
    const family = sentenceFieldStatus(el).family;
    const replaced = sentenceLastField !== lastField
      || (sentenceTrack && sentenceTrack.el !== el)
      || (focusedEditable && focusedEditable !== el);
    if (sentenceTrack && sentenceTrack.el === el) teardownSentence();
    if (focusedEditable === el) focusedEditable = null;
    // The splice awaited the editor. A newer attachment (even if it has since
    // blurred) or withdrawn consent owns the status now.
    if (!sentenceAllowed || replaced) return;
    setSentenceStatus("field-detached", "detached", family);
  }

  /**
   * Blocks that also DEMOTE the whole transport family, not just this element.
   *
   * The test is epistemic, not how bad the outcome looked: did the editor tell
   * us it had done what we asked when it had not? `not-durable` accepted the
   * write and discarded it on the next keystroke; `wrote-elsewhere` accepted it
   * and put the text somewhere else. Both are the transport lying, and both
   * recur for every later sentence, so the fingerprint is what has to be
   * withdrawn.
   *
   * `write-rejected`, `write-normalized` and `reconciled` are deliberately NOT
   * here. Refusal, an honored span with changed surroundings, and page
   * reconciliation stop this element without condemning the next one.
   */
  const DEMOTING_BLOCKS = new Set(["not-durable", "wrote-elsewhere"]);

  /**
   * Stop writing to this field, and say so.
   *
   * A `why` in DEMOTING_BLOCKS also demotes the transport for the rest of this
   * injection. The element-keyed WeakMap is not enough on its own: React
   * replacing the composer hands us a new element and silently clears the veto,
   * so an editor that discards our writes would be rediscovered once per
   * remount. Demotion is one-way -- an uncertified editor is never authorized
   * by observed success, because that trades "zero silent bad writes" for "one
   * per editor, probably once", and "probably once" is not defensible when
   * fingerprints collide and apps redeploy.
   */
  function blockSentenceField(el, why) {
    // FIRST cause wins. The first block is the observation that stopped this
    // field; anything after it is downstream of a field we had already given up
    // on, and overwriting would answer "why did it stop" with the last thing
    // that happened rather than the thing that happened. A later cause that
    // matters more is not lost either way: both DEMOTING_BLOCKS causes are
    // reported off sentenceDemotedFamilies, which sentenceFieldStatus checks
    // first.
    if (el && !sentenceBlockedEls.has(el)) sentenceBlockedEls.set(el, why || "write-rejected");
    const family = el ? sentenceFieldStatus(el).family : null;
    if (DEMOTING_BLOCKS.has(why) && family) sentenceDemotedFamilies.set(family, why);
    if (sentenceTrack && sentenceTrack.el === el) teardownSentence();
    setSentenceStatus("session-blocked", why, family);
  }

  function sentenceLog(...args) {
    if (sentenceDebug) console.log("[Proofer sentence]", ...args);
  }

  // --- Segmentation --------------------------------------------------------
  //
  // Intl.Segmenter is the base and is not sufficient. It is right about
  // decimals, URLs, foo.bar() and ellipses (ICU rule SB8 suppresses a break
  // when the next letter is lowercase) and wrong about every abbreviation
  // followed by a capitalised word -- "Dr. Smith" and "J. R. R. Tolkien" both
  // split. ICU's own fix is sentence break suppressions, which are NOT
  // reachable from JS: "en-u-ss-standard" is silently dropped by Chrome and
  // Node alike. So the suppression pass lives here.

  const ABBREVIATIONS = new Set([
    // titles / honorifics
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "rev", "hon",
    "gen", "col", "capt", "lt", "sgt", "messrs",
    // business / address
    "inc", "ltd", "co", "corp", "dept", "est", "apt", "ave", "blvd", "rd",
    // latin / reference
    "e.g", "i.e", "cf", "etc", "vs", "viz", "al", "ibid", "op", "ref",
    "fig", "eq", "ch", "sec", "vol", "pp", "tab", "approx", "min", "max",
    // units. "Take 5 mg. daily with food." split after "mg." once lowercase
    // starts became real boundaries.
    "mg", "ml", "kg", "lb", "oz", "ft", "in", "cm", "mm", "km", "hr", "sec", "hrs",
    // months / days
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "mon", "tue", "tues", "wed", "thu", "thurs", "fri", "sat", "sun",
  ]);

  // Straight single quotes are ambiguous: the same character is an apostrophe
  // ("don't"), a possessive ("clients'") and a quotation mark ("he said 'no'").
  // Blanket-removing every quote preceded by a word character fixed
  // contractions but broke `He called it 'fine' yesterday.` -- the closing
  // quote vanished, the opener looked unmatched, and the next boundary was
  // suppressed.
  //
  // So count OPENERS and CLOSERS rather than parity, and only suppress when
  // openers exceed closers. A possessive ("clients' ") reads as a stray closer,
  // which is harmless; an actually-unclosed quotation reads as a stray opener,
  // which is what must suppress the break.
  // An opener may follow punctuation as well as whitespace -- `He said:'this is
  // fine.` was not recognised, so the veto did not fire and the break landed
  // inside the quotation. And a quote followed by a DIGIT is a decade, not an
  // opener: `Music from the '90s was loud.` read as permanently unclosed and
  // suppressed every boundary after it.
  const SQ_OPEN = /(?:^|[\s([{:;,])['‘](?![0-9])/g;
  const SQ_CLOSE = /['’](?:$|[\s.,;:!?)\]}])/g;
  const DQ = /["“”«»]/g;
  const LIST_MARKER = /^\s*\(?[0-9]{1,3}[.)]\s*$|^\s*\(?[a-zA-Z][.)]\s*$/;
  // Trailing closing punctuation, stripped before the abbreviation test so that
  // `(e.g.)` and `"etc."` are still recognised.
  const TRAILING_CLOSERS = /[)\]}"'”’»]+$/;

  // A URL is one token, whatever punctuation sits inside it. Intl.Segmenter is
  // right about the dots in a hostname and knows nothing about a query string:
  // an unmasked query such as `...?page=2&sort=newest` can break after the
  // `?`, leaving a second "sentence" that contains only the query parameters
  // on their own -- a request spent on a target with no words in it, and a
  // splice offered over text the user never wrote as prose.
  //
  // So mask every URL to a run of `x` of the SAME LENGTH before segmenting, and
  // slice the segment text back out of the ORIGINAL string afterwards. Equal
  // lengths are the whole trick: every offset the anchor and the splice depend
  // on stays exact, and no pass below has to know URLs exist.
  //
  // Trailing punctuation is deliberately left OUTSIDE the span. `\S+` is
  // greedy, so `Go to https://example.com. Then leave.` would otherwise swallow
  // the terminator and never break at all.
  const URL_SPAN = /https?:\/\/\S+/gi;
  const URL_TRAILING = /[.,;:!?'"”’)\]}]+$/;

  function maskUrls(text) {
    if (text.indexOf("://") === -1) return text;
    let out = "";
    let last = 0;
    let m;
    URL_SPAN.lastIndex = 0;
    while ((m = URL_SPAN.exec(text)) !== null) {
      const len = m[0].replace(URL_TRAILING, "").length;
      if (!len) continue;
      out += text.slice(last, m.index) + "x".repeat(len);
      last = m.index + len;
    }
    return last ? out + text.slice(last) : text;
  }

  function endsWithAbbreviation(text) {
    // Strip closing punctuation FIRST, then look for the period. Testing
    // endsWith(".") on the raw text missed `(e.g.)` and `"etc."`.
    const trimmed = text.trimEnd().replace(TRAILING_CLOSERS, "");
    if (!trimmed.endsWith(".")) return false;
    const lastWord = (trimmed.match(/([^\s]+)$/) || ["", ""])[1].replace(/^[("'“‘]+/, "");
    // "e.g." and "i.e." keep their internal dot; everything else drops the final one
    const bareWord = lastWord.replace(/\.$/, "").toLowerCase();
    if (ABBREVIATIONS.has(bareWord)) return true;
    // Single-letter initial: "J." "R." -- but not "a." at the start of a list
    // item, which LIST_MARKER handles separately.
    if (/^[A-Za-z]\.$/.test(lastWord)) return true;
    // Repeated letter-dot forms: a.m. p.m. U.S. U.K. Ph.D. -- generic, so the
    // word list does not have to enumerate them. The component is 1-2 letters,
    // not 1: `(?:[A-Za-z]\.){2,}` cannot match "Ph.D." because "Ph." has two,
    // so "She earned a Ph.D. in physics." split after "Ph.D." The comment here
    // claimed the coverage; the test only ever exercised p.m. and U.S.
    if (/^(?:[A-Za-z]{1,2}\.){2,}$/.test(lastWord)) return true;
    return false;
  }

  // A period between two digits is a decimal point, never a terminator: 5.6,
  // 176.2, v1.2.3, 192.168.1.1. Intl.Segmenter already gets that right (ICU
  // rule SB6, ATerm x Numeric) and no pass below can undo it -- pass 1 only
  // merges, and LOWER_BREAK needs whitespace before the next word, which a
  // decimal does not have. So there is nothing to add here for finished text;
  // sentence-split-test.mjs pins it instead, because the segmenter leans on it
  // and a silent ICU change would look like a corruption bug somewhere else.
  //
  // The HALF-TYPED decimal is the case no segmenter can settle, because the
  // deciding character has not been typed yet. `The reading was 176.` and
  // `The reading was 176.2 across the run.` are the same string at the moment
  // the user pauses mid-number, and the idle path fires with no lookahead at
  // all. Measured: it proofread `The reading was 176.` and then handed the
  // model the fragment `2 across the run.` So a trailing digit-period is a
  // weak boundary, exactly like `Refer to Fig.` -- do not advance, and let the
  // next character decide.
  //
  // Only a bare `.` at the very end: `176!` is unambiguous, and a closer after
  // the period (`(it was 176.)`) means the number is already finished. The
  // cost is a sentence that genuinely ends in a number AND is the last thing
  // typed before the message is sent -- 7 of 1081 real Discord sentences end
  // `<digit>.` against 19 that contain a decimal, and for any of them with more
  // writing after it the refusal is a deferral rather than a loss.
  function endsMidNumber(text) {
    return /\d\.$/.test(String(text || "").trimEnd());
  }

  function hasUnbalancedOpener(text) {
    const open = (text.match(/[([]/g) || []).length;
    const close = (text.match(/[)\]]/g) || []).length;
    if (open > close) return true;
    // Double and guillemet quotes: plain parity is right, they are unambiguous.
    if (((text.match(DQ) || []).length) % 2 === 1) return true;
    // Single quotes: openers vs closers, not parity (see SQ_OPEN / SQ_CLOSE).
    return (text.match(SQ_OPEN) || []).length > (text.match(SQ_CLOSE) || []).length;
  }

  /**
   * Split `text` into sentences.
   * Returns [{ text, start, end }] over the ORIGINAL string, with trailing
   * whitespace included in `text` (so the pieces concatenate back to the input)
   * but `end` reported at the last non-space character.
   *
   * `mergeTrailingRunt: false` leaves a too-short FINAL fragment as its own
   * segment instead of folding it into its predecessor. The trigger needs that:
   * while the next sentence is being typed it is a runt, and merging it
   * backward would hide the completed sentence in front of it until the new one
   * reached MIN_SENTENCE_CHARS -- so the fix would land ten characters late
   * instead of three.
   */
  function segmentSentences(text, opts) {
    const minChars = opts && typeof opts.minChars === "number" ? opts.minChars : MIN_SENTENCE_CHARS;
    const mergeTrailingRunt = !(opts && opts.mergeTrailingRunt === false);
    if (typeof text !== "string" || !text.trim()) return [];
    if (!hasSegmenter) return [];

    // Every pass below runs on the masked copy; only the final map reads the
    // original. The passes merge and slice contiguously, so each output segment
    // is still exactly [start, start + text.length) in both strings.
    const masked = maskUrls(text);
    const seg = new Intl.Segmenter("en", { granularity: "sentence" });
    const raw = [...seg.segment(masked)].map((s) => ({ text: s.segment, start: s.index }));

    // Pass 1: merge segments back into their predecessor where ICU broke wrongly.
    const merged = [];
    for (const s of raw) {
      const prev = merged.length ? merged[merged.length - 1] : null;
      const join = !!prev && (endsWithAbbreviation(prev.text) || LIST_MARKER.test(prev.text)
        || hasUnbalancedOpener(prev.text));
      if (join) prev.text += s.text;
      else merged.push({ text: s.text, start: s.start });
    }

    // Pass 1b: split where ICU declined to because the next letter is lowercase.
    const split = [];
    for (const s of merged) split.push(...splitLowercaseStarts(s));

    // Pass 2: merge anything too short to stand alone FORWARD into the next
    // sentence. A two-word fragment gives the model nothing to work with and is
    // usually a segmentation artifact; attaching it to its neighbour keeps the
    // text fully covered rather than skipping it.
    const out = [];
    let pending = null;
    for (const s of split) {
      if (pending) {
        s.text = pending.text + s.text;
        s.start = pending.start;
        pending = null;
      }
      if (s.text.trim().length < minChars) { pending = s; continue; }
      out.push(s);
    }
    if (pending) {
      if (out.length && mergeTrailingRunt) out[out.length - 1].text += pending.text;
      else out.push(pending);
    }

    return out.map((s) => {
      const real = text.slice(s.start, s.start + s.text.length);
      return {
        text: real,
        start: s.start,
        end: s.start + real.replace(/\s+$/, "").length,
      };
    });
  }

  // ICU rule SB8 suppresses a break when the next letter is lowercase. That is
  // right for "Wait... but continue" and "Use e.g. apples", and wrong for
  // anyone who writes without capitals -- which is most people in a chat box.
  //
  // It is not a rounding error. Measured over the sentence corpus: lowercasing
  // sentence starts drops boundary coverage from 95% to 23%, so a chat-style
  // writer would have five sentences handed to the model as a single blob, and
  // a long enough run would exceed maxTargetChars and never be proofread at all.
  //
  // So split those back out -- minus the three cases SB8 actually exists for.
  const LOWER_BREAK = /([.!?]+)(["'”’)\]}»]*)(\s+)(?=[a-z])/g;

  function splitLowercaseStarts(seg) {
    const out = [];
    let last = 0;
    let m;
    LOWER_BREAK.lastIndex = 0;
    while ((m = LOWER_BREAK.exec(seg.text)) !== null) {
      const upTo = seg.text.slice(last, m.index + m[1].length + m[2].length);
      // An ellipsis is a continuation, not a terminator; an abbreviation is not
      // a sentence end at all; and a break inside an open quotation would hand
      // the model half of someone's quoted sentence -- which it will happily
      // "correct" into something that passes every output guard.
      if (/(?:\.\.\.|…)$/.test(upTo.trimEnd())) continue;
      if (endsWithAbbreviation(upTo)) continue;
      if (hasUnbalancedOpener(upTo)) continue;
      const cut = m.index + m[0].length;
      out.push({ text: seg.text.slice(last, cut), start: seg.start + last });
      last = cut;
    }
    if (!out.length) return [seg];
    out.push({ text: seg.text.slice(last), start: seg.start + last });
    return out;
  }

  function endsSentence(s) {
    return /[.!?]["'”’)\]}»]*\s*$/.test(s);
  }

  // --- Trigger -------------------------------------------------------------

  /**
   * The next sentence eligible for proofreading at or after `watermark`, or
   * null to wait. Pure, so sentence-anchor-test.mjs can drive the whole
   * decision table without a browser.
   *
   * `fromIdle` picks between the two trigger paths:
   *   false -- the user has typed past the terminator, so the segmenter had
   *            lookahead and its boundary decision is trustworthy
   *   true  -- 600ms of nothing, no lookahead at all, so anything that could
   *            still be mid-sentence has to be refused. "Refer to Fig." plus a
   *            pause looks exactly like a finished sentence.
   *
   * A returned target carries `trigger`, which names the EVIDENCE that the
   * sentence is finished, not the timer that ran the scan:
   *   "newline"        a newline follows the terminator
   *   "next-sentence"  the user typed SENTENCE_TRIGGER_CHARS or more past it
   *   "idle"           neither -- only the pause says the sentence is done
   * Evidence rather than timer because the two are not the same set: the idle
   * timer also picks up sentences the user HAS typed past, whenever a keystroke
   * scan was skipped (busy, panel open, a chip answered), and those carry the
   * strong evidence however late they are read. On the keystroke path the label
   * is exactly the condition that let the sentence through.
   *
   * It is sent with the request and written to the log record, and exactly one
   * guard reads it: `idle-final-inflection` refuses an edit whose only lexical
   * change is an inflection of the final token when nothing but a pause said
   * the sentence was done. So an inaccurate label here is a wrong VERDICT, not
   * just a wrong log line. See guardSentenceResult in background.js for what was
   * measured, and for the two broader rules the measurement rejected.
   *
   * `opts.structuralTail` says the TRAILING WHITESPACE OF THIS FIELD IS NOT
   * SOMETHING THE USER TYPED, which is true of every contenteditable and of no
   * textarea. buildSegmentsForElement synthesises a "\n" per block boundary
   * including the last one, so a rich editor's text ends in a newline whether or
   * not anybody pressed Enter -- and Draft, which wraps each block twice, ends in
   * two. Measured against this function: `"The techncian arrived early."` returns
   * null on a textarea and fired as `newline` with the trailing "\n" a
   * contenteditable always has. Every sentence on every certified family was
   * therefore labelled `newline`, and no other trigger was reachable there.
   *
   * That cost three things, none of them cosmetic. The sentence went out with
   * ZERO LOOKAHEAD while claiming the strongest evidence there is. The
   * weak-boundary refusals were bypassed outright -- they are asked only where
   * there is no lookahead -- so `"Please refer to Fig."` was proofread as a
   * finished sentence on every rich editor while a textarea correctly waited.
   * And the label is a GUARD INPUT: `idle-final-inflection` fires only on
   * `idle`, so a measured protection was silently off on every contenteditable.
   *
   * WHAT CHANGED IS THE STANDARD, NOT THE TIMING. The evidence is now measured
   * against `after` with its trailing whitespace stripped, so a structural
   * boundary proves nothing -- but a contenteditable whose sentence is the last
   * thing in the field still fires on the keystroke that finished it, exactly as
   * it does today, and is held to the no-lookahead standard instead: the three
   * weak boundaries are refused, and it is labelled `idle`. Making it WAIT for
   * the 600ms timer instead was the other candidate and is a worse trade -- it
   * would delay every rich-editor sentence, and in a chat client the message is
   * often sent inside that window, so the commonest sentence there is not
   * proofread late but not at all. Nothing enumerated is bought by the wait: the
   * three shapes above are the known ways a no-lookahead boundary is wrong, and
   * they are now refused here whichever scan arrived.
   */
  function nextSentenceTarget(text, watermark, fromIdle, opts = {}) {
    const tail = text.slice(watermark);
    if (!tail.trim()) return null;
    const segs = segmentSentences(tail, { mergeTrailingRunt: false });
    if (!segs.length) return null;
    const first = segs[0];

    // Leading whitespace is excluded from the target so the span the model is
    // given and the span spliced back are the same string.
    const lead = first.text.length - first.text.replace(/^\s+/, "").length;
    const start = watermark + first.start + lead;
    const end = watermark + first.end;
    if (end <= start) return null;

    const sentence = text.slice(start, end);
    if (!endsSentence(sentence)) return null;                       // still being written
    if (sentence.length < MIN_SENTENCE_CHARS) return null;          // will merge forward
    if (sentence.length > SENTENCE_MAX_CHARS) return { skip: "too-long", end };
    // A target has to be language. Strip the URLs first and then ask for two
    // words of two letters or more: a pasted link is not prose, and the model
    // has nothing to say about it that is worth a round trip -- or worth the
    // chance of a splice. The count is over WORDS ANYWHERE, not two adjacent
    // ones: `I don't know.` has no two multi-letter words separated by a space
    // and is an ordinary sentence.
    const prose = sentence.replace(URL_SPAN, " ");
    if ((prose.match(/[A-Za-z]{2,}/g) || []).length < 2) return { skip: "no-words", end };

    // Trailing whitespace is stripped before the evidence is read, on a field
    // whose trailing whitespace is structure rather than typing. It is one
    // stripping and not two rules: it takes the phantom newline out of
    // `newlineAfter`, and it stops the same phantom counting as a character the
    // user typed -- which fired a contenteditable one character earlier than a
    // textarea, and on Draft, whose tail is "\n\n", two.
    const raw = text.slice(end);
    const after = opts.structuralTail ? raw.replace(/\s+$/, "") : raw;
    const ws = (after.match(/^[^\S\n]*/) || [""])[0];
    const typedAfter = after.length - ws.length;
    const newlineAfter = /^[^\S\n]*\n/.test(after);
    // Nothing but structure follows the sentence. There is no lookahead, and on
    // the keystroke path there is also nothing else coming: this IS the last
    // thing in the field.
    const structuralOnly = !!opts.structuralTail && after === "";
    const noLookahead = typedAfter === 0 && !newlineAfter;

    if (!fromIdle) {
      // A field that may still be typed into waits for real evidence -- a
      // newline, or SENTENCE_TRIGGER_CHARS past the terminator. Note this is
      // NOT the same test as `noLookahead`: one or two characters typed past
      // the terminator are lookahead and still not enough, and collapsing the
      // two fired a sentence on the very next keystroke.
      // A contenteditable's last sentence is the exception, and only because
      // the alternative is worse -- see the header: it fires now, exactly as it
      // does today, and takes the idle path's refusals with it.
      const enough = newlineAfter || typedAfter >= SENTENCE_TRIGGER_CHARS;
      if (!enough && !structuralOnly) return null;
    }
    if (noLookahead) {
      // No lookahead exists, so require a strong boundary. When in doubt, wait
      // for continuation -- a sentence proofread late costs nothing, one
      // proofread as a fragment corrupts text. Asked of BOTH paths now: it used
      // to be gated on the idle timer, which is the mechanism that let a
      // structural newline carry an abbreviation straight past it.
      if (endsWithAbbreviation(sentence) || hasUnbalancedOpener(sentence)
        || endsMidNumber(sentence)) {
        return { skip: "weak-boundary", end: null };
      }
    }
    const trigger = newlineAfter ? "newline"
      : (typedAfter >= SENTENCE_TRIGGER_CHARS ? "next-sentence" : "idle");
    return { start, end, sentence, trigger };
  }

  /**
   * Prior context for the model: up to 2500 characters ending at the target,
   * snapped forward to a sentence boundary so it never starts mid-word.
   */
  function sentenceContextFor(text, start) {
    const cut = Math.max(0, start - SENTENCE_CONTEXT_CHARS);
    let ctx = text.slice(cut, start);
    if (cut > 0) {
      const m = ctx.match(/[.!?]["'”’)\]]*\s+/);
      if (m) ctx = ctx.slice(m.index + m[0].length);
    }
    return ctx.trim();
  }

  /**
   * Everything that must still hold at apply time, re-checked synchronously in
   * the same tick as the splice. Returns a reason to refuse, or null to apply.
   *
   * The prefix check carries the design: it permits arbitrary typing AFTER the
   * target and rejects every edit that could shift it, which makes applying to
   * the wrong span impossible. It is byte-for-byte, deliberately stricter than
   * the removed manual path's whitespace-normalised guard -- that was right when a
   * human was looking at a panel, and too weak when offsets drive an invisible write.
   */
  function sentenceAnchorFailure(job, live, caretStart, caretEnd, now, composing) {
    // A composition is a SESSION, bracketed by compositionstart/compositionend
    // -- not a property of one input event. Checking isComposing on the event
    // only skips that event; a response landing mid-session would select and
    // rewrite an earlier sentence while the IME still owns the selection.
    if (composing) return "composing";
    if (job.dirty) return "edited-since-capture";
    if (now - job.capturedAt > SENTENCE_MAX_JOB_MS) return "stale-age";
    if (live.length < job.end) return "shrunk";
    if (live.slice(0, job.end) !== job.prefixThrough) return "prefix-changed";
    if (live.slice(job.start, job.end) !== job.sentence) return "target-changed";
    return sentenceCaretRefusal(caretStart, caretEnd, job.end);
  }

  // The caret half of the anchor, and the SAME three questions the pre-send
  // check asks -- one helper so the two cannot drift on what "inside" means.
  // Strict `<`: a contenteditable's last-sentence trigger fires on the keystroke
  // that finished it, with the caret sitting exactly AT `end`, and that is the
  // chat-client case this whole path exists for. `<=` would suppress it.
  function sentenceCaretRefusal(caretStart, caretEnd, end) {
    if (caretStart == null || caretEnd == null) return "no-caret";
    if (caretStart !== caretEnd) return "selection-active";
    if (caretStart < end) return "caret-inside";
    return null;
  }

  // --- Consent -------------------------------------------------------------

  // Consent is keyed to the TOP-LEVEL origin -- switching a site off has to
  // cover that site's own embedded editors, and a third-party frame must be
  // judged by the page the user is on, not by its own origin (under the opt-in
  // model that frame would have inherited the grant; under the opt-out one it
  // would slip out from under the switch-off). background.js derives that
  // origin from sender.tab.url; nothing here reports it, so there is no origin
  // claim for anything to get wrong.
  function loadSentenceConsent() {
    if (sentenceConsentPromise) return sentenceConsentPromise;
    if (!hasSegmenter) {
      sentenceAllowed = false;
      sentenceConsentPromise = Promise.resolve();
      return sentenceConsentPromise;
    }
    sentenceConsentPromise = Promise.all([
      sendMessage({ type: "SENTENCE_CONSENT" }),
      new Promise((resolve) => {
        try { chrome.storage.local.get({ sentenceDebug: false }, resolve); }
        catch { resolve({}); }
      }),
    ]).then(([r, dbg]) => {
      sentenceAllowed = !!(r && r.ok && r.allowed);
      sentenceDebug = !!(dbg && dbg.sentenceDebug);
      sentenceLog("consent", { allowed: sentenceAllowed });
    });
    return sentenceConsentPromise;
  }

  function invalidateSentenceConsent() {
    sentenceConsentPromise = null;
    sentenceAllowed = false;
    teardownSentence("consent-changed");
    setSentenceStatus("off", "not-allowed", null);
    loadSentenceConsent().then(() => {
      if (focusedEditable) sentenceAttach(focusedEditable);
    });
  }

  // English only: the suppression list is English and the model is tuned on it.
  function isEnglishField(el) {
    let lang = "";
    const langEl = el.closest ? el.closest("[lang]") : null;
    if (langEl) lang = langEl.getAttribute("lang") || "";
    if (!lang) lang = document.documentElement.getAttribute("lang") || "";
    if (!lang) lang = navigator.language || "";
    return /^en(-|$)/i.test(String(lang).trim());
  }

  // A contenteditable large enough to be a document rather than a composer is
  // skipped. snText walks the subtree on every keystroke, and that cost is the
  // one thing about rich editors that does not shrink with care. textContent is
  // a native concatenation, so the check itself is cheap.
  const SENTENCE_CE_MAX_CHARS = 10000;

  // --- The transport registry ----------------------------------------------
  //
  // Two decisions were tangled together in `snIsSlate`, and they are not the
  // same decision:
  //
  //   a FINGERPRINT selects an adapter  -- which write mechanism this editor
  //                                        takes. Cheap and structural.
  //   a CERTIFICATE grants authority    -- whether we may write silently here.
  //                                        Curated, and revocable (Phase 3's
  //                                        durability veto demotes a family).
  //
  // Extending one check that did both jobs felt like whack-a-mole because every
  // new editor needed a new *mechanism* decision and a new *trust* decision.
  //
  // TWO RECIPES, AND THEY ARE OPPOSITES. Measured 2026-08-13, headless Chrome
  // for Testing, each editor's own demo site, keystrokes jittered 22-129ms, at
  // least 4 idle + 4 burst trials per cell and 8 + 8 for anything close. The
  // only assertion that can fail: type more characters afterwards and see
  // whether the correction survives AT THE RIGHT OFFSET.
  //
  //   INTENT    set the DOM range and, in the SAME TICK, dispatch a SYNTHETIC
  //             (untrusted) beforeinput naming that same span on the event --
  //             insertReplacementText with targetRanges: [new StaticRange(range)]
  //             -- and let the EDITOR perform the edit. This is
  //             spliceSentenceSlate. It was "set the DOM range, WAIT
  //             ~SN_CE_SYNC_MS for the editor to read it into its own model,
  //             then dispatch insertText" until 2026-08-13. The wait was the
  //             abort window and naming the range on the event deletes it; the
  //             selection stays because Slate ignores the named range whenever
  //             its node map is dirty, and then writes at the selection instead
  //             (test/slate-intent-probe.mjs phases 3 and 4).
  //   MUTATION  set the DOM range, execCommand("insertText") -- a real, TRUSTED
  //             browser edit -- and restore the caret by checked arithmetic.
  //             One tick, no awaits. This is spliceSentenceCE.
  //
  //   editor                       INTENT                    MUTATION
  //   Slate <= 0.127.1             accepts INTENT           reverts on next key
  //   Slate >= 0.128              untrusted-rejected       reverts on next key
  //   (both real captures: test/results/slate-fix; other rows below historical)
  //   ProseMirror (prosemirror.net) writes nothing, 3/3       applies, 10/10
  //   Quill (quilljs.com)          writes nothing, 8/8       applies, 8/8
  //   TipTap (embed.tiptap.dev)    writes nothing, 8/8       applies, 8/8
  //   Lexical (playground.lexical) writes nothing, 8/8       text 8/8, caret
  //                                                          reverted 0/8
  //   Draft (draftjs.org)          ignored 8/8 idle;         applies, 32/32
  //                                DELETES 6 chars over 8
  //                                burst -- STRUCTURAL, see
  //                                below; not a source bug
  //   Trix (trix-editor.org)       ignored 8/8 idle AND      applies, 32/32
  //                                THROWS in 8/8; DELETES
  //                                7 over 8, same reason
  //   CKEditor 5 (docs, classic)   applies 8/8 idle,         reverts it, 0/8,
  //                                SCRAMBLES 3/8 burst       user text intact
  //                                -- REFUSED, see below
  //
  // This table is the conclusion, not the evidence. The full A/R/D matrix --
  // every arm, both caret policies, the `none` controls, and the per-trial
  // finals -- is in the header of test/editor-recipe-probe.mjs, which is also
  // the thing that regenerates it.
  //
  // THE INTENT COLUMN IS VERSIONED BY THE RECIPE, and the first write-up of it
  // was not. Those cells were measured against a "no selection, no wait"
  // spliceSentenceSlate that had already been superseded when they were
  // recorded, and the CKEditor refusal turned on precisely that difference, so
  // the numbers had to be retaken. Four times, in the end -- the splice moved
  // under this column all afternoon, and every move changed it. Every INTENT
  // cell above was taken against content.js sha256 396339020bdaff9c
  // (spliceSentenceSlate: same-tick selection, targetRanges, the `misplaced`
  // exactness check, the positional replay gate with its caret arithmetic
  // fixed, and the `ignored`-exit gate asking the DOCUMENT whether the
  // correction is present rather than trusting a snapshot). The hash names the
  // bytes MEASURED, not the current file -- several agents were writing this
  // file the same afternoon, and one of them silently reverted this very
  // paragraph -- so each probe artifact records the hash it read AND keeps a
  // copy of the source, and those are the authority.
  //
  // WHICH MAKES THE CHECK MECHANICAL, and that is the point of keeping the
  // bytes rather than only the hash. When this column's hash no longer matches
  // the file -- which happens on any comment edit, including this one -- do not
  // re-measure and do not assume: diff the saved snapshot against the live file,
  // confirm every changed line is a comment, and say so. That is a verification;
  // "it was only comments" is an assurance. A hash proves two things differ and
  // says nothing about what, which is exactly the question. Change spliceSentenceSlate and this column is stale.
  // The MUTATION column is independent of it and was re-confirmed against these
  // bytes and the two before them: Draft and Trix 8/8 idle and 8/8 burst,
  // nothing deleted, every time, pooling to 32/32.
  //
  // AND THE POSITIVE CONTROL IS WHY THAT VERSIONING IS NOT BOOKKEEPING. It
  // caught a regression IN THE SPLICE that no candidate cell could have shown,
  // because a candidate that measures dirty is expected to. Measured A/B on the
  // same page within the hour, so neither the site nor machine load explains it
  // (the solo run was worse than the parallel one):
  //
  //     content.js sha256-16   Slate intent idle   burst   chars DELETED
  //     0d4fc37cdc49b672       8/8                 8/8     0
  //     2796fc8de91649ee       8/8                 3/8     7    <- regressed
  //     aade292d660a76a4       8/8                 16/16   0    <- fixed
  //     396339020bdaff9c       8/8                 8/8     0    <- still fixed
  //
  // The signature is what identified it. On the good bytes a swallowed
  // character comes back at the wrong PLACE (CKEditor's "...everyone.h"); on
  // the bad ones it did not come back at all -- "Then we" left as "The we",
  // "Thewe", "Thn we" -- on Slate AND CKEditor. The swallow happened and the
  // replay did not. Root cause, traced by the splice's owner rather than
  // reasoned: the replay gate's expected caret went stale the moment the gate
  // SUCCEEDED, so every batch after the first in a window was dropped. Note
  // that the plausible reading ("the gate declines to flush") and the traced
  // one disagree about which way to move -- one loosens the gate, the other
  // fixes its arithmetic and keeps it strict.
  //
  // Two things this registry keeps from that. A burst that produces ONE swallow
  // batch per trial is a collision, not a burst: the suite that types three
  // characters, fires, then types the rest reported 16/16 clean on the exact
  // bytes measured 3/8 here, because the second-batch case is unreachable by
  // construction. And nothing in this registry changed for any of it -- a
  // transport defect is not a routing question.
  //
  // DRAFT AND TRIX's DELETED COUNTS ARE NOT VERSIONED BY THE SOURCE, and must
  // not be chased as if they were. Those two reach spliceSentenceSlate's
  // `ignored` exit on every trial, because they ignore the synthetic dispatch
  // -- and `replaySwallowed` gives the character back through THE SAME
  // SYNTHETIC TRANSPORT, which they therefore ignore too. So the give-back
  // cannot arrive: **this cell cannot go to zero while the editor ignores the
  // transport**, whatever the splice does next. It is a property of the
  // recipe-editor PAIR, not of any hash. (A number inside it did move once, and
  // that part was a real bug: the `ignored` exit compared the caret against a
  // correction that, on an ignored write, does not exist, and dropped the whole
  // buffer -- 8/8 losing a character, now 6/8 and 7/8 with two clean refusals.)
  //
  // The obvious repair is the forbidden one. Falling back to execCommand for
  // the replay is the MUTATION transport, and the only editor that reaches this
  // code in production is Slate -- where a DOM write its model never learns
  // about is the exact defect this recipe exists to avoid. So it trades a lost
  // keystroke on a path that barely occurs for a silent model/DOM divergence on
  // the path that always does. Draft and Trix reach it at all only because the
  // probe FORCES a recipe the registry does not give them; both ship on
  // MUTATION and never call this function.
  //
  // Slate was carried as a positive control for the synthetic dispatch -- the
  // expanded-range `beforeinput` reads HONOURED on Slate and `ignored`
  // everywhere else, so "everyone ignores it" is a property of those editors
  // rather than of a broken probe.
  //
  // THE 2026-08-13/14 CANDIDATE ROUND -- three families, both recipes, both caret
  // policies, 8 idle + 8 burst trials per cell (16 + 16 on the two that
  // shipped), plus a `none` arm that fires no write at all so "the recipe ate a
  // keystroke" and "the demo site drops keystrokes under load" cannot be
  // confused (24/24 intact, every candidate). test/editor-recipe-probe.mjs.
  // Harper's lint framework (packages/lint-framework/src/lint/computeLintBoxes)
  // dispatches per editor and was the prior in all three cases; it was right
  // about one of them, and a prior is not a measurement.
  //
  //   Draft   Harper gives it a THIRD shape: a setTimeout, a cancelable
  //           synthetic beforeinput, and a direct DOM write when nothing
  //           cancels it. The DOM half is a fallback chain and is forbidden
  //           here -- and it turns out not to be needed. Draft ignores a
  //           SYNTHETIC beforeinput (INTENT `ignored` 8/8, which is exactly why
  //           Harper needs the fallback) and takes execCommand's TRUSTED one
  //           16/16 in both columns. The third shape exists to work around an
  //           untrusted event; MUTATION does not have that problem.
  //   Trix    Harper's generic path, and the same answer -- MUTATION 16/16 in
  //           both columns. INTENT here does not merely do nothing: Trix's
  //           input controller reads `event.dataTransfer.getData` off the
  //           event and THROWS, in 8 of 8 idle trials and 8 of 8 burst.
  //   CKEditor 5   REFUSED, and it is the one Harper's prior fits. It honours
  //           the INTENT dispatch, 8/8 idle, clean. Mid-burst it scrambles the
  //           user's own text 3/8: "Then we" comes back as
  //           "Thn we shipped it out to everyone.e" -- nothing DELETED, the
  //           swallowed character replayed at the END of the document. CKEditor
  //           honours the REPLAY's synthetic beforeinput too and applies it at
  //           ITS model selection, which the DOM caret restore never reaches,
  //           so the character lands wherever the user has typed to ~30ms
  //           later. A `caret` field cannot buy this back -- what is misrouted
  //           is the replay, not the caret restore. Measured four times across
  //           four splice revisions -- 3/8, then 0/8 with 12 characters deleted
  //           while the splice was regressed, then 3/8 twice more -- so the
  //           RATE moves with the recipe and the mechanism does not. And
  //           MUTATION is not the way out either: CKEditor's renderer reverts
  //           the execCommand outright, 0/8 idle and 0/8 burst, the same way
  //           Slate does. Clean in one column of one recipe is not a row, and
  //           this one is clean in neither.
  //
  //           Its mutation column also carried a FALSE data-loss claim for a
  //           day -- "8 keystrokes gone in 8 trials". Nothing was gone: every
  //           final held the user's complete typed text, and the probe was
  //           measuring `final.length` against the CORRECTED sentence, which is
  //           one character longer than the typo. A reverted correction scored
  //           as a deleted keystroke. The probe now counts characters the user
  //           typed that are absent from the result altogether. Damage and data
  //           loss are different claims and the worse one must be earned.
  //
  // Three transport questions, with the trust finding updated on 2026-10-09:
  //
  //   1. Trust IS an axis for slate-react >= 0.128: onDOMBeforeInput returns
  //      immediately for untrusted events. Check cancellation synchronously
  //      and restore/detach before yielding (test/results/slate-fix). This
  //      does not make MUTATION a fallback: Chrome 145 execCommand emits a
  //      trusted input, NO beforeinput, and both Slate builds revert the edit.
  //   2. "A bad write can be detected by provoking the editor to reconcile."
  //      False for the cheapest provocation. After a MUTATION write on Slate,
  //      nudging the DOM selection -- which the splice does anyway restoring
  //      the caret -- and polling at 0/16/30/60/100/200/400/800/1500ms read
  //      CORRECT at every sample. Only a real user keystroke exposes it.
  //   3. "The editor can be classified passively, from the user's own typing"
  //      (read `defaultPrevented` in a microtask after each trusted
  //      beforeinput). Measured dead: Slate, ProseMirror, Lexical, CodeMirror 6
  //      and a plain contenteditable are ALL 0/2 -- nobody cancels ordinary
  //      collapsed typing, because they all need the browser's native IME
  //      behaviour. The discriminating sample would be a trusted insertText
  //      over an EXPANDED range, which real typing never produces, so the
  //      bucket is empty exactly when the decision is needed.
  //
  // A CARET POLICY IS PART OF THE TRANSPORT, not part of the recipe. Lexical is
  // what shows it: its TEXT behaves as MUTATION (absorbs execCommand, survives
  // 8/8) while its SELECTION behaves as INTENT (it owns the caret and reverts
  // ours). The timeline pins the mechanism -- our checked arithmetic SUCCEEDS,
  // the caret reads the intended offset synchronously inside the call, and one
  // task turn later Lexical has reconciled and re-imposed its own. Re-setting
  // it after reconciliation holds, 3/3. So an editor may take one recipe for
  // text and another for selection, and that is one `caret` field rather than
  // a second splice implementation.
  //
  // ONE RECIPE PER SENTENCE, CHOSEN UP FRONT -- NEVER A FALLBACK CHAIN. "Try
  // INTENT, and if nothing happened try MUTATION" is wrong for two measured
  // reasons. A handler can queue a model update and leave the DOM unchanged for
  // ~100ms, which reads as a no-op, and then BOTH writes land. And INTENT is
  // not the harmless no-op it appears to be: fired while the user is typing it
  // DELETES A CHARACTER THEY TYPED -- Quill 7/14 burst trials, TipTap 10/14,
  // Lexical 5/14, Draft 6 characters over 8 and Trix 7 over 8, against 24/24
  // intact with no splice fired (historical, before the synchronous rejection
  // guard). Two causes, both in spliceSentenceSlate:
  // `bail` swallows the keystroke and `replaySwallowed` gives it back through
  // the exact synthetic transport those editors ignore.) A fallback chain
  // creates failures neither recipe has on its own -- and CKEditor 5 shows the
  // third failure it would invent, an editor that honours BOTH dispatches and
  // puts the replay in the wrong place.
  //
  // Ordered most-specific first: TipTap is `.tiptap.ProseMirror` and is
  // deliberately matched by the ProseMirror row -- measured indistinguishable
  // from core ProseMirror on both text and caret, 8/8 each, so plugins change
  // what the document may CONTAIN (which snRangeIsUniform already refuses on)
  // rather than whether a DOM mutation is absorbed. Draft and Trix go last
  // because their fingerprints can collide with nothing: one is a class no
  // other editor emits, the other a custom ELEMENT, so nearestTransport's
  // nesting rule settles them and registry order never gets a say.
  const SN_TRANSPORTS = [
    { family: "Slate",       match: '[data-slate-editor="true"]', recipe: "intent",   caret: "in-recipe" },
    { family: "ProseMirror", match: ".ProseMirror",               recipe: "mutation", caret: "checked" },
    { family: "Quill",       match: ".ql-editor",                 recipe: "mutation", caret: "checked" },
    { family: "Lexical",     match: "[data-lexical-editor]",      recipe: "mutation", caret: "reimpose" },
    // `checked`, not `reimpose`, and that is a measurement rather than a
    // default: the `reimpose` arm was run against both and scored identically,
    // 8/8 idle and 8/8 burst. Neither editor takes the caret back the way
    // Lexical does, so the weaker policy is the whole of what is needed and the
    // two extra timers buy nothing.
    { family: "Draft",       match: ".public-DraftEditor-content", recipe: "mutation", caret: "checked" },
    { family: "Trix",        match: "trix-editor",                recipe: "mutation", caret: "checked" },
  ];

  // Families demoted by the durability veto, for the life of this content
  // script. The scope is {topLevelOrigin, frameOrigin, family}; the first
  // two are constants inside one injection, so the family alone IS that key --
  // and unlike sentenceBlockedEls it survives React replacing the composer.
  // family -> why it was demoted. A Set lost the cause, so every demotion was
  // reported to the user as "not-durable" -- including one caused by a write
  // that landed somewhere else, which is a different thing that happened.
  const sentenceDemotedFamilies = new Map();

  /**
   * Which transport does this editor take, or null if we have never measured it.
   *
   * Deny by default. An unrecognized contenteditable is not "probably fine" --
   * it is an editor whose model we have no evidence about, and the failure mode
   * is a silent revert that takes the user's next keystrokes to the wrong
   * offset with it.
   */
  /**
   * The registry row for this element, ignoring demotion.
   *
   * The NEAREST matching ancestor wins, not the first row in registry order.
   * `getEditableRoot` stops at a `contenteditable="false"` island, so the
   * element handed here can be an inner editing host nested inside an outer
   * one -- and taking the first row that matches anywhere up the tree would
   * give an inner `.ProseMirror` the outer Slate recipe, which is exactly the
   * keystroke-deleting combination the registry exists to prevent. Registry
   * order breaks a tie when one element matches two selectors.
   */
  function nearestTransport(el) {
    if (!el || !el.closest) return null;
    // The island boundary, and it is the SAME one getEditableRoot draws --
    // deliberately the same function rather than a second walk, because two
    // statements of "where does this editing context end" is how they come to
    // disagree. `closest()` does not know about editing contexts: it walks
    // straight through a `contenteditable="false"` node view, so an editor we
    // have NEVER MEASURED, hosted inside one that we have, inherited the outer
    // family's adapter and got written to. CKEditor 5 inside a ProseMirror or
    // Slate node view is the live shape of it -- and CKEditor is a family this
    // registry has measured and REFUSED, so deny-by-default was being defeated
    // by nesting alone. Nothing reported the inner editor; nothing had to.
    //
    // A match is valid only if the host sits at or below el's own editable
    // root, i.e. every step from el up to the host is continuously editable.
    // contains() is reflexive, so the ordinary case -- host IS the editable
    // root, which is true of all six rows -- passes unchanged.
    const island = getEditableRoot(el);
    let best = null;
    for (const t of SN_TRANSPORTS) {
      const host = el.closest(t.match);
      if (!host) continue;
      if (!island || !island.contains(host)) continue;
      if (!best || (best.host !== host && best.host.contains(host))) best = { host, t };
    }
    return best ? best.t : null;
  }

  function editorAdapterFor(el) {
    const t = nearestTransport(el);
    if (!t) return null;
    return sentenceDemotedFamilies.has(t.family) ? null : t;
  }

  /**
   * Why this field is, or is not, usable by sentence mode.
   *
   * Returns { ok, status, detail, family }. The status vocabulary is the one
   * the popup reports, so every refusal has somewhere to be seen. Anything that
   * returns ok:false and has no status here is a silence bug.
   */
  function sentenceFieldStatus(el) {
    if (!el) return { ok: false, status: "no-field", detail: null, family: null };
    // Named through the same nearest-ancestor rule the write uses, so the
    // family the popup reports is the family that would have been written to.
    const nearest = nearestTransport(el);
    const family = nearest ? nearest.family : null;
    // Demotion is checked FIRST, though both are true after a veto: they are
    // the same refusal and "the editor discarded a correction" is the cause,
    // while "this element is blocked" is only its consequence. The popup shows
    // whichever this returns, so the order picks the sentence the user reads.
    if (family && sentenceDemotedFamilies.has(family)) {
      return { ok: false, status: "session-blocked",
               detail: sentenceDemotedFamilies.get(family) || "not-durable", family };
    }
    // The cause as it was RECORDED, not a constant standing in for it. This
    // returned "write-rejected" for every non-demoting block whatever
    // blockSentenceField was given, so `reconciled` -- the page taking the
    // write and throwing it away -- was reported to the user, and to anyone
    // reading over their shoulder, as the editor having refused it. The two
    // have different causes and different next steps.
    if (sentenceBlockedEls.has(el)) {
      return { ok: false, status: "session-blocked",
               detail: sentenceBlockedEls.get(el) || "write-rejected", family };
    }
    if (!hasSegmenter) {
      return { ok: false, status: "unsupported-editor", detail: "no-segmenter", family };
    }
    if (!isEnglishField(el)) {
      return { ok: false, status: "unsupported-editor", detail: "not-english", family };
    }
    if (el.tagName === "TEXTAREA") {
      return el.disabled || el.readOnly
        ? { ok: false, status: "unsupported-editor", detail: "read-only", family: null }
        : { ok: true, status: "active", detail: null, family: "textarea" };
    }
    // <input> is deliberately absent. It holds one line, so there is no "next
    // sentence" for the trigger to reach, and it is overwhelmingly a name or a
    // search box rather than prose.
    if (!el.isContentEditable) {
      return {
        ok: false, status: "unsupported-editor",
        detail: el.tagName === "INPUT" ? "single-line-input" : "not-editable", family,
      };
    }
    const adapter = editorAdapterFor(el);
    if (!adapter) {
      return { ok: false, status: "unsupported-editor", detail: "unknown-editor", family };
    }
    if ((el.textContent || "").length > SENTENCE_CE_MAX_CHARS) {
      return { ok: false, status: "unsupported-editor", detail: "too-large", family: adapter.family };
    }
    return { ok: true, status: "active", detail: null, family: adapter.family };
  }

  function sentenceEligibleEl(el) {
    return sentenceFieldStatus(el).ok;
  }

  // --- Field adapter -------------------------------------------------------
  //
  // The trigger, the anchor, the guards, the splice and the flash all read text
  // and a caret through these four functions rather than touching el.value and
  // el.selectionStart directly. That is what lets one copy of the logic drive
  // both a textarea and a contenteditable -- the alternative was a second
  // implementation of the entire path for rich editors, which is exactly how
  // two copies of MIN_SENTENCE_CHARS start drifting apart.

  function snIsCE(el) {
    return !!el && el.tagName !== "TEXTAREA" && el.tagName !== "INPUT";
  }

  /**
   * Is this a Slate editor?
   *
   * Kept as a named question because Slate is the one family on the INTENT
   * recipe, and because it is what test/sentence-slate-test.mjs pins. Derived
   * from the registry rather than repeating the selector: two copies of
   * `[data-slate-editor="true"]` is how the eligibility check and the write
   * routing start disagreeing about which editor they are looking at.
   */
  function snIsSlate(el) {
    const a = editorAdapterFor(el);
    return !!a && a.family === "Slate";
  }

  // Deliberately not memoised. The obvious cache is invalidated by the very
  // `input` event that triggers the check, and a cache that is merely USUALLY
  // right here means splicing at a stale offset -- which is data loss, not a
  // missed correction. So the walk is paid, and the element is size-capped
  // above instead.
  function snText(el) {
    return snIsCE(el) ? buildSegmentsForElement(el).text : String(el.value || "");
  }

  // "Is this composer empty" -- and NOT `snText(el) === ""`, which is never
  // true of an empty Slate composer: the zero-width U+FEFF inside
  // `data-slate-zero-width` and the `contenteditable="false"` placeholder both
  // land in the text this code reads (the bug-pattern row "checking is-this-
  // editor-empty with textContent"). Scaffold-aware in ONE direction only: a
  // node that identifies itself as the placeholder is furniture, and
  // zero-width and whitespace characters are not content. Everything else
  // that carries no text still counts -- a mention chip is a non-editable
  // span and an emoji is an <img>, and the first cut skipped every
  // non-editable descendant, so a field holding only a chip read as empty
  // (review, 2026-09-15). Used by the verifier TRACE only for now; the
  // general text/offset reader is deliberately unchanged.
  const SN_ZERO_WIDTH_RE = /[\uFEFF\u200B\u200C\u200D\u2060\s]/g;
  const SN_PLACEHOLDER_SEL = "[data-slate-placeholder], [data-placeholder], .placeholder, [aria-hidden='true'][contenteditable='false']";
  function snIsEmptyComposer(el) {
    if (!snIsCE(el)) return String(el.value || "").trim() === "";
    let text = "";
    let atoms = 0;
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { text += node.nodeValue || ""; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node !== el && node.matches(SN_PLACEHOLDER_SEL)) return;
      if (node.tagName === "IMG" || node.tagName === "VIDEO" || node.tagName === "CANVAS") { atoms++; return; }
      if (node !== el && node.getAttribute("contenteditable") === "false") { atoms++; return; }
      for (const child of node.childNodes) walk(child);
    };
    walk(el);
    return atoms === 0 && text.replace(SN_ZERO_WIDTH_RE, "") === "";
  }

  function snCaret(el) {
    if (!snIsCE(el)) return { start: el.selectionStart, end: el.selectionEnd };
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { start: null, end: null };
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) {
      return { start: null, end: null };
    }
    const { spans } = buildSegmentsForElement(el);
    return {
      start: domOffsetToTextOffset(r.startContainer, r.startOffset, spans),
      end: domOffsetToTextOffset(r.endContainer, r.endOffset, spans),
    };
  }

  function snMaxLength(el) {
    if (snIsCE(el)) return Infinity;
    return typeof el.maxLength === "number" && el.maxLength >= 0 ? el.maxLength : Infinity;
  }

  // Focus on a contenteditable can legitimately sit on a DESCENDANT -- Slate
  // focuses the editor root, other editors focus the line element. An identity
  // check against document.activeElement is right for a textarea and refuses
  // every rich editor there is.
  function snIsFocused(el) {
    const active = document.activeElement;
    return active === el || (snIsCE(el) && !!active && el.contains(active));
  }

  // --- Watermark -----------------------------------------------------------

  function setWatermark(st, wm) {
    const text = snText(st.el);
    st.watermark = Math.max(0, Math.min(wm, text.length));
    st.prefix = text.slice(0, st.watermark);
    // `lastText` is the EDIT-SIZE baseline and is refreshed here on purpose:
    // after our own write, a keystroke measured against the pre-write text is a
    // huge diff and would be refused as `bulk:size`.
    //
    // It is deliberately NOT the provenance baseline. This line copies the
    // whole live field, tail included, and this function is called from places
    // that never observed that tail -- the response handler advances the
    // watermark to job.end having validated only the first job.end characters.
    // A page that changed the tail mid-request was therefore adopted as
    // observed, and the scan chained off that same response sent it. That is
    // `observedText`, which only the sites that can actually account for the
    // text may write.
    st.lastText = text;
    // A floor the watermark has passed is spent -- everything before it is
    // already behind us, so keeping it would go on refusing the user's own
    // later sentences. And a page that TRUNCATED the field must not leave a
    // floor pointing past the end of it.
    if (st.unprovenanced > text.length) st.unprovenanced = text.length;
    if (st.unprovenanced && st.watermark >= st.unprovenanced) st.unprovenanced = 0;
  }

  /**
   * Adopt the current field contents as accounted for.
   *
   * Called from exactly these places, and the list is the invariant:
   *
   *   - the input path, AFTER classification: ordinary typing adopts directly,
   *     a bulk-classified edit adopts only behind a fence;
   *   - `compositionend`, once, for a session the input path skipped;
   *   - a write of our own that verified -- and those DERIVE their new value
   *     from the old one rather than calling this, because reading the field
   *     back is how a page's tail gets adopted;
   *   - the trust baseline taken on focus, which is a trust boundary and is
   *     labelled as one at its call site.
   *
   * Anything else that changes the field is by definition unobserved, and the
   * scan refuses to send it -- so a new caller here is a new hole, not a
   * convenience.
   */
  function setSentenceObserved(st, value) {
    if (!st) return;
    st.observedText = value;
    // Every baseline write invalidates any settle re-read still in flight --
    // see noteSentenceObservedSettled. Without this a timer armed by an earlier
    // keystroke lands after an apply has derived its baseline and stomps it
    // back to the pre-write field.
    st.observeSeq = (st.observeSeq || 0) + 1;
  }

  function noteSentenceObserved(st) {
    if (st) setSentenceObserved(st, snText(st.el));
  }

  /**
   * Record that the USER edited the tracked field, and what the field held once
   * that edit settled -- or `null` where the observer could not account for it.
   *
   * This exists because the async write verifier used to run its own `input`
   * listener, and `input` is exactly the event slate-react does not fire for a
   * period: it applies the edit through its own model and cancels the default.
   * So a correction, then a "." typed within 600ms, read as the PAGE having
   * rewritten the field -- `reconciled-async`, and the composer blocked for the
   * life of the content script. Thirty of the thirty-five reconciles in a month
   * of the owner's traffic were discord.com; none was a textarea.
   *
   * The fix is not a second attribution mechanism. Provenance already reads,
   * polls, classifies and fences trusted edits; verification and edit feedback
   * CONSUME what it concluded and never write `observedText`, advance a floor,
   * or authorise a sentence. `text === null` means "the user did something here and we
   * cannot say what the field holds because of it" -- a fenced bulk edit, a
   * superseded poll, or a settle that saw no change at all. The verifier turns
   * that into `sentence-applied-unverified`, never into a block: uncertainty
   * about attribution is not evidence that the page took our write. Feedback
   * cancels its pending attribution on a null receipt instead of guessing.
   */
  function noteSentenceUserEdit(st, text, via) {
    if (!st) return;
    st.userEditSeq = (st.userEditSeq || 0) + 1;
    st.userEditText = text;
    // WHICH PATH concluded this, because a superseded poll needs to know what
    // beat it. The input path classifies its OWN keystroke synchronously, so a
    // beforeinput poll superseded by it has been answered and must stay quiet;
    // another poll's adoption says nothing about this poll's keystroke, so that
    // one leaves the field unaccounted for. Comparing sequence numbers cannot
    // separate the two -- both are "something advanced" -- and getting it wrong
    // either blocks a healthy rich editor (two keys rendered late) or waives a
    // page rewrite that followed a keystroke.
    st.userEditVia = via || "poll";
    noteSentenceEditWatch(st, text, st.userEditSeq);
  }

  /**
   * Re-read the field once the editor has actually applied an edit, and adopt
   * or fence what appeared.
   *
   * The caller that needs this is the `beforeinput` listener, which fires
   * BEFORE the edit exists: there is nothing to read at dispatch time, so the
   * read has to happen afterwards. The `input` caller uses it defensively --
   * measured on the real Slate capture, its capture-phase read was ALREADY
   * current on every sample (sync and settled identical for every letter of
   * "The techncian arrived early"), so the "we read before React renders" story
   * is NOT what was wrong and is not claimed here. What was wrong is in the
   * `beforeinput` listener's own comment: for a period, slate-react fires no
   * `input` event at all.
   *
   * BOUNDED, not blind. The poll starts from a baseline the caller chooses and
   * classifies whatever appeared against the same cap the input path uses;
   * anything larger is fenced exactly as a bulk edit is, so a big injection
   * timed into the window cannot be adopted silently. What remains is a
   * sub-threshold page mutation landing inside a ~30ms window, which merges
   * into the residual the size cap already owns rather than opening a new one.
   *
   * A POLL rather than a constant, for the reason this path has already learned
   * twice: there is no moment at which the DOM is known to be correct, only a
   * boundary after which it usually is. One tick, then every 5ms to a 30ms
   * ceiling, adopting the first reading that actually changed.
   */
  function settleSentenceObserved(st, baseline, onSettled) {
    if (!st) { if (onSettled) onSettled(null); return; }
    const el = st.el, seq = st.observeSeq;
    let waited = 0;
    const step = () => {
      // A newer baseline write -- another keystroke, or an apply deriving its
      // own -- supersedes this poll entirely. It is reported as unattributable
      // rather than dropped, or a verifier waiting on it would wait for ever.
      if (sentenceTrack !== st || st.el !== el || st.observeSeq !== seq) {
        if (onSettled) onSettled(null);
        return;
      }
      const settled = snText(el);
      if (settled !== baseline) {
        // The same classification the input path applies, against the same cap.
        // This is what lets the `beforeinput` caller below adopt nothing on
        // trust: it polls from the EXISTING baseline, so a page mutation that
        // happened before the keystroke is still measured in full and fenced.
        const fenced = sentenceEditSize(baseline, settled) > SENTENCE_BULK_CHARS;
        if (fenced) fenceUnaccounted(st, baseline, settled);
        setSentenceObserved(st, settled);
        // A fenced edit is adopted as the baseline exactly as before, and is
        // still NOT attributable: the size is the reason we could not account
        // for it, and handing it to the verifier as the user's would let a big
        // injection merged with a keystroke waive verification.
        if (onSettled) onSettled(fenced ? null : settled);
        return;
      }
      if (waited >= SN_OBSERVE_SETTLE_MS) {
        // A trusted edit whose result never appeared inside the window. Not
        // nothing -- the user pressed a key -- so it is reported, and reported
        // as unattributable.
        if (onSettled) onSettled(null);
        return;
      }
      waited += 5;
      setTimeout(step, 5);
    };
    setTimeout(step, 0);
  }

  function noteSentenceObservedSettled(st) {
    if (!st) return;
    // The input path has already classified this edit, so the synchronous
    // adoption is safe here and the poll only has to catch what the editor
    // applies afterwards.
    noteSentenceObserved(st);
    // NO RECEIPT FROM THIS POLL, deliberately -- it passes no callback at all.
    // The caller has already classified this edit synchronously and recorded
    // it; this poll exists to catch what the editor renders afterwards, and
    // letting it revise the receipt is laundering: a
    // sub-threshold page mutation landing inside the ~30ms window would be
    // adopted as the user's, and a page prepending "PREFIX " right after a
    // keystroke would waive verification instead of blocking the field. The
    // baseline adoption is provenance's own long-standing residual and is
    // unchanged; what must not follow from it is an attribution.
    settleSentenceObserved(st, st.observedText);
  }

  // The watermark is a raw offset into a document the user can edit anywhere,
  // so it is never repaired incrementally -- it is thrown away and recomputed.
  // Cheap, because this runs on discrete events (focus, paste, undo, an edit
  // before it) rather than per keystroke, and it cannot drift.
  function rederiveWatermark(reason) {
    const st = sentenceTrack;
    if (!st) return;
    cancelSentenceJob(reason);
    const text = snText(st.el);
    // mergeTrailingRunt:false, same as the trigger. With the default, opening a
    // draft that ends mid-word -- "This is already done. Dr" -- folds the runt
    // backward into one unfinished segment, the watermark lands at 0, and three
    // more keystrokes make the ALREADY FINISHED first sentence eligible. The
    // whole point of deriving a watermark on focus is that this cannot happen.
    const segs = segmentSentences(text, { mergeTrailingRunt: false });
    // Everything already finished is behind the watermark. Opening a
    // half-written draft must not fire twenty requests.
    //
    // When the last segment is unfinished the watermark goes to the END of the
    // one before it, not to that segment's start. The two differ only by the
    // whitespace between them, and that whitespace is what keeps the watermark
    // invariant true: it always sits on a gap, never against a character.
    const last = segs.length ? segs[segs.length - 1] : null;
    let wm = 0;
    if (last) {
      if (endsSentence(last.text)) wm = text.length;
      else if (segs.length > 1) wm = segs[segs.length - 2].end;
    }
    setWatermark(st, wm);
    sentenceLog("watermark", reason, st.watermark, "/", text.length);
  }

  function sentenceAttach(el) {
    if (sentenceTrack && sentenceTrack.el === el) return;
    teardownSentence();
    if (!sentenceAllowed) {
      setSentenceStatus("off", "not-allowed", null);
      return;
    }
    // Reported whether or not it is a refusal. `unsupported-editor` is only
    // ever set from HERE -- after the user focused an otherwise-eligible
    // editable -- so a page the user never typed into is never painted as an
    // error.
    const st = sentenceFieldStatus(el);
    setSentenceStatus(st.status, st.detail, st.family);
    // Coverage accounting. Deny-by-default per editor family is defensible for
    // one person who knows which sites work; as a product it is the main
    // coverage risk, and NOTHING counted it -- `unsupported-editor` was a
    // status the popup rendered on demand and no tally anywhere. This is the
    // cheapest honest instrument: the decision is already being made here on
    // every focus, so counting it costs a WeakSet lookup and reuses the skip
    // batching wholesale. It records a REASON, never an origin or any text.
    //
    // Counted once per field, and the `ok` side is counted too -- a refusal
    // count with no denominator cannot answer "what fraction", which is the
    // question. Read it among rich editors: `single-line-input` is every
    // search box on the web and will dominate any naive total.
    if (!sentenceSeenFields.has(el)) {
      sentenceSeenFields.add(el);
      sentenceSkip(st.ok
        ? `field:ok:${st.family || "unknown"}`
        : `field:${st.status}:${st.detail || "none"}`);
    }
    if (!st.ok) return;
    // `unprovenanced` is the offset before which the field holds text we could
    // not account for. It starts at zero, and that is a TRUST BOUNDARY rather
    // than a provenance claim: text already present when the field is focused
    // is trusted as the user's, because it has to be. The watermark-plus-runt
    // design exists precisely to proofread a half-written draft that was there
    // on arrival, so refusing it would delete a shipped feature.
    //
    // What that admits is recorded in ARCHITECTURE.md rather than hidden: a
    // page can install unfinished text, wait for a blur and refocus -- which
    // tears this whole state down -- and the fragment is trusted again. The
    // backstops are the ones that do not depend on attribution at all: the
    // output guards, and the durability watch on anything silently applied.
    sentenceTrack = {
      el, watermark: 0, prefix: "",
      lastText: snText(el), observedText: snText(el), observeSeq: 0, unprovenanced: 0,
      // Trusted user edits the observer has ACCOUNTED FOR, for verification
      // and feedback to consume. Neither writes these -- see noteSentenceUserEdit.
      userEditSeq: 0, userEditText: null, userEditWait: 0, userEditVia: null,
      // A sendable target was deferred because the caret sat inside it; the
      // next selectionchange re-arms the idle scan once. See maybeFireSentence.
      caretHeld: false,
    };
    rederiveWatermark("focus");
  }

  // `reason` names why, for a correction that was waiting for a pause: it is
  // dropped with everything else, and the record says so rather than being
  // left with no verdict (checkpoint 3 -- a configuration change drops a held
  // Slate correction here).
  function teardownSentence(reason = "teardown") {
    cancelSentenceJob("teardown");
    if (sentenceDeferred) dropSentenceResult(sentenceDeferred.job, reason);
    clearSentenceDefer();
    clearSentenceIdle();
    clearSentenceFlash();
    stopSentenceEditWatch();
    stopSentenceDurabilityWatch();
    sentenceTrack = null;
    sentenceUndo = null;
    flushSentenceSkips();
  }

  function cancelSentenceJob(reason) {
    if (!sentenceJob) return;
    sendMessage({ type: "CANCEL_REWRITE", requestId: sentenceJob.id });
    sentenceLog("cancel", reason, sentenceJob.id);
    sentenceJob = null;
  }

  function clearSentenceIdle() {
    if (sentenceIdleTimer) { clearTimeout(sentenceIdleTimer); sentenceIdleTimer = null; }
  }

  // A sentence that arrives while a chip is open is SKIPPED, not queued -- and
  // that skip deliberately does not advance the watermark, so the sentence is
  // still waiting afterwards. But every trigger is input-driven, and the chip
  // is usually the thing the user stopped typing to answer. Without a re-arm,
  // answering it is the last event that will ever happen: everything behind the
  // watermark stays unchecked for the rest of the session.
  function resumeSentenceScan() {
    if (sentenceTrack && sentenceAllowed) scheduleSentenceIdle();
  }

  function scheduleSentenceIdle() {
    clearSentenceIdle();
    sentenceIdleTimer = setTimeout(() => {
      sentenceIdleTimer = null;
      if (sentenceTrack) maybeFireSentence(sentenceTrack.el, true);
    }, SENTENCE_IDLE_MS);
  }

  // --- Skip accounting -----------------------------------------------------
  //
  // Pre-request skips have no record to attach a verdict to, and one storage
  // write per keystroke would be absurd. Batch them into a counter map -- which
  // is also the only thing that answers "is the trigger firing as often as it
  // should".

  function sentenceSkip(reason) {
    sentenceSkipCounts[reason] = (sentenceSkipCounts[reason] || 0) + 1;
    if (!sentenceSkipTimer) sentenceSkipTimer = setTimeout(flushSentenceSkips, 30000);
  }

  function flushSentenceSkips() {
    if (sentenceSkipTimer) { clearTimeout(sentenceSkipTimer); sentenceSkipTimer = null; }
    const counts = sentenceSkipCounts;
    sentenceSkipCounts = Object.create(null);
    if (Object.keys(counts).length) sendMessage({ type: "SENTENCE_SKIPS", counts });
  }

  // --- Circuit breaker -----------------------------------------------------
  //
  // Never an error panel: one per sentence while someone types is intolerable.
  // An unavailable Ollama is reported in the popup and toolbar badge, without
  // interrupting the writing surface.

  function tripSentenceBreaker() {
    sentenceBreakerFails++;
    sentenceSkip("breaker");
    sentenceBreakerUntil = Date.now() + Math.min(
      SENTENCE_BREAKER_MAX_MS,
      SENTENCE_BREAKER_BASE_MS * Math.pow(2, sentenceBreakerFails - 1));
    sentenceLog("breaker open", sentenceBreakerFails, "until", sentenceBreakerUntil);
  }

  // --- Warmup --------------------------------------------------------------
  //
  // Load the model on the keystroke that STARTS a burst -- cold, a sentence
  // request is 2457ms; warm, it is 416ms, and the ~2.0s load hides completely
  // inside the 8-15s it takes to type a sentence -- and then keep pinging
  // while keystrokes flow, at most every SENTENCE_WARM_RENEW_MS, so the 20s
  // sentence lease is renewed by TYPING rather than held by a long keep_alive
  // tail after the user has stopped. A late warmup is harmless either way: a
  // real request arriving mid-load queues rather than loading twice.
  //
  // There is deliberately no burst test here any more -- the throttle alone
  // decides. The first keystroke after a >=10s pause pings because the last
  // ping is by then >=10s old, which is the old burst behaviour as a special
  // case; what the throttle-only rule adds is the mid-burst renewal, and
  // background.js's staleness dedup is what keeps those renewals from
  // becoming traffic (a ping against a recently-contacted runner is `hot` and
  // touches nothing).
  //
  // This hangs off the sentence-mode input handler on purpose, rather than
  // being an `input` listener of its own. content.js is injected into every
  // frame of every page, so its own listener would need a second copy of the
  // gating -- consent, English, eligible field -- and a second copy is exactly
  // how "is sentence mode on here" and "should we warm here" drift apart. Hung
  // here, a site sentence mode is switched off for has no code path to warm from at all: the
  // mode never attaches, so this is never reached. background.js re-checks
  // consent regardless, because a cached "yes" must not outlive a revocation.
  function maybeWarmSentenceModel() {
    const now = Date.now();
    // Ollama is down and the breaker is counting. Loading will not work, and
    // the popup reports the outage.
    if (now < sentenceBreakerUntil) return;
    // The throttle. Bounds message traffic (clicking between two fields does
    // not ping per click, and neither does every keystroke of a burst);
    // background.js owns the decision about whether to actually touch Ollama.
    if (now - sentenceWarmSentAt < SENTENCE_WARM_RENEW_MS) return;
    sentenceWarmSentAt = now;
    sendMessage({ type: "SENTENCE_WARMUP" });
    sentenceLog("warmup");
  }

  // --- Input ---------------------------------------------------------------

  function onSentenceInput(el, e) {
    const st = sentenceTrack;
    if (!st || st.el !== el || !sentenceAllowed) return;
    const text = snText(el);
    // Provenance is adopted AFTER classification, never before it. An earlier
    // version adopted here, on the reasoning that an `input` event had reached
    // us at all -- but "we saw an event" and "we can attribute this text" are
    // different claims, and only the second one is what the scan needs. Adopting
    // first meant the bulk branch below could not fence anything: the text was
    // already accounted for by the time its size said it had not been typed.
    // Since a page-called `execCommand` emits a TRUSTED input (measured, [P5]),
    // that let a >8-character injection of an unfinished sentence through.
    maybeWarmSentenceModel();

    if (sentenceComposing || (e && e.isComposing)) {
      if (sentenceJob) sentenceJob.dirty = true;
      sentenceSkip("composition");
      clearSentenceIdle();
      // Deliberately NOT adopted here. A composition is a session, and the
      // intermediate states are the IME's, not the user's final text; the
      // adoption happens once at `compositionend`. Composition events cannot be
      // synthesized as trusted, so the session as a whole is user-driven --
      // which is what makes adopting at the end defensible. What rides in with
      // it is named as a residual rather than covered: a page mutation DURING a
      // composition session is adopted along with the commit, because the two
      // are indistinguishable at that point.
      st.lastText = text;
      // IME input is input. Without this, `lastInputAt` is whatever it was
      // before composition started, so a deferred Slate write can decide the
      // user has been idle for 400ms while they are actively composing -- and
      // the selection window opens under a live IME session.
      st.lastInputAt = Date.now();
      return;
    }

    // Paste and speech-to-text cannot be told apart from typing by inputType,
    // and trying is the wrong approach: execCommand("insertText", "<long>")
    // reports insertText with a long `data`, exactly like a keystroke, and a
    // direct `.value =` (what most STT and JS integrations do) fires no event
    // at all. So the discriminator is SIZE, not provenance. inputType is a
    // secondary signal, never the mechanism.
    //
    // The size that matters is the EDIT, not the net length change. Net growth
    // misses two real cases: a `.value =` of 25 characters or fewer followed by
    // a keystroke (growth 18 for "This is wrong.", under the threshold, and the
    // assigned sentence fires), and a same-length replacement (growth 0, and it
    // reports inputType "insertText"). Diffing against the previous text costs
    // one prefix/suffix scan and catches both.
    const bulkType = !!(e && BULK_INPUT_TYPES.has(e.inputType));
    if (sentenceEditSize(st.lastText, text) > SENTENCE_BULK_CHARS || bulkType) {
      if (sentenceJob) sentenceJob.dirty = true;
      sentenceSkip(bulkType ? "bulk:" + e.inputType : "bulk:size");
      clearSentenceIdle();
      // Fence FIRST, then adopt. Re-deriving retires completed segments only,
      // so without the fence an injected unfinished sentence survives ahead of
      // the watermark and one later terminator makes it eligible.
      fenceUnaccounted(st, st.lastText, text);
      noteSentenceObservedSettled(st);
      // Fenced: the user did this and the size is why we cannot account for it.
      noteSentenceUserEdit(st, null, "input");
      rederiveWatermark("bulk");
      return;
    }
    // Ordinary typing. The floor moves with the content rather than staying a
    // stale offset -- an edit before it slides the text it marks.
    shiftUnprovenanced(st, st.lastText, text);
    noteSentenceObservedSettled(st);
    // Classified and adopted synchronously above, so the write verifier can
    // attribute this one exactly. (The defensive settle poll behind
    // noteSentenceObservedSettled may still adopt a later editor render; it
    // reports through the same helper, so the last word is the observer's.)
    noteSentenceUserEdit(st, text, "input");
    st.lastText = text;
    st.lastInputAt = Date.now();

    // Any edit that is not an append at or after the watermark invalidates
    // every offset we are holding.
    if (text.length < st.watermark || text.slice(0, st.watermark) !== st.prefix) {
      if (sentenceJob) sentenceJob.dirty = true;
      rederiveWatermark("edit-behind");
      return;
    }

    // The watermark always sits on a gap: at the start, at the end, or on the
    // whitespace after a finished sentence. Typing AT the boundary -- clicking
    // just after a proofread sentence and continuing it -- leaves everything
    // before the watermark identical, so the check above passes, and the tail
    // is now a continuation rather than a new sentence. Proofreading that as if
    // it were whole is the fragment case, which is a corruption bug.
    if (st.watermark > 0 && st.watermark < text.length && !/\s/.test(text[st.watermark])) {
      if (sentenceJob) sentenceJob.dirty = true;
      rederiveWatermark("boundary-edit");
      return;
    }

    scheduleSentenceIdle();
    maybeFireSentence(el, false);
  }

  /**
   * How many characters the edit touched, from a common-prefix/common-suffix
   * diff. One keystroke is 1; a 30-character replacement of a 30-character
   * selection is 30, even though the length did not change.
   */
  function sentenceEditSpan(before, after) {
    const a = String(before || ""), b = String(after || "");
    if (a === b) return { p: a.length, oldEnd: a.length, newEnd: b.length, size: 0 };
    const n = Math.min(a.length, b.length);
    let p = 0;
    while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
    let s = 0;
    while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
    return {
      p,                        // common prefix: the edit starts here
      oldEnd: a.length - s,     // end of the changed region in `before`
      newEnd: b.length - s,     // ...and in `after`
      size: Math.max(a.length - p - s, b.length - p - s),
    };
  }

  function sentenceEditSize(before, after) {
    return sentenceEditSpan(before, after).size;
  }

  /**
   * Move the provenance floor with the content it marks.
   *
   * The floor is a raw offset, and an edit BEFORE it slides the text it was
   * pointing at without touching the number. Left untransformed that is a
   * bypass rather than a rounding error: install unfinished page text (floor
   * 14), insert a longer sentence at position 0, and the user's own sentence
   * now starts below 14, is refused, and advances the watermark past 14 --
   * retiring the floor while the injected fragment has slid out from under it.
   *
   * Three cases, from the same prefix/suffix diff the size guard already
   * computes. An edit at or after the floor leaves it alone; an edit entirely
   * before it shifts it by the length delta; an edit STRADDLING it takes the
   * conservative answer, the end of the changed region, because the boundary
   * it marked is one of the things that was just rewritten.
   */
  function shiftUnprovenanced(st, before, after) {
    if (!st || !st.unprovenanced) return;
    const sp = sentenceEditSpan(before, after);
    if (st.unprovenanced <= sp.p) return;
    if (st.unprovenanced >= sp.oldEnd) st.unprovenanced += after.length - before.length;
    else st.unprovenanced = sp.newEnd;
    st.unprovenanced = Math.max(0, Math.min(st.unprovenanced, after.length));
  }

  /**
   * Fence the region an edit touched as unaccounted for.
   *
   * For the bulk branch, where an `input` event DID fire but its size says the
   * content was not typed. Seeing the event is not the same as being able to
   * attribute the text: a page-called `execCommand` emits a trusted `input`
   * (measured, [P5]), so a >8-character injection of an UNFINISHED sentence
   * arrives here, and re-deriving the watermark cannot retire an unfinished
   * trailing segment. One later terminator would make it eligible.
   *
   * The cost is deliberate and falls on real pastes too, because size is the
   * only discriminator this path has: a sentence containing pasted text is not
   * proofread. Sentences typed after it are. That is the standing asymmetry --
   * a refused correction leaves a typo alone, an accepted one rewrites text
   * nobody typed.
   */
  function fenceUnaccounted(st, before, after) {
    if (!st) return;
    shiftUnprovenanced(st, before, after);
    const sp = sentenceEditSpan(before, after);
    // Only the ADDED region can carry text nobody typed, and it has to clear
    // the same bar the size guard uses. An edit classified bulk because it
    // DELETED a lot brings nothing to fence, and fencing the few characters
    // that arrived alongside the deletion costs real work for no protection.
    //
    // The measured case is the first keystroke on an empty Slate composer.
    // `snText` reads Slate's placeholder -- a zero-width character plus an
    // absolutely-positioned contenteditable="false" span, both of which land in
    // textContent -- so the transition from placeholder to "Th" diffs as 23
    // characters and classifies bulk. Fencing its added region put a floor at 2
    // and cost the FIRST SENTENCE of every message on Slate, permanently.
    // A sub-threshold addition is the residual the size cap already declines to
    // police, so fencing it here buys nothing the cap does not already concede.
    if (sp.newEnd - sp.p <= SENTENCE_BULK_CHARS) return;
    st.unprovenanced = Math.max(st.unprovenanced || 0, sp.newEnd);
  }

  function maybeFireSentence(el, fromIdle) {
    const st = sentenceTrack;
    if (!st || st.el !== el || !sentenceAllowed) return;
    if (!hasSegmenter) return;
    // Removing an element changes focus WITHOUT firing blur, so focusout-based
    // teardown never runs. Without this a pending idle timer still sends the
    // text of a field that is no longer on the page, and logs it.
    if (!el.isConnected || !snIsFocused(el)) {
      sentenceSkip(el.isConnected ? "unfocused" : "detached");
      teardownSentence();
      return;
    }
    if (sentenceComposing) { sentenceSkip("composition"); return; }
    // Counted once per trip, in tripSentenceBreaker. Counting it here would be
    // one skip per keystroke for up to five minutes, and a counter dominated by
    // typing speed answers no question worth asking.
    if (Date.now() < sentenceBreakerUntil) return;
    // One request in flight per frame, and a collision is a skip rather than a
    // queue. background.js cannot hold an element or read live text, so a
    // background-owned queue cannot work; at ~280ms per request against a
    // sentence every 8-15 seconds, collisions are rare and skipping is the
    // preferred outcome anyway.
    if (sentenceJob) { sentenceSkip("busy"); return; }
    if (sentenceDeferred) { sentenceSkip("apply-deferred"); return; }
    // See sentenceApplying: the field and the watermark disagree until the
    // apply finishes, and a scan in that window targets a fragment.
    if (sentenceApplying) { sentenceSkip("apply-in-flight"); return; }

    // Provenance. Every other guard against text the user did not type lives in
    // `onSentenceInput` -- the edit-size diff, SENTENCE_BULK_CHARS,
    // BULK_INPUT_TYPES -- and all three need an `input` event to run on. A page
    // assigning `el.value` fires no event at all, so on any path where time has
    // passed since the last one, none of them has run.
    //
    // Measured before the fix, three distinct routes, all reproduced:
    //   * the idle timer, armed by a keystroke and firing SENTENCE_IDLE_MS
    //     later: 8/8 across two mutation shapes at +50/+200/+400/+500ms, each
    //     sending page text AND having the correction written back into it;
    //   * a tail mutation while a request is IN FLIGHT, sent by the scan
    //     chained straight off the response, with no idle timer involved;
    //   * an UNFINISHED injected sentence, which no watermark move puts behind
    //     us, completed into eligibility by one later keystroke.
    //
    // Neither backstop can be tightened into covering this: there is no event
    // to measure a size on. Trust cannot either -- a page calling `execCommand`
    // emits an `input` with `isTrusted` TRUE (measured, [P5]), which is why
    // that shape is refused by the size cap and not by the trust bit.
    //
    // So compare against `observedText`, which is the field as of the last
    // thing we can actually account for. NOT `lastText`: that one is refreshed
    // by `setWatermark` from the whole live field, including a tail nobody
    // validated, and using it here made the in-flight route report equality.
    //
    // Unconditional, not `fromIdle`. An earlier version gated this on the idle
    // path and justified it by saying rich-editor normalisation could only
    // reach the other callers -- which is wrong, because `resumeSentenceScan`
    // re-arms the idle timer after every response and every apply, so the idle
    // path is reached from exactly those places too. The gate excluded nothing
    // it claimed to exclude, and it let the in-flight route through.
    if (snText(el) !== st.observedText) {
      sentenceSkip("unseen-mutation");
      // Two different jobs, and the first one is not enough on its own.
      //
      // Re-deriving puts every COMPLETED segment behind the watermark, which
      // handles injected whole sentences and keeps our offsets honest against a
      // field that may have been truncated. It cannot handle an injected
      // FRAGMENT: an unfinished trailing segment is left ahead of the watermark
      // by design, so that a draft the user is mid-way through still gets
      // proofread when they finish it. For page text that is the leak.
      //
      // The floor is what covers it. Everything currently in the field is
      // unaccounted for, so no target that STARTS inside it may be sent, however
      // well-formed the user later makes it. It is a floor rather than a
      // watermark move because the two must not be the same lever: forcing the
      // watermark to the end here would put it hard against a character instead
      // of on the whitespace gap it is required to sit on, and the very next
      // keystroke would trip `boundary-edit` and re-derive the floor away.
      st.unprovenanced = Math.max(st.unprovenanced || 0, snText(el).length);
      rederiveWatermark("unseen-mutation");
      return;
    }

    const text = snText(el);
    // A skipped target advances the watermark and the scan CONTINUES from
    // there, in this same pass. Returning instead left the sentence after it
    // waiting for another event, and on the idle path there is no other event:
    // the pause was the last thing that would ever fire, so `Name. <link>` cost
    // the sentence after the link as well as the link itself. The loop is
    // bounded because every iteration moves the watermark strictly forward.
    for (let i = 0; i < 8; i++) {
      // A contenteditable's text ends in a "\n" this code synthesised for the
      // last block boundary, not in one the user typed -- so the evidence has to
      // be read past it. See nextSentenceTarget.
      const target = nextSentenceTarget(text, st.watermark, fromIdle,
                                        { structuralTail: snIsCE(el) });
      if (!target) return;
      // A target that begins inside text we could not account for is refused
      // however well-formed it has since become. This is the half that survives
      // the user typing afterwards: the diff is then one character, every
      // size-based guard agrees it was typed, and only the floor remembers
      // where the page's text started.
      //
      // Refused like any other skip -- advance past it and keep scanning in the
      // same pass -- so the sentence the user types AFTER the injection is
      // still corrected. `setWatermark` retires the floor once the watermark
      // clears it, so this costs the sentences the page touched and nothing
      // after them.
      const unowned = !target.skip && target.start < (st.unprovenanced || 0);
      if (!target.skip && !unowned) {
        // DEFER, do not send, when the caret is inside the target. The anchor
        // would refuse this at delivery anyway (`caret-inside`, the same three
        // questions), but by then a model call has been paid for and -- worse
        // -- the refusal has already moved the watermark: the post-response
        // step advances it to `job.end` whenever the prefix still matches, so a
        // caret that merely moved into a finished sentence RETIRED it. Recorded
        // 2026-09-11: eight requests in eleven seconds for one sentence the
        // user was rewriting in place, every one refused at delivery, each
        // re-derive putting the sentence back in front of the watermark for
        // the next keystroke to re-request.
        //
        // Returned WITHOUT `setWatermark`, the same shape as `weak-boundary`'s
        // `end: null`: the sentence is still ahead of the watermark and is
        // sent when the caret leaves it. Read once per scan that would have
        // sent, not per keystroke. `pre-send:` rather than `anchor:` because
        // one prevented a request and the other discarded a produced result,
        // and the popup's "mostly <reason>" line should be able to tell.
        const caret = snCaret(el);
        const held = sentenceCaretRefusal(caret.start, caret.end, target.end);
        if (held) {
          sentenceSkip("pre-send:" + held);
          // Moving the caret out with an arrow or a click fires no `input`, so
          // a target deferred on the LAST idle scan would otherwise wait for a
          // keystroke that may never come -- "pausing an input-driven scan
          // without arranging to restart it". The selectionchange listener
          // re-arms the idle scan once while this flag is set.
          st.caretHeld = true;
          return;
        }
        fireSentenceRequest(el, target);
        return;
      }
      sentenceSkip(unowned ? "unprovenanced" : target.skip);
      // A sentence we will never send is still behind us. Skipping it without
      // advancing would re-evaluate it on every keystroke forever.
      if (typeof target.end !== "number" || target.end <= st.watermark) return;
      setWatermark(st, target.end);
    }
  }

  async function fireSentenceRequest(el, target) {
    const text = snText(el);
    const job = {
      id: nextSentenceRequestId(),
      el,
      start: target.start,
      end: target.end,
      sentence: target.sentence,
      // Which evidence said the sentence was finished, snapshotted with the
      // rest of the anchor because it is a property of the moment of capture --
      // by the time the reply lands the user has typed more and every idle
      // capture would read as a strong one.
      trigger: target.trigger || null,
      // The whole document up to the end of the target, byte for byte.
      prefixThrough: text.slice(0, target.end),
      capturedAt: Date.now(),
      dirty: false,
    };
    sentenceJob = job;
    sentenceLog("send", JSON.stringify(job.sentence));

    const resp = await sendMessage({
      type: "SENTENCE_REWRITE",
      requestId: job.id,
      sentence: job.sentence,
      trigger: job.trigger,
      priorContext: sentenceContextFor(text, target.start),
      pageContext: getPageContext(),
    });

    if (sentenceJob !== job) return;      // superseded or cancelled
    sentenceJob = null;

    const st = sentenceTrack;
    const stillTracked = st && st.el === el;

    if (!resp || resp.messaging) { tripSentenceBreaker(); return; }
    if (resp.revoked) {
      sentenceLog("revoked");
      sentenceAllowed = false;
      teardownSentence();
      setSentenceStatus("off", "revoked", null);
      return;
    }
    if (resp.ok === false && resp.network) { tripSentenceBreaker(); return; }
    if (resp.error === "cancelled") return;

    sentenceBreakerFails = 0;
    sentenceBreakerUntil = 0;

    // Forward-only -- but ONLY if the document still matches what was captured.
    //
    // Installing job.end unconditionally is a corruption path, not a tidiness
    // issue. The prefix check in onSentenceInput compares through the CURRENT
    // watermark, so an edit between the watermark and the target goes unseen:
    // capture "The report was late." at end=20 with the watermark still at 0,
    // delete "was " while the request is out, and job.end=20 now points into
    // the middle of "Next" in "The report late. Next sentence here." The stale
    // response is correctly refused -- and then the next request targets
    // "t sentence here.", whose plausible "T sentence here." passes every
    // guard and produces "NexT sentence here."
    //
    // Anchor loss must re-derive from live text. It must never install a
    // captured offset. This applies to the refused and no-change paths too,
    // which do not reach the anchor check at all.
    if (stillTracked) {
      if (snText(el).slice(0, job.end) === job.prefixThrough) {
        if (st.watermark < job.end) setWatermark(st, job.end);
      } else {
        rederiveWatermark("stale-response");
      }
    }

    if (resp.refused) {
      sentenceSkip("guard:" + String(resp.refused).split(":")[0]);
      sentenceLog("refused", resp.refused, JSON.stringify(job.sentence));
    } else if (resp.noChanges) {
      sentenceLog("no change");
    } else if (resp.ok && typeof resp.rewritten === "string") {
      deliverSentenceResult(job, resp.rewritten, resp.apply === true);
    } else if (resp.ok === false && resp.error) {
      // Everything else the worker can answer with. `cancelled` returned above
      // and a network failure tripped the breaker above; what is left reaches
      // here and, until 2026-09-07, reached it in COMPLETE SILENCE -- no
      // counter, no log line, nothing on this side at all. `delivery-expired`
      // made that reachable in ordinary use (a request that cannot land inside
      // the content script's own lease is ended by the worker rather than left
      // to arrive and be vetoed), which is exactly the "a refusal nobody can
      // see is a defect in its own right" rule. The worker writes the record
      // with the error on it; this is the counter the popup renders.
      sentenceSkip("worker:" + String(resp.error).slice(0, 40));
      sentenceLog("worker refused delivery", resp.error);
    }

    // The user may have finished another sentence while this one was out.
    // Chain synchronously for one that already meets the typing trigger, and
    // re-arm the idle timer either way -- if they stopped typing during the
    // round trip, a finished trailing sentence has nothing left to fire it.
    if (stillTracked) {
      maybeFireSentence(el, false);
      if (!sentenceJob) resumeSentenceScan();
    }
  }

  // --- Delivery ------------------------------------------------------------

  // A correction that passed every guard and was then thrown away here left NO
  // trace: the record was already written, and nothing ever patched a verdict
  // onto it. Four of them in the log read as `verdict: null`, indistinguishable
  // from a request still in flight, so "the model got this right and you never
  // saw it" was invisible in exactly the data collected to find it. The skip
  // counter knows the reason; the record is where it is worth anything.
  function dropSentenceResult(job, reason) {
    sentenceSkip(reason);
    reportOutcome(job.id, "sentence-skipped:" + reason);
  }

  function deliverSentenceResult(job, replacement, silent) {
    const el = job.el;
    if (!el.isConnected || sentenceBlockedEls.has(el)) {
      dropSentenceResult(job, el.isConnected ? "blocked" : "detached");
      return;
    }
    const caret = snCaret(el);
    const reason = sentenceAnchorFailure(
      job, snText(el), caret.start, caret.end, Date.now(), sentenceComposing);
    if (reason) {
      dropSentenceResult(job, "anchor:" + reason);
      sentenceLog("anchor lost", reason);
      return;
    }
    if (!snIsFocused(el)) { dropSentenceResult(job, "anchor:unfocused"); return; }

    // Silent apply runs on contenteditable too. The old setSelectionWithSync
    // wait exposed a selection window; spliceSentenceCE now sets the range and
    // inserts in one tick.
    // What remains is "the editor accepted the write and kept it", a claim
    // about Slate/ProseMirror/Lexical that is *checked* rather than assumed:
    // snRangeIsUniform refuses any range carrying markup, sentenceWriteLanded
    // verifies the write synchronously and again at 0/150/600ms, and the first
    // failure blocks the field for the rest of the session. An editor that
    // ignores or doubles the write gets one refused sentence, not a stream.
    // The Slate write waits for a pause rather than firing three characters
    // into the next sentence.
    //
    // "Without a pause, offer a chip instead" was the wrong fallback, and it
    // produced exactly the report it deserved: a chip on the sentences that
    // arrived mid-burst, and -- because an open chip skips the scan with
    // `suggestion-open` -- the sentence AFTER each one silently unchecked.
    // Fixing every other sentence and offering a chip on the rest is one bug,
    // not two. Silent mode means silent: hold the result and re-decide at the
    // next pause. The anchor's own `stale-age` at SENTENCE_MAX_JOB_MS ends the
    // wait if the pause never comes, and no chip is ever offered.
    //
    // The wait belongs to the INTENT recipe alone, and it is now HISTORICAL
    // rather than load-bearing. It existed for the ~30ms in which the sentence
    // was SELECTED while Slate read the DOM selection into its own model;
    // spliceSentenceSlate names the span on the event instead and no longer
    // opens that window at all. Fired deliberately mid-burst against real
    // Slate, 12 trials, the new recipe is 12/12 intact where the old one was
    // 8/12 with 4 refused. MUTATION never had the window -- it sets the range
    // and inserts in one tick -- so ProseMirror, Quill and Lexical apply
    // immediately. Removing the deferral here is the obvious next step and is
    // deliberately NOT taken in the same change as the transport: it decides
    // WHEN a correction is delivered, which runs through the whole of
    // deliverSentenceResult, and it is the transport that was measured.
    // Successful rewrites carry `apply: true`. This defensive non-write drop
    // also handles injected replies; revocation instead returns
    // {ok:false, error:"not-allowed", revoked:true} and tears down above.
    // There is no suggestion mode to fall back to.
    if (!silent) { dropSentenceResult(job, "no-write-consent"); return; }
    const adapter = snIsCE(el) ? editorAdapterFor(el) : null;
    if (adapter && adapter.recipe === "intent") {
      const since = Date.now() - ((sentenceTrack && sentenceTrack.el === el
        && sentenceTrack.lastInputAt) || 0);
      if (since < SN_CE_IDLE_BEFORE_MS) {
        deferSentenceApply(job, replacement, SN_CE_IDLE_BEFORE_MS - since);
        return;
      }
    }
    applySentence(job, replacement, "sentence-applied");
  }

  /**
   * Hold a finished correction until the user stops typing.
   *
   * Re-entrant on purpose: each wake-up runs the whole delivery decision again,
   * so a user who is still typing simply re-defers. That cannot spin forever --
   * `sentenceAnchorFailure` refuses the job as `stale-age` once it is older
   * than SENTENCE_MAX_JOB_MS, which is the same budget every other late result
   * is held to.
   *
   * While one is held, `maybeFireSentence` stands down. The window is a few
   * hundred milliseconds, and letting the next sentence apply underneath a
   * pending one would move its offsets and cost it the anchor.
   */
  function deferSentenceApply(job, replacement, waitMs) {
    clearSentenceDefer();
    sentenceDeferred = { job, replacement };
    sentenceDeferTimer = setTimeout(() => {
      sentenceDeferTimer = null;
      const held = sentenceDeferred;
      sentenceDeferred = null;
      if (!held) return;
      // A composition open at the wake-up is a pause we must not act on, not a
      // dead correction. Delivering would refuse it as `composing` and throw it
      // away for good -- the watermark moved past it when the response landed.
      // So wait the session out.
      //
      // But the wait needs its own end, and `stale-age` is NOT it: that check
      // lives inside deliverSentenceResult, which this branch returns before
      // reaching. An audit walked it out -- composition starts, the editor is
      // removed without a blur (so no teardown), and the timer re-arms every
      // 400ms forever against a detached node with the scan held down behind
      // `sentenceDeferred`. Both conditions are checked here instead.
      if (sentenceComposing) {
        const el = held.job.el;
        if (el.isConnected && Date.now() - held.job.capturedAt <= SENTENCE_MAX_JOB_MS) {
          deferSentenceApply(held.job, held.replacement, SN_CE_IDLE_BEFORE_MS);
          return;
        }
        dropSentenceResult(held.job, el.isConnected ? "anchor:stale-age" : "detached");
        if (!el.isConnected) teardownSentence();
        else resumeSentenceScan();
        return;
      }
      deliverSentenceResult(held.job, held.replacement, true);
      // Whatever happened -- applied, deferred again, or refused by the anchor
      // -- the scan has been standing down and nothing else will restart it.
      if (!sentenceDeferred && !sentenceJob) resumeSentenceScan();
    }, Math.max(0, waitMs));
  }

  function clearSentenceDefer() {
    if (sentenceDeferTimer) { clearTimeout(sentenceDeferTimer); sentenceDeferTimer = null; }
    sentenceDeferred = null;
  }

  /**
   * Did our write actually land, byte for byte?
   *
   * A textarea is compared whole: any difference at all is the page fighting
   * us. A contenteditable cannot be, because Slate-based editors restructure
   * their DOM between renders and buildSegmentsForElement synthesises a "\n"
   * per block boundary -- so a wrapper div appearing anywhere in the field
   * changes snText() without touching a character the user typed. The removed
   * manual path normalised whitespace for exactly this reason. Here the
   * spliced SPAN is checked exactly instead, which is the thing that actually
   * has to be right, and the surrounding text is checked for length only.
   */
  /**
   * What became of a write we just made: `verified`, `unverified` or
   * `reconciled`.
   *
   * One decision for both callers, because they had two and only one of them
   * was right. The apply path consults the splice's own window evidence before
   * judging -- a keystroke the splice yielded or replayed makes the result
   * unattributable, so the correction is recorded landed-unverified rather than
   * accused. `doSentenceUndo` called `sentenceWriteLanded` unconditionally, so
   * pressing Escape and typing inside the Slate write window blocked the field
   * as `undo:reconciled`, and that exit emitted no verdict at all: invisible in
   * the log, and the field dead for the session.
   *
   * Order matters. `landed` is computed FIRST and the window only downgrades a
   * failure, so a write that verifiably landed is still reported as verified
   * even if the window was noisy.
   */
  function sentenceWriteDisposition(el, expected, start, endAfter, replacement, window) {
    if (sentenceWriteLanded(el, expected, start, endAfter, replacement)) return "verified";
    return window && window.userEdited ? "unverified" : "reconciled";
  }

  function sentenceWriteLanded(el, expected, start, endAfter, replacement, opts = {}) {
    const live = snText(el);
    // The corrected span must be exactly what we wrote, and everything BEFORE
    // it untouched. Those two never relax: they are what "the page did not
    // fight us" means.
    if (live.slice(start, endAfter) !== replacement) return false;
    if (live.slice(0, start) !== expected.slice(0, start)) return false;

    const ce = snIsCE(el);
    // Newlines may only be ADDED, and only in a contenteditable, where
    // buildSegmentsForElement synthesises one per block boundary -- an editor
    // wrapping the text in a div legitimately gains them. Forgiving their
    // DELETION too (which stripping them before comparing did) hid a real one
    // the user typed: in a <pre contenteditable>, "Next\nline." reconciled to
    // "Nextline." and this returned true.
    const nl = (t) => (t.match(/\n/g) || []).length;
    if (ce && nl(live) < nl(expected)) return false;
    const norm = (t) => (ce ? t.replace(/\n/g, "") : t);

    // The tail is the only part of this check that has to know WHEN it is
    // running, and the discriminator is not time, it is whether the user has
    // touched the field since the write.
    //
    // Before they have, nothing should have changed at all: any difference is
    // the page fighting us, and `exact` says so.
    //
    // Once they have, the tail is theirs and a change there is not attributable
    // to anyone. This used to allow the tail to GROW, on the reasoning that the
    // user was mid-word in the next sentence -- which is true and only covers
    // typing forwards. Backspacing a character they had already typed, taking
    // an autocomplete, or letting autocorrect replace a word all SHRINK or
    // rewrite the tail, and each of them was read as the page reconciling our
    // write: the correction was logged as thrown away and the field was blocked
    // for the rest of the session, over an ordinary edit that had nothing to do
    // with the correction at all.
    //
    // What survives is the part that IS attributable, and it is the part that
    // matters: the corrected span is still exactly what we wrote and everything
    // before it is untouched, both checked above. Those two cannot be moved by
    // typing after the caret, which is where the anchor guaranteed the caret
    // was. A page that rewrites the tail *while the user is also typing in it*
    // is genuinely indistinguishable from here -- and it is the durability
    // veto, with its byte-exact non-overlap proof, that was built to tell those
    // apart.
    if (opts.tail === "ignore") return true;
    return norm(live.slice(endAfter)) === norm(expected.slice(endAfter));
  }

  /**
   * Hold the scan down for the whole apply, then restart it.
   *
   * Every exit of applySentenceWrite goes through here, which is the point: the
   * window that must be covered is "the write has happened and the watermark
   * has not moved", and half of its exits are early returns. The restart is not
   * optional either -- the trigger is input-driven, and the input that would
   * have fired the next sentence was consumed by the scan that just stood down.
   */
  // --- Verifier trace (diagnostic, text-free, `sentenceDebug` only) ---------
  //
  // The 2026-09-14 review left one residual reconcile class: three
  // `sentence-reconciled` on discord.com, all message-final, every reconcile
  // in both exports followed by a NEW message and never by a continuation.
  // The hypothesis is Enter-to-send inside the verifier's 600 ms window --
  // Discord handles Enter on keydown, submits, resets the Slate model, and no
  // `beforeinput` or `input` fires -- but the log cannot separate a send from
  // a draft clear, a navigation or a remount, and the design of any fix is
  // conditional on which it is. This is the instrument. It records, to the
  // console under the existing `sentenceDebug` flag and nowhere else:
  //   - the apply, as t0;
  //   - every trusted keydown on the tracked root while the verifier is alive:
  //     a NAMED key only (Enter, Escape, Backspace, Tab, an arrow -- any other
  //     key is "char"), modifiers, isComposing, whether the correction was
  //     still in the field AT THAT INSTANT, and whether the element was still
  //     the tracked one;
  //   - `beforeinput` / `input` counts on the root since the previous line;
  //   - at each verifier sample: which branch it took, isConnected, same
  //     element, the empty-composer reading, and the receipt state.
  // Never text, never a hash of text, never an origin: request ids are the
  // `sn_<n>_<ms>` ids already on the record. With the flag off nothing is
  // attached and nothing is emitted; what remains on the hot path is the
  // `trace &&` null checks in the sampler and the sample-name counter, and
  // no verdict or block depends on either (typing [22b] runs the flag ON and
  // requires the same outcomes). Remove once item A's arm is decided.
  function snVerifierTrace(job, el, expected, endAfter, replacement) {
    const t0 = performance.now();
    const ac = new AbortController();
    const NAMED = new Set(["Enter", "Escape", "Backspace", "Tab", "Delete",
                           "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
    let before = 0, input = 0;
    const dt = () => Math.round(performance.now() - t0);
    // "The correction is still in the field": the corrected span and the
    // prefix before it, byte for byte -- the two halves sentenceWriteLanded
    // never relaxes. Not the whole of that check: its tail is exact until the
    // user types, and the user HAS typed by the time an Enter is pressed.
    const present = () => {
      if (!el.isConnected) return false;
      try {
        const live = snText(el);
        return live.slice(job.start, endAfter) === replacement
            && live.slice(0, job.start) === expected.slice(0, job.start);
      } catch { return null; }
    };
    // Its own latch, separate from the verifier's `settled`: a superseded
    // verifier keeps sampling and closing, and the first cut ended the trace
    // once per sample and then claimed `close:verified` at 650 ms over it.
    let closed = false;
    const line = (kind, extra) => {
      if (closed) return;
      sentenceLog("trace", JSON.stringify(Object.assign(
        { id: job.id, kind, dt: dt(), before, input }, extra)));
    };
    before = 0; input = 0;
    document.addEventListener("keydown", (e) => {
      // The tracked ROOT only. A key pressed after focus moved elsewhere is
      // not this field's evidence and must not reset its counters either.
      if (!e.isTrusted || !(e.target === el || el.contains(e.target))) return;
      line("keydown", {
        key: NAMED.has(e.key) ? e.key : "char",
        ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey,
        composing: e.isComposing, present: present(),
        sameEl: !!(sentenceTrack && sentenceTrack.el === el), connected: el.isConnected,
      });
      before = 0; input = 0;
    }, { capture: true, signal: ac.signal });
    document.addEventListener("beforeinput", (e) => {
      if (e.isTrusted && (e.target === el || el.contains(e.target))) before++;
    }, { capture: true, signal: ac.signal });
    document.addEventListener("input", (e) => {
      if (e.isTrusted && (e.target === el || el.contains(e.target))) input++;
    }, { capture: true, signal: ac.signal });
    line("apply", { verdictAt: "sentence-applied" });
    return {
      sample(name, branch, vst) {
        line("sample", {
          sample: name, branch, connected: el.isConnected,
          sameEl: !!(sentenceTrack && sentenceTrack.el === el),
          present: present(), empty: el.isConnected ? snIsEmptyComposer(el) : null,
          editWait: vst ? vst.userEditWait : null,
          editSeq: vst ? vst.userEditSeq : null,
          receiptNull: vst ? vst.userEditText == null : null,
          receiptVia: vst ? vst.userEditVia : null,
        });
        before = 0; input = 0;
      },
      end(reason) { if (closed) return; line("end", { reason }); closed = true; ac.abort(); },
    };
  }

  function applySentence(job, replacement, verdict) {
    sentenceApplying = true;
    return applySentenceWrite(job, replacement, verdict).finally(() => {
      sentenceApplying = false;
      const st = sentenceTrack;
      if (!st || st.el !== job.el) return;
      maybeFireSentence(job.el, false);
      if (!sentenceJob) resumeSentenceScan();
    });
  }

  function spliceWindowTag(w) {
    return w && (w.yielded || w.blocked || w.replayed)
      ? ":window=" + (w.yielded ? "yield/" + w.yielded
                      : w.blocked ? "blocked/" + w.blocked : "replay")
      : "";
  }

  // The splice owns the observation. Both callers consume it without doing
  // another DOM comparison or guessing that every failed transport wrote nothing.
  function spliceFailurePolicy(reason) {
    if (reason === "normalized") return { apply: "sentence-written:", undo: "sentence-undo-unverified", block: "write-normalized" };
    if (reason === "misplaced") return { apply: "sentence-written:", undo: "sentence-undo-unverified", block: "wrote-elsewhere" };
    return { apply: "sentence-skipped:", undo: "sentence-undo-reconciled", block: "write-rejected" };
  }

  function reportSentenceSpliceFailure(requestId, wrote, undo = false) {
    const policy = spliceFailurePolicy(wrote.reason);
    const why = (undo ? "undo:" + wrote.outcome + ":" : "splice-failed:")
      + wrote.reason + spliceWindowTag(wrote.window);
    sentenceSkip(why);
    reportOutcome(requestId, undo ? policy.undo : policy.apply + why);
    return policy.block;
  }

  async function applySentenceWrite(job, replacement, verdict) {
    const el = job.el;
    const before = job.sentence;
    // Built from the live text BEFORE the splice. Reading el.value afterwards
    // and calling that "expected" cannot detect a controlled component that
    // restores its own value synchronously from the input handler execCommand
    // dispatches -- by the time spliceSentence returns, the restored value IS
    // what gets captured, and the next-frame check compares it against itself.
    const live = snText(el);
    const expected = live.slice(0, job.start) + replacement + live.slice(job.end);
    // The provenance baseline as it stands BEFORE the write, captured here
    // rather than read at completion.
    //
    // Everything after the Slate INTENT splice runs in a later tick, and the
    // guarded window YIELDS what it cannot replay -- Backspace, Enter, paste,
    // mousedown. A yielded edit fires a real `input`, which re-baselines
    // `observedText` from a DOM that ALREADY contains the correction; applying
    // the same replacement delta to that at completion produces a baseline that
    // was never in the field, so every later scan refuses until the next
    // keystroke repairs it. Swallowed printable keys are not the issue -- the
    // guard calls preventDefault on their `beforeinput`, so no `input` event is
    // produced and nothing re-baselines. Deriving from the pre-write epoch
    // makes the completion independent of anything that happened in the window.
    const observedBefore = (sentenceTrack && sentenceTrack.el === el)
      ? sentenceTrack.observedText : null;

    // maxlength is checked BEFORE writing, because execCommand does not fail
    // on it -- it returns true and silently TRUNCATES the replacement to fit.
    // Measured on a maxlength="32" field: "The techncian arrived early. The"
    // came back as "The technician arrived early The", one character of the
    // user's own text deleted. And the truncation was then misread as the page
    // reconciling our write, so the field was blocked and nothing was logged:
    // corrupted text, zero signal. Capped fields are not exotic -- X, SMS
    // forms, and most comment boxes have one.
    const cap = snMaxLength(el);
    if (expected.length > cap) {
      // The counter AND the record, which is what `dropSentenceResult` is: the
      // skip counter knows the reason, and the record is the only place it is
      // worth anything. This exit counted and returned, so a correction the
      // model produced and the field could not hold left `verdict: null` --
      // indistinguishable from a request still in flight, which is the exact
      // defect the `sentence-skipped:` vocabulary was added for. It needs no new
      // verdict: the prefix is free-form and already allowlisted.
      dropSentenceResult(job, "maxlength");
      // A refused write takes any flash still on screen with it, so green
      // never sits over a sentence this write did not touch. (This mattered
      // most for suggestion mode's persistent amber mark, removed 2026-09-24.)
      clearSentenceFlash();
      // Reported, not just counted. A refusal the user cannot see is the defect
      // this whole status vocabulary exists for, and "the correction did not
      // fit" is one of the few a user can act on.
      setSentenceStatus("unsafe-range", "maxlength", sentenceFieldStatus(el).family);
      sentenceLog("refused: would exceed maxlength", cap);
      return;
    }

    // The INTENT recipe writes in one tick and then waits for the editor to
    // settle before restoring the caret, so on Slate everything after this
    // point runs in a later tick -- which is safe because the write verifies
    // its own result before reporting a landing, and sentenceWriteLanded
    // re-reads live text rather than trusting anything captured above. The
    // MUTATION recipe is one tick with nothing behind it.
    const lastField = sentenceLastField;
    const wrote = await spliceSentenceVia(el, job.start, job.end, replacement);
    if (!wrote.ok) {
      // Once, covering all three returns below, for the same reason as above.
      clearSentenceFlash();
      // A precondition refusal costs only this sentence. A transport failure
      // blocks the field, but may already have changed it; preserve that
      // observation and the window in both the counter and the record.
      if (wrote.outcome === "failed-transport") {
        const cause = reportSentenceSpliceFailure(job.id, wrote);
        blockSentenceField(el, cause);
        return;
      }
      {
        const why = "splice-refused:" + wrote.reason + spliceWindowTag(wrote.window);
        sentenceSkip(why);
        reportOutcome(job.id, "sentence-skipped:" + why);
      }
      if (wrote.reason === "detached") {
        markSentenceFieldDetached(el, lastField);
        return;
      }
      // A field that stopped being writable, or stopped being an editor we know
      // how to write to, WHILE the request was out is a capability change, not
      // a bad range. Eligibility is only evaluated at attach, so nothing else
      // notices -- and leaving the track running means every later sentence
      // makes a model request that can only end back here.
      if (wrote.reason === "no-adapter" || wrote.reason === "not-writable") {
        const now = sentenceFieldStatus(el);
        if (sentenceTrack && sentenceTrack.el === el) teardownSentence();
        setSentenceStatus(now.status, now.detail, now.family);
        return;
      }
      setSentenceStatus("unsafe-range", wrote.reason, sentenceFieldStatus(el).family);
      return;
    }
    // The tail is judged by whether the USER has touched the field, not by when
    // this runs -- exactly as the async check below does it. The difference is
    // where the fact comes from: the async half watches trusted `input` events,
    // and this half cannot, because the splice SWALLOWED them. A character it
    // replayed or a Backspace it handed back changes the tail, and comparing
    // that exactly recorded a correct write as `reconciled-sync` and blocked the
    // field -- a success punished as corruption, on the commonest path there is
    // once single-character replay started working.
    const wroteWindow = wrote.window || null;
    // A trusted user action during the window ends verification outright -- it
    // does NOT merely relax the tail. `tail:"ignore"` forgives text AFTER the
    // correction and keeps the prefix and the corrected span strict, so a user
    // who clicks to the START of the field and types shifts every offset and is
    // read as the page reconciling us away: a healthy field blocked for the
    // session on an ordinary edit. Forgiving one region was always the wrong
    // shape; the question is whether the result is ATTRIBUTABLE at all, and
    // once the user has touched the field it is not.
    // The window log keys on the WINDOW, exactly as before -- it is what
    // `landedUnverified` below reports, and a write that also verifiably landed
    // is still a window we could not attribute. Only the BLOCK consults the
    // shared disposition, so this branch is behaviourally what it always was.
    const applyDisposition = sentenceWriteDisposition(
      el, expected, job.start, job.start + replacement.length, replacement, wroteWindow);
    if (wroteWindow && wroteWindow.userEdited) {
      sentenceLog("window", "unverified:" + (wroteWindow.yielded || "replay"));
    }
    if (applyDisposition === "reconciled") {
      // Reconciled synchronously. Nothing has been advanced yet, so this just
      // stops -- but it says so on the record first. `sentence-reconciled` is
      // the same verdict the async path writes for the same finding, and this
      // exit returned before ever reaching it.
      sentenceSkip("reconciled-sync");
      reportOutcome(job.id, "sentence-reconciled");
      blockSentenceField(el, "reconciled");
      return;
    }
    // What happened in the window, on the success path. The correction stands,
    // so this is not a failure -- but a cancelled keypress is a silent no-op and
    // an unverified landing is a claim we did NOT check, and both are the class
    // of thing this codebase writes down rather than swallows.
    //
    // They are written down in DIFFERENT PLACES, because they are facts about
    // different things. An unverified landing is a fact about the CORRECTION --
    // it is what became of this request -- so it goes on the record, and
    // `sentence-applied-unverified` is on background.js's allowlist to receive
    // it. A cancelled keypress is a fact about the WINDOW: the correction
    // itself was verified exactly like any other, and folding "we ate a
    // keystroke" into the same verdict would be the collapse of two causes into
    // one name that sentenceFieldStatus was just fixed for. It stays a log line
    // until there is a field on the record for it that is not the verdict.
    const landedUnverified = !!(wroteWindow && wroteWindow.userEdited);
    if (wroteWindow && wroteWindow.blocked) {
      sentenceLog("window", "blocked:" + wroteWindow.blocked);
    }
    const endAfter = job.start + replacement.length;
    // A refusal on the sentence before this one left the status at
    // `unsafe-range`; a correction that landed is the evidence that the field
    // is fine.
    if (sentenceStatus.status === "unsafe-range") {
      setSentenceStatus("active", null, sentenceStatus.family);
    }

    const st = sentenceTrack;
    if (st && st.el === el) {
      setWatermark(st, endAfter);
      // Adopt our own write by DERIVING the new baseline from the old one, not
      // by copying the live field.
      //
      // Copying was the same laundering bug one level down, and it kept the
      // in-flight route alive after `setWatermark` had been fixed: a page that
      // changes the tail after `job.end` still passes the anchor check, our
      // correction lands correctly, and `snText(el)` then contains both our
      // replacement and the page's tail. Reading it back adopts the tail.
      //
      // Derived, the baseline says what the field SHOULD hold if nothing but us
      // touched it. If the page also touched it, the two differ, and the scan
      // chained off this apply refuses -- which is the whole point. No
      // comparison is needed here: being wrong in the safe direction is the
      // desired behaviour, and the next observed input re-baselines anyway.
      //
      // From `observedBefore`, the pre-write epoch -- see its capture above.
      // Reading `st.observedText` here instead would compound a mid-window
      // re-baseline with the delta and produce text that never existed.
      const base = observedBefore != null ? observedBefore : st.observedText;
      if (job.end <= base.length) {
        setSentenceObserved(st, base.slice(0, job.start) + replacement + base.slice(job.end));
      }
    }

    sentenceUndo = { el, requestId: job.id, start: job.start, endAfter, before, after: replacement };
    // Spelled out rather than built from `verdict`, because a derived string is
    // precisely what the allowlist drops in silence. Both callers pass
    // "sentence-applied" today; a third passing anything else would turn
    // `verdict + "-unverified"` into a record that logs NOTHING, with no error
    // anywhere.
    reportOutcome(job.id, landedUnverified ? "sentence-applied-unverified" : verdict);

    // A silent apply shows the flash and nothing else. A control that follows
    // the caret while the user is mid-word in the next sentence is an
    // interruption charged for every correction, and the whole point of this
    // path is that it does not interrupt. Undo is still there: the write goes
    // in with execCommand precisely so it joins the field's own undo stack, so
    // the user's existing habit -- Ctrl+Z -- takes it back. sentenceUndo stays
    // set because watchSentenceEdit uses it to notice a manual revert.
    // A pure deletion inserts nothing, so there is no changed span to paint --
    // fall back to the word that closed up over the gap. See joinRanges.
    const ranges = changedRanges(before, replacement, job.start, "ins");
    const flashRanges = ranges.length
      ? ranges : joinRanges(before, replacement, job.start, "ins");
    // `anchorEnd` is the span ESCAPE needs, which is wider than the words that
    // changed: `sentenceUndoAnchored` checks the whole rewritten sentence, so a
    // flash guarding only as far as the last changed word stayed green while a
    // later word in that sentence was edited and Escape had already died.
    flashSentenceRanges(el, flashRanges, "proofer-sentence-flash",
      { anchorStart: job.start, anchorEnd: endAfter });
    announceToScreenReader(`Proofer corrected: ${describeChange(before, replacement)}`);
    watchSentenceEdit(job.id, el, job.start, endAfter, replacement, before);
    watchSentenceDurability(job.id, el, job.start, endAfter, replacement, before);

    // A controlled component can also reconcile asynchronously. One frame is
    // not enough: a React render behind a debounce lands at 100-400ms, and the
    // checks below are what stop us fighting the page forever.
    //
    // UNLESS THE USER TOUCHED THE FIELD WHILE WE WERE WRITING. Then this check
    // cannot attribute what it finds: a yielded Backspace, a click-and-type, a
    // paste in the middle of the correction are all indistinguishable from the
    // page reconciling us away, and every one of them is the user doing exactly
    // what they are entitled to do. Judging them cost a correct write a blocked
    // field -- twice, once synchronously (round 2) and once here (round 3),
    // because the caller built a FRESH userEdited=false and attached its
    // listener AFTER the splice had already yielded or replayed. So the rule is
    // not "forgive the tail" but "do not ask": verification runs only when the
    // window stayed quiet, and a window with a user action in it is recorded as
    // landed-unverified and never blocks or demotes.
    //
    // WHAT BOUNDS THE COST, AND WHAT DOES NOT. Skipping verification means a
    // revert that happens after a user edit is not caught HERE.
    // watchSentenceDurability is armed above and stays armed, and it is the
    // check built for this -- a byte-exact non-overlap proof on the user's next
    // keystroke. But it is NOT a guarantee: it ends inconclusively when the
    // expected correction is already absent, which is precisely the case where
    // something else removed it. So the honest statement is that durability
    // covers the common revert and not every one.
    //
    // Three ways a change can be laundered into `attributedText` and read as the
    // user's, all documented rather than closed:
    //   - a page rewrite followed by a trusted input, which re-baselines the
    //     whole field;
    //   - editor code mutating the DOM during trusted-input propagation, before
    //     this listener reads it;
    //   - a window event landing before this listener is installed, so the
    //     already-changed text becomes its baseline.
    // The window's own verdict is TERMINAL. If the user acted while the splice
    // held the field, nothing later can attribute what it finds, and the
    // synchronous path has already recorded the correction as
    // landed-unverified -- so there is no async verification to run at all.
    // Previously this was a condition inside the sampler that could stop being
    // true, and the sampler then judged a later change against an expectation
    // built before the user's own edit.
    if (wroteWindow && wroteWindow.userEdited) {
      if (sentenceDebug) sentenceLog("trace", JSON.stringify({ id: job.id, kind: "skipped", reason: "window:user-edited" }));
      return;
    }

    let settled = false;
    const trace = sentenceDebug ? snVerifierTrace(job, el, expected, endAfter, replacement) : null;
    // Where the verifier's evidence comes from, and it is NOT a second listener
    // of its own. It used to run one on `input`, and `input` is the event
    // slate-react does not fire for a period -- it applies the edit through its
    // own model and cancels the default -- so a correction followed within
    // 600ms by "." read as the PAGE having rewritten the field, and the
    // composer was blocked for the life of the content script. Thirty of the
    // thirty-five reconciles in a month of real traffic were discord.com and
    // none was a textarea.
    //
    // Provenance already observes trusted `beforeinput` AND `input`, polls the
    // field until the editor has applied the edit, classifies the result
    // against the bulk cap and fences what it cannot account for. This consumes
    // that conclusion and produces none of its own: it never writes
    // `observedText`, never advances a floor, never authorises a sentence.
    const vst = sentenceTrack && sentenceTrack.el === el ? sentenceTrack : null;
    const editSeqAtWrite = vst ? vst.userEditSeq : 0;
    // Set when a sample found a user edit that explains the mismatch. It does
    // NOT end verification: the later samples stay armed, so a page rewrite
    // arriving AFTER the user's edit still differs from the accounted-for text
    // and still reaches the block. Ending here was the first cut of this fix
    // and it broke exactly that control -- typing continues after a correction
    // lands, so the 150ms sample always found an edit, closed verification, and
    // the page's rewrite at 250ms was never looked at.
    let sawUserEdit = false;
    const markUnverified = () => {
      if (settled) return;
      settled = true;
      // The same identity check the sampler makes, and the finalizer had it
      // only through the sampler. The durability veto clears `sentenceUndo` and
      // reports `sentence-not-durable`; without this, the 650ms close then
      // overwrote that with an applied verdict and a correction the editor had
      // discarded was counted as kept.
      if (!sentenceUndo || sentenceUndo.requestId !== job.id) { if (trace) trace.end("superseded"); return; }
      if (trace) trace.end("unverified");
      // The correction stands and the user did not reject it; what is missing
      // is the proof that the field still holds it, which is a fact about the
      // attribution and not about the correction. `sentence-applied` was
      // already reported, and this is the same distinction the synchronous
      // window makes -- see the allowlist in background.js.
      reportOutcome(job.id, "sentence-applied-unverified");
      sentenceLog("verify", "unverified:user-edit");
    };
    let sampleN = 0;
    const verify = () => {
      const sampleName = ["raf", "150", "600"][sampleN++] || String(sampleN);
      // Identity, not merely "something is there". `sentenceUndo` holds ONE
      // record, so a correction landing inside this one's 600ms window replaces
      // it -- and this closure then judges the newer correction against the
      // older one's `expected`, whose tail still carries the typo the newer one
      // just fixed. `allowTailGrowth` does not save it, because the tail
      // CHANGED rather than grew: correction A is logged as reconciled, the
      // field is blocked, and correction B's undo, edit watch, durability watch
      // and flash are cleared while both writes were perfectly good. A warm
      // response arrives in ~400ms, so two inside 600ms is ordinary.
      if (settled || !sentenceUndo || sentenceUndo.requestId !== job.id) {
        if (trace) { trace.sample(sampleName, settled ? "settled" : "superseded", vst); if (!settled) trace.end("superseded"); }
        return;
      }
      // A REMOUNT is a reconcile too, and the sneakiest one: replaceWith()
      // leaves the spliced text on the detached node, so `el.value === expected`
      // passes while the user sees none of it. Treating a disconnected element
      // as "nothing to check" reported that as a successful apply.
      const gone = !el.isConnected;
      // THE GUARD'S OWN QUESTION FIRST, unchanged, and only a would-be refusal
      // consults the evidence below -- the chain's standing excuse-only shape.
      // The check itself is the SAME one the synchronous path applies: this used
      // to accept any field whose corrected slice survived, which is far looser
      // than it looks, since a controlled component rendering at 100ms could
      // rewrite or delete text anywhere else and still be recorded as a clean
      // apply.
      if (!gone && sentenceWriteLanded(el, expected, job.start, endAfter, replacement)) {
        if (trace) trace.sample(sampleName, "landed", vst);
        return;
      }

      // ATTRIBUTION, NOT FORGIVENESS. Two cases arrive here looking identical
      // -- the user clicks to the start of the field and types "Hey. ", and a
      // controlled component prepends "PREFIX " -- and they need opposite
      // answers. Forgiving a REGION cannot separate them: `tail:"ignore"` kept
      // the prefix strict, so the user's edit blocked a healthy field, and
      // relaxing the prefix too would have let the page's rewrite through. What
      // separates them is provenance.
      // A trusted edit is IN FLIGHT. Checked before the sequence comparison, and
      // that ordering is the whole point: a receipt that has not been published
      // yet leaves `userEditSeq` unchanged, so gating the wait on the sequence
      // made it unreachable in exactly the race it exists for -- beforeinput at
      // 145ms, the editor rendering at 149ms, this sample at 150ms, blocked.
      // `sawUserEdit` is set here too, or a receipt still pending at the last
      // sample closes with no verdict at all.
      if (vst && sentenceTrack === vst && vst.userEditWait > 0) {
        sawUserEdit = true;
        if (trace) trace.sample(sampleName, "receipt-pending", vst);
        return;
      }
      if (vst && sentenceTrack === vst && vst.userEditSeq !== editSeqAtWrite) {
        // The user edited and the observer could not account for the result
        // (fenced as bulk, superseded, or nothing appeared inside its window).
        // Uncertainty about attribution is not evidence that the page took our
        // write, so this ends verification rather than blocking.
        if (vst.userEditText == null) {
          sawUserEdit = true;
          if (trace) trace.sample(sampleName, "receipt-null", vst);
          markUnverified();
          return;
        }
        // Accounted for, and the field still holds exactly that. Say nothing
        // yet: the verdict is written when verification ENDS, so a page rewrite
        // landing after this sample still gets judged by the next one.
        if (snText(el) === vst.userEditText) {
          sawUserEdit = true;
          if (trace) trace.sample(sampleName, "receipt-accounted", vst);
          return;
        }
      }
      if (trace) { trace.sample(sampleName, gone ? "reconciled-remount" : "reconciled-async", vst); trace.end("reconciled"); }

      // The known gaps, stated rather than hidden: a page rewrite followed by a
      // user keystroke re-baselines the observer and is missed; a trusted event
      // is not absolute proof of a human, since a page-called execCommand
      // arrives trusted too. The durability watch is armed above regardless.
      settled = true;
      sentenceSkip(gone ? "reconciled-remount" : "reconciled-async");
      // The apply was already logged. Without this the record keeps saying
      // sentence-applied for a correction the page threw away, and every one
      // inflates the keep rate that decides whether this ships.
      reportOutcome(job.id, "sentence-reconciled");
      sentenceUndo = null;
      stopSentenceEditWatch();
      stopSentenceDurabilityWatch();
      clearSentenceFlash();
      blockSentenceField(el, "reconciled");
    };
    // Kept on the undo record so Escape can end this sampler before it writes:
    // otherwise its 150/600ms callback sees the deliberate undo while
    // `sentenceUndo` still carries this request id, and accuses it of the
    // reconciliation the user just asked for.
    if (sentenceUndo && sentenceUndo.requestId === job.id) {
      sentenceUndo.stopVerify = () => { settled = true; if (trace) trace.end("escape"); };
    }
    requestAnimationFrame(verify);
    setTimeout(verify, 150);
    setTimeout(verify, 600);
    // Past the last sample this has no reader; an attribution still pending at
    // that point is uncertainty, which is unverified rather than a block.
    // Past the last sample this has no reader. An attribution that was still
    // explaining the mismatch at the end is written down here, once, so the
    // record carries one final verdict rather than one per sample.
    setTimeout(() => {
      if (!settled && sawUserEdit) markUnverified();
      else if (trace && !settled) {
        trace.end(sentenceUndo && sentenceUndo.requestId === job.id ? "close:verified" : "superseded");
      }
      settled = true;
    }, 650);
  }

  function describeChange(before, after) {
    const diff = computeWordDiff(before, after);
    const dels = diff.filter((d) => d.type === "del" && d.text.trim()).map((d) => d.text);
    const ins = diff.filter((d) => d.type === "ins" && d.text.trim()).map((d) => d.text);
    if (!dels.length && !ins.length) return after;
    if (!dels.length) return `added ${ins.join(" ")}`;
    if (!ins.length) return `removed ${dels.join(" ")}`;
    return `${dels.join(" ")} to ${ins.join(" ")}`;
  }

  // --- Splice --------------------------------------------------------------
  //
  // A PRECONDITION REFUSAL IS NOT A TRANSPORT FAILURE. Both used to return
  // `false` and both landed in the log as `splice-failed`, which is a
  // measurement that cannot distinguish the two things it exists to tell apart
  // -- and their correct responses are opposite:
  //
  //   refused-precondition  stale range, an atom in the range, a block
  //                         boundary, a live composition, maxlength.
  //                         -> skip this sentence, LEAVE THE FIELD ENABLED.
  //   failed-transport      untrusted-rejected (uncancelled INTENT), ignored,
  //                         execcommand-false, normalized, or misplaced write.
  //                         -> block the field; misplacement demotes the family.
  //   not-durable           it took the write and then discarded it.
  //                         -> demote the transport AND block the field.
  //   landed                verified.
  //
  // The structured reason records what changed, including a mutation that
  // cannot arm a flash or undo slot. Both callers share its failure policy.
  // `window` is what happened to the field WHILE the splice was running, and it
  // is null for every recipe that cannot have anything happen -- MUTATION is one
  // tick. Only the INTENT recipe has a window, and only it fills this in. See
  // `windowRecord` in spliceSentenceSlate for why the caller cannot work it out
  // for itself.
  const spliceLanded = (win = null) => ({ ok: true, outcome: "landed", reason: null, window: win });
  const spliceRefused = (reason, win = null) => ({ ok: false, outcome: "refused-precondition", reason, window: win });
  const spliceFailed = (reason, win = null) => ({ ok: false, outcome: "failed-transport", reason, window: win });

  /**
   * The one place a write picks its recipe.
   *
   * Chosen from the fingerprint BEFORE any write, and only that recipe ever
   * runs -- see SN_TRANSPORTS for why a fallback chain is worse than either
   * recipe on its own.
   */
  /**
   * Elements with a splice in flight. ONE AT A TIME, PER FIELD.
   *
   * The INTENT recipe awaits, and while it is awaiting it holds a capture-phase
   * guard, a swallow buffer and a caret it is about to restore -- all of which
   * assume they are the only writer. A second splice underneath the first
   * invalidates every one of them: two guards fight over the same keystroke,
   * the second computes `caretBefore` from a document the first is mid-way
   * through changing, and both restore carets.
   *
   * It is reachable, and not by anything exotic. `doSentenceUndo` starts a
   * splice of its own, and it is triggered by Escape from a document-level
   * keydown listener registered at injection -- long BEFORE the splice's own
   * capture-phase guard, which therefore never sees the key and cannot swallow
   * it. So: Escape during a correction, and two Slate splices run interleaved.
   * (An earlier version of this comment claimed nothing could re-enter. It was
   * reasoning about the local replay guard, which is a different question.)
   *
   * Refuse rather than queue -- house style, and the right answer here anyway:
   * by the time the first splice finishes, the second's offsets describe a
   * document that no longer exists.
   */
  const sentenceSplicing = new WeakSet();

  async function spliceSentenceVia(el, start, end, replacement) {
    if (!snIsCE(el)) return spliceSentence(el, start, end, replacement);
    const adapter = editorAdapterFor(el);
    // Unreachable through the sentence path -- eligibility required an adapter
    // -- and deliberately not an "it's probably fine" fallback if it ever
    // becomes reachable.
    if (!adapter) return spliceRefused("no-adapter");
    if (adapter.recipe !== "intent") return spliceSentenceCE(el, start, end, replacement, adapter);
    if (sentenceSplicing.has(el)) return spliceRefused("splice-in-flight");
    sentenceSplicing.add(el);
    try {
      return await spliceSentenceSlate(el, start, end, replacement);
    } finally {
      sentenceSplicing.delete(el);
    }
  }

  function spliceSentence(el, start, end, replacement) {
    // Re-checked HERE, not trusted from attach time. Eligibility ran when the
    // field was focused, and the model round trip since then is long enough for
    // a controlled form to set readOnly while submitting or syncing. Without
    // this, execCommand returns false and the field is blocked for the session
    // over a precondition that may be back a moment later.
    if (el.disabled || el.readOnly) return spliceRefused("not-writable");
    const caretS = el.selectionStart, caretE = el.selectionEnd;
    const scrollTop = el.scrollTop, scrollLeft = el.scrollLeft;
    let ok = false;
    applyingRewrite = true;
    try {
      el.setSelectionRange(start, end);
      // execCommand rather than assigning .value: it fires a real input event
      // (so React and Slate see it) and puts the edit on the native undo stack.
      ok = document.execCommand("insertText", false, replacement);
    } catch { ok = false; } finally {
      applyingRewrite = false;
    }
    // Every precondition a textarea has was checked before this point, so a
    // false here means the browser declined the edit outright.
    if (!ok) return spliceFailed("execcommand-false");
    const delta = replacement.length - (end - start);
    try {
      el.setSelectionRange(caretS >= end ? caretS + delta : caretS,
                           caretE >= end ? caretE + delta : caretE);
    } catch {}
    el.scrollTop = scrollTop;
    el.scrollLeft = scrollLeft;
    return spliceLanded();
  }

  /**
   * The same splice against a contenteditable.
   *
   * Wholly SYNCHRONOUS, and that is the entire point. The manual path (removed
   * 2026-09-24) used setSelectionWithSync, which set a selection and then awaited ~16ms so a
   * Slate-style editor can catch its model up. Selecting a sentence and then
   * waiting is destructive by itself: a keystroke landing in that window
   * replaces the selected text, and no check afterwards can recover it -- which
   * makes that asynchronous selection window a demonstrated data-loss path.
   * Setting the range and inserting in one tick leaves no window
   * at all.
   *
   * The cost is that an editor which only reads its own model at beforeinput
   * time may ignore the write or double it. That degrades safely: the caller
   * compares the result against the exact expected text, and a mismatch blocks
   * the element and records a skip. Nothing happens, and it says so.
   */
  /** A collapsed Range at a text offset. rangeForInnerTextOffset needs length > 0. */
  function snCollapsedRange(el, offset) {
    let r = rangeForInnerTextOffset(el, offset, 1);
    if (r) { r.collapse(true); return r; }
    // No character to the right of the very end of the text; take the one to
    // the left and collapse the other way.
    r = rangeForInnerTextOffset(el, Math.max(0, offset - 1), 1);
    if (r) { r.collapse(false); return r; }
    return null;
  }

  /**
   * Is [start, end) safe to replace wholesale -- one uniform run of plain text?
   *
   * range.toString() alone cannot answer this: text nodes on either side of
   * a <b> concatenate with no marker at all,
   * so "The <b>techncian</b> arrived early." stringifies identically to the
   * plain sentence. The check passed, execCommand ran, and the bold was gone --
   * a formatting change nobody asked for, in a sentence the user only wanted
   * spellchecked.
   *
   * Two things have to hold. Every text node the range touches must render the
   * same (so a bold, italic, linked or coloured run inside it is refused), and
   * the range must contain nothing that is not text -- an emoji image, a
   * mention pill, an embed. Those carry no text of their own, so a style
   * comparison cannot see them, and replacing the range would delete them.
   */
  function snRangeIsUniform(el, start, end, range) {
    const { spans } = buildSegmentsForElement(el);
    let sig = null;
    for (const sp of spans) {
      if (sp.end <= start || sp.start >= end) continue;
      if (sp.type !== "text") return false;          // a block boundary inside
      const parent = sp.node.parentElement;
      if (!parent) return false;
      const cs = getComputedStyle(parent);
      const s = [cs.fontWeight, cs.fontStyle, cs.textDecorationLine, cs.fontFamily,
                 cs.fontSize, cs.verticalAlign, cs.color].join("|");
      if (sig === null) sig = s;
      else if (s !== sig) return false;
    }
    if (sig === null) return false;
    try {
      const frag = range.cloneContents();
      // ALLOWLIST, not a blocklist. Enumerating the dangerous tags missed the
      // one that matters most: an <a href> styled `color: inherit;
      // text-decoration: none` -- which is how most in-app links are styled --
      // has a signature identical to the text around it, so the style check
      // above passes and execCommand silently drops the link and its href.
      // Editors wrap text in <span>; anything else in the range is structure
      // or content that replacing the range would destroy.
      // A permitted <span> still has to be CARRYING nothing. An audit found
      // that `<span style="background-color:yellow" title="Ticket 17"
      // onclick="...">` passed: background-color is not in the style signature
      // above, and the tag was on the allowlist, so replacing the range removed
      // a highlight, a tooltip and a handler. So the attributes are allowlisted
      // too -- a span that is pure grouping survives, anything decorated or
      // behavioural does not.
      const SAFE_ATTRS = /^(?:class|dir|lang|data-slate-(?:node|leaf|string))$/;
      for (const node of frag.querySelectorAll("*")) {
        if (node.tagName !== "SPAN") return false;
        for (const a of node.attributes) if (!SAFE_ATTRS.test(a.name)) return false;
      }
    } catch { return false; }
    return true;
  }

  /**
   * The span that actually DIFFERS, inside the sentence the caller named.
   *
   * WHY THE WRITE IS NARROWED, and it is a mechanism rather than a tidy-up.
   * Replacing the whole of a block's text is a NODE-level DOM mutation: the
   * browser empties the text node the editor is managing rather than editing
   * its data. Two of the six certified families reconcile that away, in
   * opposite directions and both silently, and neither is visible when the
   * sentence has anything after it:
   *
   *   Lexical  drops it outright -- execCommand returns true, the DOM never
   *            changes, and the typo stands. Measured 6/6 at every delay from
   *            0 to 600ms after the last keystroke, and 3/3 with one character
   *            of tail at either end (a leading "Hi. ", a trailing " X", a
   *            trailing space, even one character short of the terminator).
   *            The coverage is the whole variable; timing is not a variable at
   *            all.
   *   Draft    DUPLICATES the corrected block over the NEXT one: two
   *            paragraphs, correct all of the first, and the second is
   *            replaced by a second copy of the correction. A paragraph of the
   *            user's own text, destroyed.
   *
   * A sentence that fills its block is not exotic -- it is the ordinary shape
   * of a chat message and of every paragraph holding one sentence, and
   * `nextSentenceTarget` fires on exactly that boundary. A correction shares a
   * prefix or a suffix with the sentence it corrects in every real case, so
   * narrowing turns the write back into an edit WITHIN the node, which is what
   * both editors accept (ProseMirror, TipTap, Quill and Trix accept either).
   *
   * It is a mitigation and not a proof: a correction that changes both the
   * first and the last character still covers the block, and that residue is
   * what the landing check below exists to name rather than mislabel.
   *
   * The PRECONDITIONS are deliberately still asked about the FULL sentence --
   * staleness and uniformity both -- so this narrows what is written and
   * nothing about what is allowed. A sentence crossing a bold run is still
   * refused whole.
   */
  function narrowEdit(before, replacement) {
    const isLow = (c) => c >= 0xDC00 && c <= 0xDFFF;
    // A boundary must not fall between a surrogate pair: cutting there leaves a
    // lone surrogate on each side of the write, which is a different string from
    // the one the guards approved.
    const safeHead = (p) => {
      while (p > 0 && (isLow(before.charCodeAt(p)) || isLow(replacement.charCodeAt(p)))) p--;
      return p;
    };
    const safeTail = (q) => {
      while (q > 0 && (isLow(before.charCodeAt(before.length - q))
                       || isLow(replacement.charCodeAt(replacement.length - q)))) q--;
      return q;
    };
    let p = 0;
    while (p < before.length && p < replacement.length && before[p] === replacement[p]) p++;
    p = safeHead(p);
    let q = 0;
    while (q < before.length - p && q < replacement.length - p
           && before[before.length - 1 - q] === replacement[replacement.length - 1 - q]) q++;
    q = safeTail(q);
    // NEITHER SIDE MAY BE EMPTY, and they run out for opposite reasons. A pure
    // insertion leaves a zero-length RANGE, which this path cannot build --
    // rangeForInnerTextOffset needs a length. A pure deletion leaves an empty
    // insertText, and while Chrome does delete the selection for one in a bare
    // contenteditable (measured), what a rich editor does with a `beforeinput`
    // carrying no data is a branch none of the six families was measured on --
    // and every one of them was measured on a replacement. So give characters
    // back until the write is a replacement again, from the tail first so it
    // still begins where the difference does.
    while ((p >= before.length - q || p >= replacement.length - q) && (p > 0 || q > 0)) {
      if (q > 0) q = safeTail(q - 1);
      else p = safeHead(p - 1);
    }
    return { head: p, tail: q, text: replacement.slice(p, replacement.length - q) };
  }

  function spliceSentenceCE(el, start, end, replacement, adapter) {
    // Before the splice. execCommand moves the caret to the end of what it
    // inserted, so reading it afterwards measures our own write.
    const caretBefore = snCaret(el);
    const beforeText = snText(el);
    const before = beforeText.slice(start, end);
    const range = rangeForInnerTextOffset(el, start, end - start);
    if (!range) return spliceRefused("no-range");
    // range.toString() omits the "\n" buildSegmentsForElement synthesises for a
    // block boundary, so this comparison also refuses any sentence spanning one
    // -- which is precisely the case where replacing the range would collapse
    // the page's own markup.
    if (range.toString() !== before) return spliceRefused("stale-range");
    if (!snRangeIsUniform(el, start, end, range)) return spliceRefused("non-uniform-range");

    // Both preconditions have now been asked about the whole sentence. What is
    // WRITTEN is the differing span inside it -- see narrowEdit.
    const edit = narrowEdit(before, replacement);
    const editStart = start + edit.head, editEnd = end - edit.tail;
    const editRange = (edit.head === 0 && edit.tail === 0)
      ? range
      : rangeForInnerTextOffset(el, editStart, editEnd - editStart);
    if (!editRange) return spliceRefused("no-range");

    const sel = window.getSelection();
    if (!sel) return spliceRefused("no-selection");
    const scrollTop = el.scrollTop, scrollLeft = el.scrollLeft;
    let ok = false;
    applyingRewrite = true;
    try {
      sel.removeAllRanges();
      sel.addRange(editRange);
      ok = document.execCommand("insertText", false, edit.text);
    } catch { ok = false; } finally {
      applyingRewrite = false;
    }
    if (!ok) return spliceFailed("execcommand-false");

    // DID IT LAND? The INTENT recipe has checked its own result since it was
    // written; this one returned `landed` on execCommand's boolean, and that
    // boolean is not the answer -- Lexical returns true over a write it dropped
    // entirely, and Draft returns true over one it duplicated across the next
    // paragraph. The caller then read the same failure one frame later and
    // called it `reconciled-sync`: "the page reconciled our write away", which
    // is a claim about something nobody observed, and the field was blocked for
    // the session under a cause that misnames what happened.
    //
    // Synchronous, because the failure is. Measured across all six certified
    // families: every write that lands is in the DOM in the same tick the call
    // returns, and both failures are already visible in that same tick (Lexical
    // unchanged, Draft duplicated). There is no editor here that writes on a
    // later turn, so the poll the INTENT recipe needs has nothing to wait for.
    //
    // sentenceWriteLanded is the comparison rather than a second copy of it: it
    // already knows that a contenteditable may legitimately GAIN a newline when
    // an editor wraps the text in a block, which raw equality would report as a
    // failed write.
    const expected = beforeText.slice(0, start) + replacement + beforeText.slice(end);
    if (!sentenceWriteLanded(el, expected, start, start + replacement.length, replacement)) {
      // The same three-way split the INTENT recipe draws, and for the same
      // reason: the shared caller policy demotes a FAMILY for `misplaced` and blocks only the
      // element for the other two, so an editor that did nothing and an editor
      // that wrote somewhere else must not share a name.
      const live = snText(el);
      const reason = live === beforeText ? "ignored"
        : (live.slice(start, start + replacement.length) === replacement ? "normalized" : "misplaced");
      // No caret restore and no rollback. The offsets below describe a document
      // this write has just invalidated, and undoing a foreign edit blind is how
      // the user's own work gets destroyed -- see doSentenceUndo.
      return spliceFailed(reason);
    }
    // execCommand leaves the caret at the end of what it inserted, which is
    // where the user was only if they were editing that sentence. They are
    // normally three characters into the NEXT one, so put it back.
    //
    // Restoring it by adding the length delta assumes the only thing
    // that changed is our replacement. An editor that re-renders synchronously
    // from its own input handler can split the field into blocks, and
    // buildSegmentsForElement then synthesises a "\n" the delta knows nothing
    // about -- the caret lands one character early, inside the word the user is
    // typing, and their next keystroke goes in the middle of it.
    //
    // So the arithmetic is CHECKED rather than trusted: the text following the
    // restored position has to be the text that followed the caret before. If
    // it is not, leave the caret where execCommand put it -- visibly at the end
    // of the correction, which the user can see and fix, rather than one
    // character inside a word, which they cannot.
    const delta = replacement.length - (end - start);
    if (caretBefore.start != null && caretBefore.start >= end) {
      const target = caretBefore.start + delta;
      const tailBefore = beforeText.slice(caretBefore.start);
      const live = snText(el);
      if (live.slice(target) === tailBefore) {
        const after = snCollapsedRange(el, target);
        if (after) {
          try { sel.removeAllRanges(); sel.addRange(after); } catch {}
        }
        // Lexical takes the TEXT as a mutation and the SELECTION as an intent:
        // the line above succeeds -- reading the caret back synchronously gives
        // the intended offset -- and one task turn later Lexical has reconciled
        // and re-imposed its own, putting the user's next characters at the end
        // of the correction. Measured 0/8 without this and 3/3 with it.
        if (adapter && adapter.caret === "reimpose") reimposeCaret(el, target, live);
      }
    }
    el.scrollTop = scrollTop;
    el.scrollLeft = scrollLeft;
    return spliceLanded();
  }

  // Two samples: one task turn (where Lexical's reconcile lands) and one at the
  // editor-sync interval, in case a render is debounced behind it.
  const SN_CE_REIMPOSE_MS = 30;

  /**
   * Put the caret back after the editor has reconciled and moved it.
   *
   * Guarded on the text being EXACTLY what the splice left, which is what makes
   * this safe to run late: the moment the user types, the text differs and the
   * caret is theirs. Moving a caret out from under someone mid-word is the
   * failure this whole path is built to avoid, so a miss is preferred to a
   * guess.
   */
  function reimposeCaret(el, target, expectedText) {
    let tries = 0;
    const again = () => {
      if (!el.isConnected || !snIsFocused(el)) return;
      if (snText(el) !== expectedText) return;   // the user typed; their caret wins
      const c = snCaret(el);
      if (c.start !== target || c.end !== target) {
        const r = snCollapsedRange(el, target);
        const sel = window.getSelection();
        if (r && sel) { try { sel.removeAllRanges(); sel.addRange(r); } catch {} }
      }
      if (++tries < 2) setTimeout(again, SN_CE_REIMPOSE_MS);
    };
    setTimeout(again, 0);
  }

  // How long Slate needs to read a DOM selection change into its own model.
  // Measured at 30ms, and 60/120/250 behave identically -- the wait is for one
  // debounced handler, not for a render, so there is nothing to gain by
  // lengthening it.
  //
  // It is no longer spent BEFORE the write -- see spliceSentenceSlate, which
  // selects the sentence and dispatches in the same tick, with the range named
  // on the event. What is left is the settle after the dispatch and the caret
  // restore behind it. The sentence is still selected for the length of one
  // synchronous statement, which is not a window: no task can run in it.
  const SN_CE_SYNC_MS = 30;
  // How long to wait for the WRITE to appear, which is not the same question as
  // how long Slate needs to read a selection, and is much shorter. Slate mutates
  // its model inside our dispatch and React re-renders on a TASK boundary, so
  // one tick is the whole wait -- measured 8/8 in both the clean and the dirty
  // branch, against 0/8 at every microtask depth tried (1, 2, 5, 20 and
  // queueMicrotask), where the field is mid-render and reads a caret of 0.
  //
  // That 0/8 column is also the answer to "why not verify synchronously, before
  // any user action can interleave": there is no such moment. The DOM is stale
  // at every checkpoint that is atomic with respect to user input, so the
  // verification gap cannot be closed, only made small. It was 30ms; it is now
  // one tick, which is ~30x less room for the collision this window guards.
  //
  // AND IT IS POLLED, NOT ASSUMED. One tick is enough on an idle field and
  // sometimes is not under a typing burst: measured 1 burst trial in 12 reading
  // the field before React had re-rendered, concluding `ignored`, and returning
  // that for a correction which was landing as it did so -- which in production
  // blocks the field for a write that worked. The 8/8 above was taken on a
  // quiet page, which is not the condition this ships in. A fixed 30ms hid the
  // problem and a fixed tick reported it wrongly; polling to the same 30ms
  // ceiling is fast in the common case and correct in the rare one.
  const SN_CE_SETTLE_TICK = 0;
  const SN_CE_POLL_MS = 5;
  // Do not write while the user is actually typing. The trigger normally fires
  // three characters into the NEXT sentence, which is the worst possible
  // moment; on a contenteditable we wait for the idle path instead, so the
  // write sits inside a pause the user has already taken.
  //
  // KEPT, and now UNMEASURED as a safety mechanism. It was sized against the
  // pre-write selection window, and that window is gone (spliceSentenceSlate,
  // and test/slate-intent-probe.mjs phase 3): fired deliberately mid-burst, the
  // targetRanges recipe was 12/12 intact against the selection recipe's 8/12,
  // with the other 4 refused as `aborted` rather than damaged. So the reason
  // this deferral was worth its cost in missed corrections no longer applies,
  // and shrinking or removing it is the next experiment -- it is left alone
  // here because that is a change to WHEN a correction is delivered, which runs
  // through deliverSentenceResult and the chip, not through the transport.
  //
  // And note what it never watched: it counts time since the last INPUT, so a
  // user who stops typing and clicks satisfies it immediately. That gap is what
  // made the dirty-map hole reachable, and it is closed in the write rather
  // than here -- a deferral cannot be the guard for something it cannot see.
  //
  // 400 was a guess and it cost most of the corrections. Measured against real
  // Slate, four typos typed at a jittered human cadence, six trials each:
  //
  //     idle    corrections landed
  //     400ms   15/24   (62%)
  //     250ms   20/24   (83%)
  //     150ms   21/24   (88%)
  //
  // Real use reported missing visible feedback. At 400 ms the feature is
  // silent on roughly two sentences in five, and silence is indistinguishable
  // from broken. 250 takes nearly all of the gain; 150 buys ~1 case in 24 for
  // a strictly larger number of aborted writes, and every abort is a replay.
  //
  // This value is a comfort setting, NOT the safety mechanism -- a keystroke
  // inside the window is caught by `bail` and given back by `replaySwallowed`
  // at every value here (0 corrupted sentences in 18 trials across all three).
  // Before that replay existed it WAS a safety setting, badly: characters the
  // user typed were deleted outright.
  const SN_CE_IDLE_BEFORE_MS = 250;
  // How long to let Slate catch up before replaying a swallowed keystroke.
  // Not the same as SN_CE_SYNC_MS and measured separately -- see replaySwallowed.
  const SN_CE_REPLAY_MS = 30;
  // How long the replay will keep asking before it gives up on placing the
  // characters. Slate's selection read is throttled at 100ms and does not run at
  // all while its node map is dirty, so 30ms was inside the lag rather than past
  // it. One poll of headroom beyond the throttle.
  // Slate's selection read is throttled at 100ms and does not run at all while
  // its node map is dirty. Measured on the arrow that exposed this: wrong at
  // +80ms, correct at +150ms, so the ceiling sits past the far end of that
  // bracket rather than inside it.
  const SN_CE_REPLAY_CEILING_MS = 160;

  /**
   * Write to a Slate editor so that Slate's MODEL agrees, not just the DOM.
   *
   * Measured recipe (test/slate-intent-probe.mjs, against real Slate):
   *
   *   1. select the sentence and, IN THE SAME TICK, dispatch
   *      `beforeinput`/insertReplacementText carrying that same span as
   *      `targetRanges: [new StaticRange(range)]`, and let SLATE perform the
   *      edit. Nothing is waited for between the two -- see "both roads" below
   *      for why the selection is set at all when the target range is what
   *      Slate normally reads. execCommand does not work here at any timing:
   *      the characters land in the DOM and the model never learns, so the next
   *      keystroke reverts it.
   *   2. check the result is EXACTLY the sentence replaced in place, and refuse
   *      to report a landing otherwise -- "the text changed" cannot tell a
   *      correction from a correction dumped somewhere else.
   *   3. put the caret back and wait ~30ms, so Slate reads that too. Skipped
   *      once the window has yielded -- the user has taken the caret and
   *      `caretBefore` is a snapshot of where they no longer are.
   *
   * Step 3 matters in exactly one branch, and it took three rounds to say that
   * accurately. When Slate honours the target range it takes a rangeRef of the
   * user's caret and restores it, transformed, by itself -- measured, and why
   * the caret-free arm scored 12/12. When its node map is DIRTY it skips that
   * whole block, and then the caret is left at the end of the correction:
   * measured 29 against a user caret of 45. So step 3 is not belt and braces
   * over Slate, it is the only thing that puts the caret right in the dirty
   * branch -- and `caretIsUsers` exists because everything else in the window
   * has to know which branch it woke up in.
   *
   * SELECT-THEN-WAIT IS GONE, AND THE ABORT WINDOW WENT WITH IT. The recipe was
   * "select the sentence, wait ~30ms for Slate to read the DOM selection into
   * editor.selection, then dispatch insertText". Those 30ms were a window with
   * the sentence SELECTED, in which a keystroke would replace it -- hence the
   * idle deferral in front of it, the swallow, the replay, and a third of all
   * mid-burst writes refused as `aborted`. Taken from Harper's lint framework
   * (packages/lint-framework, replaceRichTextEditorValue), measured here, and
   * the mechanism then read out of the slate-react bundle slatejs.org actually
   * serves:
   *
   *   - slate-react's `onDOMBeforeInput` opens with
   *     `scheduleOnDOMSelectionChange.flush(); onDOMSelectionChange.flush()`,
   *     which is why "just dispatch without waiting" LOOKS like it should work
   *     and does not: those flush a PENDING debounced call, and the browser has
   *     not fired `selectionchange` yet in the same task, so nothing is pending
   *     and editor.selection is still stale. Measured: select + dispatch with
   *     no wait wrote at the old caret, 0/4 idle trials intact.
   *   - it then does `const [targetRange] = event.getTargetRanges()` and, if
   *     that resolves, `Transforms.select(editor, range)` -- taking the range
   *     off the EVENT, at dispatch time, with no DOM selection involved at all.
   *     Chrome hands a synthetic InputEvent's constructed `targetRanges` back
   *     from `getTargetRanges()` during dispatch (measured; phase 1), and
   *     nothing in that handler consults `isTrusted`.
   *   - before adopting it, slate-react takes `Editor.rangeRef(editor,
   *     editor.selection)` and re-selects it at the end of the handler,
   *     transformed by the operations the edit performed. Slate restores the
   *     user's caret itself; step 2 is belt and braces over that.
   *
   * `insertReplacementText` and `insertText` share one branch of that switch,
   * so the inputType is not what buys this -- the target range is. It is the
   * honest one for a spellcheck-style replacement, and it cannot take the
   * `native = true` fast path, which is `insertText` over a collapsed selection.
   *
   * `insertReplacementText` IS in BULK_INPUT_TYPES, and that is not a collision:
   * the bulk guard reads `input` events, and this write produces none. Measured
   * on real Slate -- the only event the whole write emits is the synthetic
   * `beforeinput` above. Slate mutates its model and React re-renders, and a
   * re-render is not a native edit, so no `input` follows to be misread as a
   * paste. (The other `inputType === "insertText"` filter, in
   * watchSentenceDurability, is gated on `isTrusted` and `applyingRewrite`, so
   * it never saw our writes under either inputType.)
   *
   * The swallow and the replay STAY, and they now YIELD. The window in front of
   * the write is gone; the one behind it -- the caret restore and its sync --
   * is not, and a keystroke landing there goes in at the wrong offset. Measured
   * mid-burst, 12 trials: 9 characters swallowed and replayed, 12/12 final
   * texts exact. But the buffer replays as TEXT, so it can only give back a
   * printable character: everything else it used to cancel was destroyed. See
   * `bail` -- unreplayable events now pass through and end the window WHEN the
   * caret is provably the user's, and are cancelled when it is not, because
   * passing one through in the dirty branch applies it to the correction.
   *
   * And what happens in the window is now REPORTED, not just handled. A
   * yielded action or a replayed character changes the field, and the caller
   * compares the field against what it expected before the splice -- so a
   * success looked exactly like a page fighting us, and was recorded as
   * `reconciled-sync` with the field blocked. `windowRecord` is the fix and
   * `applySentenceWrite` branches on it.
   *
   * Two further strippings measured CLEAN and are NOT taken, because what they
   * remove is the last check on a write nobody is watching, and 12 trials of
   * one collision phase is not the evidence for that. Both at 12 idle + 12
   * burst, zero damage: dropping the caret restore entirely and letting Slate's
   * own rangeRef put it back (3 characters still swallowed in the shorter
   * window), and dropping the caret restore AND the swallow together, which is
   * a write with no moving parts at all. They say the same thing the shipped
   * arm does -- the window is gone -- and the shipped arm is the one that was
   * measured with the guards it has. Note what "clean" meant there: those arms
   * were measured against TYPING, and the audit that found the dirty-map hole
   * found it by colliding the write with a SELECTION MOVE instead. A phase that
   * has never been run is not a phase that passed.
   */
  async function spliceSentenceSlate(el, start, end, replacement) {
    const beforeText = snText(el);
    const before = beforeText.slice(start, end);
    const caretBefore = snCaret(el);
    const range = rangeForInnerTextOffset(el, start, end - start);
    if (!range) return spliceRefused("no-range");
    if (range.toString() !== before) return spliceRefused("stale-range");
    if (!snRangeIsUniform(el, start, end, range)) return spliceRefused("non-uniform-range");
    const sel = window.getSelection();
    if (!sel) return spliceRefused("no-selection");
    // Preserve DOM endpoints AND direction, including an expanded selection.
    // Offsets from snCaret alone cannot restore what we are about to replace.
    const selectionBefore = sel.rangeCount ? {
      anchor: sel.anchorNode, anchorOffset: sel.anchorOffset,
      focus: sel.focusNode, focusOffset: sel.focusOffset,
    } : null;
    // The range travels ON THE EVENT. StaticRange refuses a boundary point in a
    // doctype or an attribute node; rangeForInnerTextOffset only ever returns
    // text nodes, so this is a precondition rather than an expected path -- and
    // a refusal, never a quiet fall back to the selection recipe. A fallback
    // chain creates failures neither recipe has on its own (see SN_TRANSPORTS).
    let staticRange;
    try {
      staticRange = new StaticRange(range);
    } catch {
      return spliceRefused("no-static-range");
    }

    let writing = false;
    // What the swallowed keystroke was going to type. Swallowing is mandatory
    // (see below) and on its own it DELETES a character the user typed --
    // measured against real Slate, reproducibly, and it is the worst outcome
    // this path has: no correction AND a hole in the sentence:
    //
    //     typed "We recieved the invoice yesterday."
    //     left  "e recieved the invoice yesterday."
    //
    // Tuning the idle gate does not fix it, it only moves the phase at which
    // the write lands on a keystroke. So the character is captured here and
    // replayed after the caret is restored.
    let swallowed = "";
    let keyTook = false;
    // SWALLOW ONLY WHAT CAN BE GIVEN BACK. The buffer replays as text, so a
    // printable character survives the window and nothing else does: a
    // Backspace, an Enter, an arrow, Ctrl+Z, a paste and an IME start were all
    // CANCELLED here and never replayed, which deletes a user ACTION outright
    // -- the same defect as the deleted character, one level up, and it had
    // been sitting behind the fact that every trial in every phase typed
    // ordinary letters.
    //
    // But letting them through is only safe WHERE THE CARET IS RIGHT, and there
    // is a window in which it is not. Slate takes the rangeRef that restores the
    // user's caret inside the target-range block, and skips that whole block
    // when its node map is dirty -- so in the dirty branch the correction lands
    // correctly (the same-tick selection sees to that) and leaves the caret at
    // the CORRECTION END rather than where the user was. Measured 5ms after the
    // write, user caret 44 and correction ending at 29:
    //
    //     clean   caret 45   = caretBefore + delta, Slate restored it
    //     dirty   caret 29   = the end of the correction
    //
    // A Backspace passed through in that state eats a character of the sentence
    // we just corrected, silently, while the write still reports `landed`:
    //
    //     "The technician arrived early Then we shipped"
    //                                 ^ the correction's own period
    //
    // Measured 4/4 corrupt at +2ms, +10ms and +25ms (probe phase 6, the
    // cross-product of phases 4 and 5 -- each of which tests one half of this
    // and passes). So the gate is not "can I replay it" alone, it is
    // "can I replay it, or is the caret provably the user's": `caretIsUsers`
    // asks the second question, and an unreplayable action arriving before that
    // is true is CANCELLED rather than passed through. A cancelled Backspace is
    // a keypress that did nothing and will be pressed again; a passed-through
    // one is a character of the correction gone. Same asymmetry as everywhere
    // else here -- refuse rather than repair.
    //
    // A CLICK is the exception, and it is why `mousedown` is listened for at
    // all. It cannot corrupt text, it is not cancellable without breaking the
    // page, and it is the user taking the caret back -- so it yields whatever
    // the caret says, and everything after it stops touching the selection.
    // COMPOSITION is the same case: `preventDefault` on compositionstart does
    // not close an IME session, so cancelling it is not on the menu. It yields,
    // and the yield makes the write unverified, which is the honest outcome
    // for an edit we cannot place or judge. (Slate documents Android
    // `beforeinput` as non-cancelable, which would defeat the cancel below --
    // moot here: MV3 extensions do not run on Android Chrome, so this code
    // never meets that platform.)
    //
    // "NEVER CANCEL -- A CANCELLED ACTION IS DELETED USER INTENT" WAS PROPOSED
    // AND IS REFUTED. It is a good principle and it loses to a measurement.
    // Built as a faithful variant (this function yielding instead of
    // cancelling) and run against real Slate in the dirty branch, 4 trials at
    // each of +2ms, +10ms and +25ms:
    //
    //     cancel (this code)   0/4 corrupt   -- the key is a no-op
    //     never cancel         4/4 corrupt   -- "The technician arrived early
    //                                          Then we shipped"
    //
    // That string is the corrected sentence's own period, deleted, because the
    // Backspace was applied at Slate's caret rather than the user's. Both
    // options delete something: cancelling deletes a keypress the user will
    // repeat, yielding deletes a character of the correction that will not come
    // back. The asymmetry rule that governs every other refusal here settles
    // it. Re-run it with PROOFER_CONTENT before proposing this again.
    let yielded = false;
    let yieldKind = null;      // what ended the window, for the record
    let blockedAction = null;  // what we cancelled because the caret was not safe
    let replayed = "";         // what we gave back, for the record
    // Did a TRUSTED event reach this window? `bail` must handle every event
    // that could disturb the write, trusted or not -- an editor's own synthetic
    // insert moves the text just as surely. But only a real user event is
    // EVIDENCE of a user edit, and the window record is consumed as evidence.
    // Without this, an editor that dispatches its own input during the window
    // could end verification for a correction nobody touched.
    let sawTrusted = false;
    // Set only when the repair actually MOVES the caret, which is the dirty
    // branch. In the clean branch Slate has already put it where we would, so
    // nothing is pending and a user action in that window is still handed
    // straight through.
    let caretRepairPending = false;
    // STICKY, and deliberately never cleared. Once the editor's idea of the
    // caret has disagreed with the user's even once during this write, nothing
    // in the remaining ~60ms can re-establish where an action would land: while
    // its node map is dirty Slate REFUSES to read the DOM selection at all and
    // retries on a 100ms throttle, so no sync of ours can be waited out. The
    // evidence for that is a measured contradiction -- at +80ms a Backspace
    // landed correctly (its own beforeinput flushes the pending read first)
    // while an ArrowLeft at the same instant moved from 29 to 28 (it has no
    // beforeinput, so it used whatever the DOM held). Two actions, one moment,
    // different answers: the state is racy rather than merely late, and the
    // only sound response is to stop placing things until the guard detaches.
    let caretUntrusted = false;
    // Has the poll below finished deciding what the write did? Until it has,
    // nothing may be placed: the outcome is unknown and the editor's selection
    // and the DOM's disagree on the dirty branch.
    let settledWrite = false;
    // The text as it stood when we handed control back -- read in the CAPTURE
    // phase, before the editor acts on the event, so it still holds only our
    // write's effect. Without it, the exactness check below cannot tell a
    // misplaced write from the user's own Backspace.
    let textAtYield = null;
    // Was the write already seen to land when we yielded? If not, the snapshot
    // predates it and is not evidence about what the write did.
    let yieldAfterSettle = false;
    /**
     * Is the caret provably where the USER left it?
     *
     * `caretBefore` is read at entry, before anything of ours has run, so it is
     * their position; the correction shifts everything after `end` by `delta`.
     * Anything else -- the correction end in the dirty branch, a DOM selection
     * React has not re-imposed yet, an expanded range -- is unknown, and unknown
     * is unsafe. Deliberately conservative: it also answers false when the caret
     * was inside the sentence, which the anchor does not allow but this does not
     * assume.
     */
    /**
     * What happened in the window, for the CALLER.
     *
     * The splice is the only thing that knows: it swallows the events, so they
     * never reach the `input` listener `applySentenceWrite` uses to ask the same
     * question after the fact. Without this, a correctly replayed character or a
     * yielded Backspace changes the tail, the caller's exact-tail comparison
     * fails, and a SUCCESS is recorded as `reconciled-sync` and blocks the
     * field -- the page punished for an edit the user made and we handed back.
     * Fixing the single-character replay is what made that common rather than
     * theoretical.
     */
    function windowRecord() {
      const replayedText = replayed;
      if (!yielded && !replayedText && !blockedAction) return null;
      return {
        // The one field the caller branches on. DELIBERATELY WEAK EVIDENCE, and
        // safe because of what it is now allowed to do. It means "something
        // happened in this window that we could not place or replay" -- an
        // arrow, a mousedown, a composition start, an attempted replay -- and
        // not "the user provably mutated text": `bail` does not check
        // isTrusted, and a replay is counted when it is dispatched rather than
        // when it is observed to land.
        //
        // That was a real objection while this bit could WAIVE a blocking check
        // (an editor's own synthetic event could buy a correction a pass). It
        // no longer can: under the settled semantics this bit only ever ENDS
        // verification, never relaxes it. The failure mode of a false positive
        // is now "we declined to judge a write we could have judged", which
        // costs a missed reconcile detection that the durability watch still
        // covers -- and never a bad write accepted.
        userEdited: !!((yielded || replayedText) && sawTrusted),
        yielded: yieldKind,
        replayed: replayedText || null,
        blocked: blockedAction,
      };
    }
    /**
     * The positional question alone: is the caret, RIGHT NOW, where the user
     * left it (shifted by the correction)?
     *
     * Separate from `caretIsUsers` because the two are asked for different
     * purposes. A YIELD has to decide in the instant the event arrives and can
     * never be revisited, so it also honours the sticky evidence. A REPLAY is
     * ours to place, happens ~60ms later, and goes in through a `beforeinput`
     * that makes Slate flush and read the DOM selection -- so if the caret is
     * right at that moment, it is right.
     *
     * Asking the sticky question there was costing the user characters: a
     * single transient sample reading the correction end in an otherwise clean
     * burst set the flag permanently, and the buffer was then dropped.
     * Measured at roughly 1 burst trial in 12, twice, as
     * "The technician arrived early. Weecieved the invoice." -- two characters
     * of their own typing gone, on a write reported as landed.
     */
    function caretIsUsersNow(opts = {}) {
      if (caretRepairPending) return false;
      if (caretBefore.start == null || caretBefore.start < end) return false;
      const c = snCaret(el);
      if (c.start == null || c.start !== c.end) return false;
      // EVERY CHARACTER WE HAVE ALREADY GIVEN BACK MOVED THE CARET. Without
      // this term the target is the caret as it stood before the first replay,
      // so the moment one batch is returned the next batch can never prove
      // itself and is dropped -- the swallow happening and the replay not.
      // Traced on real Slate in a continuous burst: `swallow e`, `replayInto e`
      // at caret 32, `swallow n`, and then nothing, leaving
      // "The technician arrived early. The we shipped..." with the "n" gone.
      // A second batch is ordinary when typing never pauses, which is exactly
      // the case a 3-characters-then-fire probe does not produce.
      const shifted = caretBefore.start + (replacement.length - before.length) + replayed.length;
      if (c.start === shifted) return true;
      // THE ORIGINAL CARET IS ONLY THE USER'S WHERE THE WRITE DID NOT LAND, and
      // `allowOriginal` is how the one context that knows says so. It exists for
      // the `ignored` path, where nothing moved and `restore()` has just put the
      // caret back; testing only the shifted position there refused the replay
      // and dropped the swallowed keystroke.
      //
      // It must NEVER be consulted while deciding whether a live action may pass
      // through, and the counter-example is one character wide. Typo 28,
      // correction 29, user caret one character past the sentence at original
      // offset 29 and shifted offset 30. Dirty Slate leaves ITS caret at the
      // correction end -- also 29. The alias then reads Slate's caret as the
      // user's, a Backspace is handed through, and it eats the correction's
      // period while the composed verification path still reports it applied.
      // A ±1 delta is the commonest correction there is.
      // AND THE ALIAS IS REFUSED WHERE IT IS AMBIGUOUS. The original caret and
      // the correction end can be the SAME offset -- that is blocker 1's ±1
      // coincidence -- and there no reading of the caret can tell the user's
      // position from Slate's. Claiming it for the replay put the user's
      // character at the boundary: measured 2 trials in 8,
      // "The technician arrived early.z Then we shipped", offset 29 with the
      // user at 30.
      //
      // Away from that coincidence the alias is unambiguous and is what keeps an
      // ordinary burst from losing characters (3/16 without it, and 3 runs in 4
      // through the end-to-end suite). So the test is not "may I use it" but
      // "can it be confused here", and it is a comparison rather than a guess.
      if (!opts.allowOriginal) return false;
      // ASK THE DOCUMENT, NOT A SNAPSHOT. `allowOriginal` means "the write did
      // not land, so the user's caret never moved" -- and the only trustworthy
      // source for that is the text as it stands right now. A frozen
      // pre-write snapshot can report `ignored` for a write that landed, and
      // both of the previous attempts here trusted one:
      //
      //   - refusing whenever caretBefore coincides with the correction end
      //     compared against a correction that, on the genuinely-ignored path,
      //     does not exist -- and dropped the buffer outright ("Th" lost,
      //     traced against an editor that ignores the dispatch);
      //   - not refusing at all put the user's character at the correction end
      //     when a landed write had been misreported (1 trial in 8).
      //
      // Reading the span decides it correctly in both: absent means the caret
      // really is unshifted, present means fall through to the strict test and
      // refuse rather than guess.
      if (snText(el).slice(start, start + replacement.length) === replacement) return false;
      return c.start === caretBefore.start + replayed.length;
    }
    function caretIsUsers() {
      // STRICT. No `allowOriginal` -- see the counter-example above.
      // A caret WE have just written is not evidence. `snCaret` reads the DOM
      // selection, which is the one thing here we control, so between setting
      // it and Slate reading it back this returned true while Slate's model was
      // still at the correction end -- and an arrow let through on that basis
      // moved from 29 to 28 instead of from 32 to 31. Measured at +80ms, which
      // is inside the sync that exists for precisely this lag.
      if (caretUntrusted) return false;
      return caretIsUsersNow();
    }
    function detach() {
      document.removeEventListener("beforeinput", bail, true);
      document.removeEventListener("keydown", bail, true);
      document.removeEventListener("compositionstart", bail, true);
      document.removeEventListener("mousedown", bail, true);
      document.removeEventListener("paste", bail, true);
    }
    /** Put the buffer back NOW, in this tick, so it lands before whatever we are yielding to. */
    function flushSwallowedSync() {
      replayInto(swallowed);
      swallowed = "";
    }
    /**
     * Type text back into the editor through the transport it actually honours.
     *
     * NOT `insertText`, and the difference is WHEN the character arrives.
     * slate-react has a fast path -- `native = true` -- for `insertText` with a
     * COLLAPSED selection and data that is a single character matching
     * /[a-z ]/i. On that path it deliberately does NOT call preventDefault and
     * pushes its own insert onto a queue, behind the BROWSER performing the
     * edit. An untrusted event has no default action, so the queue is not
     * drained and nothing appears. Measured on real Slate at a collapsed caret
     * after "hello", 3 trials, read immediately AND after one more keystroke:
     *
     *                              defaultPrevented  immediate  after next key
     *     insertText            "z"      0/3            0/3          3/3
     *     insertText            " "      0/3            0/3          3/3
     *     insertReplacementText "z"      3/3            3/3          3/3
     *     insertReplacementText " "      3/3            3/3          3/3
     *
     * DEFERRED, NOT DESTROYED -- the correction to a first reading of this, and
     * the distinction matters because it names the actual cost. The next input
     * event flushes the queue, so a user who keeps typing never sees it. What
     * is lost is the case where the swallowed keystroke was the LAST thing they
     * typed: they pause, and the character is simply not there -- and in a chat
     * client the next thing pressed is Enter, which sends the message before
     * the queue drains. It also means any read of the field in between --
     * sentenceWriteLanded, the durability watch -- sees text the user did not
     * write. (`insertText` with two or more characters, or with anything
     * outside [a-z ], never takes the fast path and lands at once, which is why
     * every phase that typed a burst missed this.)
     *
     * The fast path is keyed on the inputType, so naming the event honestly
     * removes the deferral window entirely.
     */
    function replayInto(text) {
      if (!text || !el.isConnected) return;
      replayed += text;
      writing = true;
      try {
        el.dispatchEvent(new InputEvent("beforeinput", {
          inputType: "insertReplacementText", data: text,
          bubbles: true, cancelable: true, composed: true,
        }));
      } catch {} finally { writing = false; }
    }
    /** Hand the window back: stop guarding, stop touching the selection. */
    function yieldWindow(kind) {
      if (yielded) return;
      yielded = true;
      yieldKind = kind;
      textAtYield = snText(el);
      yieldAfterSettle = settledWrite;
      // Order matters more than tidiness: characters typed BEFORE this event
      // have to be back in the field before the event we are letting through
      // acts, or a Backspace deletes the wrong character. Synchronous, so it
      // lands first.
      //
      // BUT ONLY WHERE THE CARET IS PROVEN. This flush had no positional gate
      // at all, which made `char` then `click` -- and `char` then IME start --
      // insert the buffered character at the correction end on dirty Slate. The
      // async replay has been gated since round 3; this path is the same
      // insertion through a different door and needs the same proof.
      //
      // Unproven means HOLD, not drop: the buffer stays and the resolution below
      // replays it once the caret is provable. The case that still loses the
      // character is a yield whose caret is never provable afterwards -- the
      // user clicks away on dirty Slate and the click moves the caret before we
      // can place anything. There the choice is between losing the character and
      // inserting it into the sentence we just corrected, and it goes the same
      // way as every other unplaceable action here: refuse, and record
      // `blocked: "replay"` so the record says so.
      //
      // THIS GATE IS ARGUED, NOT MEASURED, and that is worth stating plainly. It
      // was added on an audit's reading of the code, and no failing input for it
      // exists: `char` then `click` and `char` then IME start were driven on the
      // DIRTY branch at +2, +40 and +80ms against a deliberately UNGATED build,
      // and every cell placed the character at the user's caret, exactly as the
      // gated build does (probe phase 6, and the assertion is exact -- an
      // earlier version of it could not see a character at the correction end at
      // all, and passed the ungated build for that reason instead).
      //
      // There is a mechanism that would explain the miss rather than excuse it:
      // the flush goes out as `insertReplacementText`, and that makes Slate
      // flush its pending selection reads and adopt the DOM selection -- which
      // our repair has already set correctly. If that is why, the gate is
      // redundant rather than wrong. It stays because it is fail-closed and free
      // when the caret is provable, but nobody should cite it as a measured
      // protection.
      // AND NOT BEFORE THE WRITE HAS SETTLED. `caretIsUsersNow` proves the DOM
      // caret, but this flush is placed by SLATE, at its model selection -- the
      // same distinction that made the guard outlive the DOM proof further down.
      // Before the settle those two disagree by construction on the dirty
      // branch: the DOM can already read the user's caret while Slate still
      // holds the correction end, so the gate passed and the character went in
      // at the boundary anyway. Measured on the fixed build at +2ms, 2 trials in
      // 8: "The technician arrived early.z Then we shipped" -- offset 29, the
      // correction end, where the user is at 30.
      //
      // Unsettled therefore means HOLD, and the resolution replays it once the
      // outcome is known and the caret repaired. Ordering is preserved where it
      // can be and abandoned where it cannot: a character placed in the
      // correction is worse than a character that arrives after the click.
      if (settledWrite && caretIsUsersNow()) flushSwallowedSync();
      detach();
    }
    /**
     * Cancel an action we can neither replay nor safely let through.
     *
     * Only reached while the caret is not provably the user's -- see
     * `caretIsUsers`. It costs them a keypress; passing it through costs them
     * a character of the sentence we just corrected.
     */
    function blockAction(e, kind) {
      blockedAction = kind;
      if (e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
    }
    const bail = (e) => {
      if (writing) return;                 // our own dispatched event
      if (e.isTrusted) sawTrusted = true;
      if (yielded) return;                 // control is already back with the user
      // A click cannot corrupt text and cannot be cancelled without breaking
      // the page. It is the user taking the caret back, so it always wins.
      if (e.type === "mousedown") return yieldWindow("mousedown");
      // Composition is not cancellable in any meaningful sense either -- an IME
      // session is already open by the time this fires, and fighting it is
      // worse than any caret it might start at.
      if (e.type === "compositionstart") return yieldWindow("composition");
      // A paste that never becomes a `beforeinput`: Slate cancels plain-text
      // `paste` itself and calls insertData, so the menu, mobile and
      // accessibility routes bypass both of the hooks below.
      if (e.type === "paste") {
        return caretIsUsers() ? yieldWindow("paste") : blockAction(e, "paste");
      }
      // ACCUMULATE. Capturing only the first was measured and was not enough:
      // a fast burst puts two keystrokes in the window and the second vanished
      // exactly as before ("I seperate..." -> "seperate...", "The meeting" ->
      // "he meeting"). Every swallowed character has to come back, in order.
      if (e.type === "keydown") {
        // keydown fires FIRST, and stopping it means no beforeinput ever comes
        // for this key -- so the character has to be read off the key here.
        // Printable only: a modifier or an arrow types nothing and replaying
        // "Shift" would insert five letters.
        keyTook = !!(e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey);
        if (!keyTook) {
          return caretIsUsers() ? yieldWindow("key:" + e.key) : blockAction(e, "key:" + e.key);
        }
        swallowed += e.key;
      } else if (e.type === "beforeinput") {
        // Anything that is not a plain text insertion -- a delete, a paste, an
        // undo, a line break -- cannot be replayed from a string.
        if (e.inputType !== "insertText" || !e.data) {
          return caretIsUsers()
            ? yieldWindow("input:" + e.inputType)
            : blockAction(e, "input:" + e.inputType);
        }
        // Reached with data only when no keydown preceded it -- IME commit,
        // dictation, an editor's own synthetic insert. `keyTook` stops the
        // ordinary case being counted twice, once off the key and once off the
        // data.
        if (!keyTook) swallowed += e.data;
      }
      if (e.cancelable) e.preventDefault();
      // preventDefault alone is not enough, and the difference is the whole
      // guard. It stops the BROWSER performing the edit; Slate does its own,
      // from its own handler, and does not consult defaultPrevented. Measured:
      // with preventDefault only, a keystroke in the window still replaced the
      // selected sentence -- "X Then we shipped" -- while the write correctly
      // reported that it had failed. The event has to not reach the editor.
      e.stopImmediatePropagation();
      e.stopPropagation();
    };
    // Capture phase, and on the document: the editor's own handler must not see
    // the event first and act at an offset the correction is about to move.
    document.addEventListener("beforeinput", bail, true);
    document.addEventListener("keydown", bail, true);
    document.addEventListener("compositionstart", bail, true);
    document.addEventListener("mousedown", bail, true);
    document.addEventListener("paste", bail, true);

    const scrollTop = el.scrollTop, scrollLeft = el.scrollLeft;
    const restore = () => {
      const back = caretBefore.start != null ? snCollapsedRange(el, caretBefore.start) : null;
      if (back) { try { sel.removeAllRanges(); sel.addRange(back); } catch {} }
    };

    /**
     * Give back the keystroke the bail handler ate.
     *
     * Whatever landed in the window behind the write, in the order it was
     * typed. The caret has just been put where it belongs and this types those
     * characters there, through the same route the correction itself uses. The
     * sync wait is the same one and for the same reason -- Slate acts on
     * `editor.selection`, which is debounced behind the DOM selection the caret
     * restore just set. (It carries no target range on purpose: this is an
     * insertion at the caret, and there is no span to name. See `replayInto`
     * for why it is not dispatched as `insertText`.)
     *
     * If it fails, it fails silently: the character is already gone, and there
     * is nothing better to do than leave the field as the user last saw it.
     */
    // THE REPLAY MAY CONSULT THE ORIGINAL-CARET ALIAS; THE LIVE GATE MAY NOT.
    // That is the whole of the distinction blocker 1 was about, and scoping it
    // to the `ignored` path alone was too tight by one context: measured, a
    // strict replay drops the user's characters in an ordinary burst -- 3 trials
    // in 16 here ("We ecieved"), and another agent's end-to-end suite saw the
    // same thing at 3 runs in 4, reproducing all three of this file's canonical
    // loss strings including "...arrived early.We recieved...".
    //
    // It is safe HERE and unsafe THERE because of what each one licenses. The
    // live gate hands an action to the editor to place, so accepting Slate's
    // correction-end caret as the user's lets a Backspace eat the correction.
    // This places an insertion itself, and it cannot reach the correction-end
    // coincidence at all: `caretIsUsersNow` returns false on `caretUntrusted`
    // BEFORE the alias is consulted, and `caretUntrusted` is exactly the dirty
    // branch where Slate leaves its caret at the correction end. In the clean
    // branch Slate has restored the user's caret itself and there is no
    // correction-end caret to be confused with.
    let replayOpts = { allowOriginal: true };
    async function replaySwallowed() {
      // Stay attached through the wait, and detach only once there is nothing
      // further to collect. Detaching first was measured and produced a
      // TRANSPOSITION -- the user's next character went in directly while ours
      // was still waiting on the sync, and came back behind it:
      //
      //     typed "We recieved..."  ->  "eW recieved..."
      //
      // Keeping the handler on means every keystroke in the window joins the
      // same buffer and they all go back together, in the order they were typed.
      if (!el.isConnected) { detach(); return; }
      // POLL FOR THE PROOF; DO NOT DETACH ON A TIMER. The old form waited one
      // fixed SN_CE_REPLAY_MS and then decided, which is shorter than the lag
      // this file documents a few lines up: Slate's own selection read is
      // throttled at 100ms and REFUSES to run at all while its node map is
      // dirty, so a caret that is not provable at 30ms is routinely provable
      // later. Deciding at 30ms turned "wait a moment longer" into "drop the
      // user's characters", and detaching at the same moment left the guard off
      // while the caret was still wrong -- the next keystroke then landed inside
      // the correction, which the probe's `blocked` bucket scored as success.
      //
      // The ceiling comes from that measured 100ms throttle plus a poll of
      // headroom, not from taste.
      // PROVING THE DOM CARET IS NOT THE SAME AS THE EDITOR AGREEING, and the
      // guard must outlive the second one. In the dirty branch our repair sets
      // the DOM selection and Slate does not read it for up to its own 100ms
      // throttle -- so a poll that detached the moment the DOM looked right left
      // the field unguarded while Slate still held the correction end. Measured:
      // an ArrowLeft at +80ms then moved from Slate's 29 rather than the user's
      // 30, landing the caret at 28 -- inside the correction, where the next
      // printable key goes. At +150ms the same arrow is correct, so the lag
      // resolves between the two.
      //
      // The replay still goes as soon as it is provable (it carries a
      // `beforeinput`, which makes Slate flush and adopt the DOM selection, so
      // its own placement is safe at that moment). What waits is the DETACH, and
      // only where the caret needed repairing at all: the clean branch has no
      // lag to cover because Slate restored the caret itself.
      // TWO PATHS, AND THE CLEAN ONE IS LEFT EXACTLY AS IT WAS MEASURED.
      // Holding the guard attached costs characters during a burst: every extra
      // pass is another window in which a keystroke is swallowed and has to be
      // handed back, and each hand-back is a round trip that can race the next
      // key. Extending the hold to cover Slate's selection lag took the clean
      // branch from 16/16 to 13/16 and then to 11/16 when I tried to drain the
      // buffer more often -- the fix made it worse because the hold, not the
      // drain, was the cost.
      //
      // The lag being covered only exists where the caret needed repairing, so
      // the hold belongs there and nowhere else. In the clean branch Slate
      // restored the caret itself, there is nothing to wait for, and this stays
      // one pass exactly as it was when it measured 16/16. In the dirty branch
      // the user's actions are being cancelled anyway, so a longer hold costs
      // no characters -- there is nothing being typed into it that we would
      // otherwise have let through.
      if (!caretUntrusted) {
        await new Promise((r) => setTimeout(r, SN_CE_REPLAY_MS));
        const text = swallowed;
        swallowed = "";
        detach();
        if (!text || !el.isConnected || !snIsFocused(el)) return;
        if (!caretIsUsersNow(replayOpts)) { blockedAction = blockedAction || "replay"; return; }
        replayInto(text);
        return;
      }
      const holdMs = SN_CE_REPLAY_CEILING_MS;
      // EVERY PASS, not once. The buffer is not closed when the first replay
      // goes out: the guard is still attached, so a burst keeps filling it, and
      // taking it a single time left everything typed afterwards swallowed and
      // never given back -- measured as 3 burst trials in 16 losing exactly one
      // character ("We ecieved"), which is this function's own defect wearing
      // the shape it exists to prevent. Holding the guard longer made it
      // reachable; draining on each pass is what makes holding safe.
      const drain = () => {
        if (!swallowed) return;
        if (!caretIsUsersNow(replayOpts)) return;
        const t = swallowed;
        swallowed = "";
        if (snIsFocused(el)) replayInto(t);
      };
      for (let waited = 0; ; waited += SN_CE_REPLAY_MS) {
        await new Promise((r) => setTimeout(r, SN_CE_REPLAY_MS));
        if (!el.isConnected) { detach(); return; }
        drain();
        if (waited >= holdMs) break;
      }
      drain();                     // one last chance for anything typed at the edge
      if (swallowed) {
        // Never provable. Keep the characters out of the correction and say so
        // on the record.
        swallowed = "";
        blockedAction = blockedAction || "replay";
      }
      detach();
    }
    try {
      // BOTH ROADS, POINTED AT THE SAME SPAN. Slate reads the event's target
      // range only when its node map is clean, and its own handler is what
      // dirties it: it opens by FLUSHING any pending selection read, and that
      // read runs `Transforms.select`, whose `set_selection` sets
      // IS_NODE_MAP_DIRTY. The target range is then skipped and the switch
      // inserts at whatever the flush just selected -- so a user click a task
      // turn before the dispatch silently moved the correction to the click.
      // Measured (test/slate-intent-probe.mjs phase 4), with the selection
      // moved and the write fired at 0/1/2/4/8/16 ms after:
      //
      //     no selection set    0/4 correct at 0ms, 4/4 at every other delay
      //     selection set here  4/4 correct at EVERY delay
      //
      //     "The techncian arrived early. WeThe technician arrived early. ..."
      //      ^ the typo survives and the correction lands at the caret
      //
      // Setting the DOM selection is what closes it, because the flush reads
      // the CURRENT DOM selection: the dirty branch then selects the sentence
      // and replaces exactly the span the clean branch would have. This is NOT
      // the old select-then-wait -- there is no await between here and the
      // dispatch, so there is still no window for a keystroke to land in. The
      // wait was the window; the selection never was.
      sel.removeAllRanges();
      sel.addRange(range);
      applyingRewrite = true;
      writing = true;
      try {
        const event = new InputEvent("beforeinput", {
          inputType: "insertReplacementText", data: replacement,
          targetRanges: [staticRange],
          bubbles: true, cancelable: true, composed: true,
        });
        el.dispatchEvent(event);
        // Stock desktop Slate cancels every non-native insertion it handles.
        // Since slate-react 0.128 it ignores untrusted events before doing so.
        // Decide SYNCHRONOUSLY: yielding first would swallow keys whose replay
        // the same editor also ignores. Source audit: test/results/slate-fix/source-history.json.
        if (!event.defaultPrevented) {
          sel.removeAllRanges();
          if (selectionBefore) sel.setBaseAndExtent(selectionBefore.anchor, selectionBefore.anchorOffset, selectionBefore.focus, selectionBefore.focusOffset);
          return spliceFailed("untrusted-rejected"); // outer finally detaches in this tick
        }
      } finally {
        writing = false;
        applyingRewrite = false;
      }

      // Wait for the write to APPEAR -- see SN_CE_SETTLE_TICK for why this is a
      // poll and not a sleep.
      let observed = null;
      for (let waited = 0; ; waited += SN_CE_POLL_MS) {
        await new Promise((r) => setTimeout(r, waited === 0 ? SN_CE_SETTLE_TICK : SN_CE_POLL_MS));
        if (!el.isConnected) return spliceRefused("detached", windowRecord());
        // Read the text ONCE per pass, and from the yield snapshot when there
        // was one: the user's own Backspace is not evidence about where our
        // write landed, and comparing against a field they have since edited is
        // how a correct write gets reported as misplaced.
        observed = yielded ? textAtYield : snText(el);
        if (observed !== beforeText || waited >= SN_CE_SYNC_MS) break;
      }
      settledWrite = true;
      // Nobody handled it. A synthetic `beforeinput` only writes if the editor
      // chooses to act on it, so an editor that does not -- or a DOM with no
      // editor behind it at all -- leaves the text exactly as it was. Report
      // failure here rather than returning true and letting the later checks
      // discover it, which would log an apply that never happened.
      //
      // This exit swallowed a keystroke and never gave it back, for the whole
      // life of the function: every other exit replayed and the "nobody handled
      // it" path in between did `restore(); return false;`. Same defect class
      // as the three holes already fixed -- and it is a character of the user's
      // own text, deleted outright.
      //
      // `restore()` undoes OUR selection of the sentence, which would otherwise
      // sit expanded under a replay and delete it. It is skipped once we have
      // yielded, and that is not tidiness: a mousedown yield means the user has
      // just put the caret somewhere, and `caretBefore` is a snapshot of where
      // they were. Restoring over a click is the same defect as restoring over
      // one on the success path -- failing is not a licence to move the caret.
      //
      if (observed === beforeText) {
        if (!yielded) restore();
        replayOpts = { allowOriginal: true };
        await replaySwallowed();
        return spliceFailed("ignored", windowRecord());
      }

      // IT WROTE -- BUT WHERE? "Something changed" was the whole test, and it
      // cannot tell a replaced sentence from a replacement dumped at the user's
      // caret with the typo left behind, which is exactly what the dirty-map
      // path above produces. So the claim is checked against the text this
      // splice was supposed to produce, character for character, BEFORE it is
      // reported as landed. A wrong-location write is a `failed-transport`, and
      // the caller demotes the whole family for it: an editor that writes
      // somewhere other than where it was asked must not be given a second
      // sentence, and a React remount would otherwise hand us a fresh element
      // and a fresh chance to corrupt. The mutation has already happened and
      // there is deliberately no rollback -- undoing a foreign edit blind is how
      // the user's own work gets destroyed (see doSentenceUndo).
      //
      // TWO DIFFERENT FAILURES WORE ONE NAME. Every full-text mismatch used to
      // be `misplaced`, and `misplaced` demotes the whole family -- so an editor
      // that honoured our span exactly and then normalised something ELSE in the
      // document (a custom Slate normalizer rewriting whitespace or block
      // wrappers) was withdrawn for the session on the strength of doing nothing
      // wrong. The span itself is the discriminator, and it is cheap to ask:
      //
      // Both callers report these mutations through spliceFailurePolicy:
      //   span honoured, surroundings moved  -> `normalized`, block this element
      //                                         only. We cannot verify the write
      //                                         here, but nothing says the
      //                                         transport lied.
      //   span not honoured                  -> `misplaced`, and the family goes:
      //                                         the editor said yes and wrote
      //                                         somewhere else.
      //
      // Stock Slate's node merging preserves snText and trips neither.
      const expected = beforeText.slice(0, start) + replacement + beforeText.slice(end);
      if (observed !== expected) {
        const spanHonoured = observed.slice(start, start + replacement.length) === replacement;
        // No caret restore: `caretBefore` is an offset into a document this
        // write has just invalidated, and re-imposing it would put the caret
        // mid-word in text nobody understands any more. But the swallowed
        // characters are still the user's, so they go back -- and the one thing
        // that must hold first is that the selection is COLLAPSED, because a
        // replay into an expanded one replaces whatever it covers. Not once the
        // user has taken the caret back, though: collapsing THEIR drag-selection
        // is the same clobber as restoring over their click.
        if (!yielded) {
          try {
            const live = window.getSelection();
            if (live && !live.isCollapsed) live.collapseToEnd();
          } catch {}
        }
        await replaySwallowed();
        return spliceFailed(spanHonoured ? "normalized" : "misplaced", windowRecord());
      }

      // The one observation that decides the rest of the window, and it asks for
      // the dirty branch's SIGNATURE rather than merely for a surprise. Slate
      // restores the user's caret from a rangeRef it only takes on the clean
      // path; when it does not, the caret is left at the end of the correction,
      // and that exact value is the evidence.
      //
      // "Anything other than the user's caret" was the first version and it was
      // too broad by far: a single sample taken mid-render can catch the field
      // between states, and it then threw away characters the user had typed --
      // measured as 1 burst trial in 12 losing two of them
      // ("...early. Weecieved..."). A transient unknown is not evidence of the
      // failure, and treating it as evidence cost the common case to protect the
      // rare one.
      if (!yielded && caretBefore.start != null) {
        const c = snCaret(el);
        const correctionEnd = start + replacement.length;
        const usersCaret = caretBefore.start + (replacement.length - before.length);
        if (c.start === correctionEnd && c.start !== usersCaret) caretUntrusted = true;
      }

      // The caret goes back by arithmetic, CHECKED against the text that
      // followed it -- the same rule the textarea path uses, and for the same
      // reason: an editor that re-blocks the field changes snText() in ways the
      // delta knows nothing about, and a caret one character inside a word is
      // worse than a caret visibly at the end of the correction.
      //
      // Skipped entirely once we have yielded. The user has clicked, or deleted,
      // or started composing; `caretBefore` is a snapshot of where they WERE and
      // re-imposing it drags them back out of wherever they just went. Slate
      // restores its own transformed rangeRef in that case, which is the better
      // answer anyway -- the caret-free arm measured 12/12.
      const delta = replacement.length - before.length;
      if (!yielded && caretBefore.start != null && caretBefore.start >= end) {
        const target = caretBefore.start + delta;
        if (snText(el).slice(target) === beforeText.slice(caretBefore.start)) {
          const already = snCaret(el);
          const moving = !already || already.start !== target || already.end !== target;
          const back = snCollapsedRange(el, target);
          if (back) {
            try {
              if (moving) caretRepairPending = true;
              sel.removeAllRanges();
              sel.addRange(back);
            } catch {}
          }
        }
        await new Promise((r) => setTimeout(r, SN_CE_SYNC_MS));
        // Slate has had its sync; the caret is now its own answer again.
        caretRepairPending = false;
      }
      el.scrollTop = scrollTop;
      el.scrollLeft = scrollLeft;
      // The success path swallows too, and for most of this function's life it
      // never gave anything back. `bail` stays attached through the caret
      // restore above and its sync wait -- correctly, because a keystroke
      // landing mid-restore goes in at the wrong offset -- so a keystroke there
      // was eaten and, back when only the abort path replayed, silently
      // dropped. This is now the ONLY window the function has, and it is the
      // one the swallow is kept for.
      // Measured against real Slate as a correction that lands and takes the
      // next character with it:
      //
      //     "The technician arrived early.We recieved the invoice yesterday."
      //                                  ^ the space the user typed
      await replaySwallowed();
      return spliceLanded(windowRecord());
    } finally {
      detach();          // idempotent -- replaySwallowed may have run it already
    }
  }

  // Undo keeps exactly ONE record, and it is the chip's Undo -- not Ctrl+Z.
  // Measured: after the user types on, Ctrl+Z once undoes THEIR typing and
  // twice undoes Proofer's splice, so a single native Ctrl+Z cannot be
  // promised. Intercepting Ctrl+Z instead would steal the host editor's
  // history, which is worse than not owning the shortcut.
  async function doSentenceUndo() {
    const u = sentenceUndo;
    if (!u || !u.el.isConnected) return false;
    const live = snText(u.el);
    // The text moved under the chip. Refuse rather than restore `before` over
    // whatever is there now -- that would be the wrong-span splice this whole
    // path exists to make impossible.
    if (live.slice(u.start, u.endAfter) !== u.after) { sentenceSkip("undo:anchor-lost"); return false; }
    // The SAME cap check the apply does, and for the same measured reason:
    // execCommand does not fail on maxlength, it returns true and silently
    // truncates. Undo restores the ORIGINAL, which on a correction that
    // shortened the sentence is longer than what is there now -- so an undo can
    // exceed a cap the correction fitted inside, and the anchor check above
    // cannot see it because it only looks at the corrected span.
    const restored = live.slice(0, u.start) + u.before + live.slice(u.endAfter);
    if (restored.length > snMaxLength(u.el)) { sentenceSkip("undo:maxlength"); return false; }
    u.el.focus();
    // End the apply verifier BEFORE the splice, now that its preconditions have
    // passed. Its 150/600ms samples would otherwise observe the undo -- which
    // is a deliberate removal of the correction -- while `sentenceUndo` still
    // carries this request id, and accuse the page of reconciling a write the
    // user asked us to take back.
    if (typeof u.stopVerify === "function") u.stopVerify();
    // Undo is a write like any other, so it goes through the same recipe
    // selection. Undoing a Slate correction with the execCommand splice would
    // put the typo back on screen and leave Slate's model holding the
    // correction -- the same divergence, in the other direction -- and
    // undoing a ProseMirror correction with the Slate recipe would write
    // nothing at all.
    const wrote = await spliceSentenceVia(u.el, u.start, u.endAfter, u.before);
    if (!wrote.ok) {
      if (wrote.outcome === "failed-transport") {
        const cause = reportSentenceSpliceFailure(u.requestId, wrote, true);
        blockSentenceField(u.el, cause);
      } else {
        // No dispatch: keep the correction's existing verdict and undo slot.
        sentenceSkip("undo:" + wrote.outcome + ":" + wrote.reason);
      }
      return false;
    }
    // Verified like any other write. Undo is the one the user asked for
    // explicitly, so recording it as done when it did not land is worse here
    // than anywhere else -- but "did not land" and "cannot be attributed" are
    // different answers, and this asked only the first. A key typed inside the
    // Slate write window is yielded or replayed by the splice, which moves the
    // tail; the strict compare then failed and blocked a field whose undo had
    // worked perfectly. Same defect as the apply path's, fixed there two rounds
    // earlier and left here.
    const undoDisposition = sentenceWriteDisposition(
      u.el, restored, u.start, u.start + u.before.length, u.before, wrote.window);
    if (undoDisposition === "reconciled") {
      sentenceSkip("undo:reconciled");
      // Escape rejected the correction, but the page discarded the UNDO.
      reportOutcome(u.requestId, "sentence-undo-reconciled");
      blockSentenceField(u.el, "reconciled");
      return false;
    }
    if (undoDisposition === "unverified") {
      sentenceSkip("undo:unverified");
      // The rejection is known; restoration is not. Consume the undo slot
      // without announcing a confirmed undo.
      reportOutcome(u.requestId, "sentence-undo-unverified");
    } else {
      reportOutcome(u.requestId, "sentence-undone");
    }
    sentenceUndo = null;
    stopSentenceEditWatch();
    stopSentenceDurabilityWatch();
    clearSentenceFlash();
    rederiveWatermark("undo");
    // Our own write, adopted by DERIVATION from the observed baseline and only
    // when the field really holds the result.
    //
    // `restored` above is built from LIVE text, which is right for verifying
    // the transport and wrong as a provenance baseline: an eventless page
    // mutation outside the undo span is folded into it, passes
    // sentenceWriteLanded (which only checks the restored span), and would be
    // adopted. Keeping the two expectations separate is the point -- the user's
    // Escape is not refused because a page touched something else, and the
    // page's text is still not adopted.
    const ust = sentenceTrack && sentenceTrack.el === u.el ? sentenceTrack : null;
    if (ust && u.endAfter <= ust.observedText.length) {
      const want = ust.observedText.slice(0, u.start) + u.before + ust.observedText.slice(u.endAfter);
      if (snText(u.el) === want) setSentenceObserved(ust, want);
    }
    // Only a VERIFIED undo says the undo happened. The unverified branch means
    // the field could not be attributed after the write -- the record carries
    // that as the correction's disposition -- and announcing success there
    // would be the one thing the branch's own comment says it must not do.
    if (undoDisposition === "verified") announceToScreenReader("Proofer correction undone");
    return undoDisposition === "verified";
  }

  // --- Post-apply watcher --------------------------------------------------
  //
  // watchPostApplyEdits cannot be reused: it is full-text only, it is a single
  // global watcher, and it reports the ENTIRE field as the correction. What is
  // wanted here is span-local -- the user's own version of one sentence.
  //
  // A silent apply is the only write in this extension nobody ratifies, so the
  // user editing it back is the strongest "this was wrong" signal the log can
  // ever get. Without this observation, a bad apply may remain invisible unless
  // the user reports it separately. Two verdicts, because they are not the same
  // evidence: `user-reverted` means the span is EXACTLY what they typed before
  // we touched it, which is an unambiguous rejection of the correction, while
  // `user-edited-correction` means they changed it to some third thing, which
  // may be a rejection or may be them carrying on writing inside that sentence.
  //
  // The watch survives the first edit and keeps looking until the deadline. A
  // revert is usually reached in two steps -- delete the word we inserted, type
  // the original back -- and stopping at the first settle recorded the halfway
  // state and never saw the rejection. `user-reverted` is the strongest reading
  // and is final; anything else can still be upgraded to it.

  function stopSentenceEditWatch() {
    if (!sentenceEditWatcher) return;
    clearTimeout(sentenceEditWatcher.settle);
    clearTimeout(sentenceEditWatcher.expiry);
    sentenceEditWatcher = null;
  }

  function noteSentenceEditWatch(st, text, seq) {
    const w = sentenceEditWatcher;
    if (!w || st !== sentenceTrack || st !== w.st || st.el !== w.el) return;
    clearTimeout(w.settle);
    w.text = text;
    w.seq = seq;
    if (text === null) return;
    w.settle = setTimeout(w.report, 2000);
  }

  function watchSentenceEdit(requestId, el, start, endAfter, applied, original) {
    stopSentenceEditWatch();
    const st = sentenceTrack;
    if (!st || st.el !== el) return;
    const prefix = snText(el).slice(0, start);
    const was = String(original || "").trim();
    // `reported` is the last text already sent, so a settle that resolves to
    // the same thing twice (the user pausing twice inside one edit) does not
    // write the same verdict again.
    const w = { st, el, settle: null, expiry: null, reported: null, text: null, seq: null };
    sentenceEditWatcher = w;

    w.report = () => {
      if (sentenceEditWatcher !== w || sentenceTrack !== st || st.userEditSeq !== w.seq) return;
      // Removing an element changes focus WITHOUT firing blur, so nothing
      // else tears this down; the expiry timer would keep a detached field
      // alive for its full 30s.
      if (!el.isConnected) { stopSentenceEditWatch(); return; }
      const live = snText(el);
      // A later eventless page mutation is not the user's settled edit.
      if (live !== w.text) return;
      // Only attributable while everything BEFORE the span is untouched --
      // otherwise the offsets mean nothing and the "correction" would be a
      // slice of unrelated text. Re-deriving the span from live text is not
      // worth it: the same prefix-stability insight the anchor and the flash
      // overlay are built on says an edit behind us invalidates the offsets,
      // and a mis-attributed revert is worse evidence than none.
      if (live.slice(0, start) !== prefix) { stopSentenceEditWatch(); return; }
      // Carrying on writing is the NORMAL case here -- the user is mid-word
      // in the next sentence when the correction lands. An earlier version
      // added the field's total length drift to the span end, so every
      // keystroke after the target pulled the next sentence into the "edit"
      // and reported it as a reverted correction. That made the keep rate,
      // which is the number deciding whether this ships at all, meaningless.
      // The span is untouched or it is not; nothing else counts.
      if (live.slice(start, endAfter) === applied) return;   // keep watching
      // The span's own length has moved, so it is re-read as whatever the
      // segmenter now calls the sentence starting at `start` -- which is also
      // what makes trailing whitespace immaterial to the comparison below.
      const seg = segmentSentences(live.slice(start), { mergeTrailingRunt: false })[0];
      const settled = (seg ? seg.text : live.slice(start, endAfter)).trim();
      if (!settled || settled.length > SENTENCE_MAX_CHARS) return;
      if (settled === applied.trim()) return;                // keep watching
      if (settled === was) {
        // Exactly what they typed. Nothing stronger will arrive, so this one
        // is final and the watch ends here.
        reportOutcome(requestId, "user-reverted", settled);
        stopSentenceEditWatch();
        return;
      }
      if (settled !== w.reported) {
        w.reported = settled;
        reportOutcome(requestId, "user-edited-correction", settled);
      }
      // Deliberately still watching: a revert reached in two steps passes
      // through here first, and `user-reverted` supersedes this.
    };

    // A correction is edited back immediately or not at all. Past this the
    // field is being written, not reviewed, and attributing it here would put
    // a later sentence on this record.
    w.expiry = setTimeout(stopSentenceEditWatch, 30000);
  }

  // --- The durability veto -------------------------------------------------
  //
  // The backstop under the transport registry, and it can ONLY DEMOTE. An
  // uncertified editor is never authorized by observed success -- that trades
  // "zero silent bad writes" for "one per editor, probably once", and the
  // "once" is not defensible when fingerprints collide and apps redeploy.
  //
  // What it catches is the failure the registry exists for and the other checks
  // structurally cannot see. sentenceWriteLanded samples at 0, 150 and 600ms;
  // an editor that re-renders from a model that never saw our write reverts it
  // on THE NEXT KEYSTROKE, which is usually seconds later. Provoking a
  // reconcile instead was measured and does not work: after a MUTATION write on
  // Slate, nudging the DOM selection and polling at nine points out to 1500ms
  // read correct every time. Only a real user keystroke exposes it.
  //
  // So the rule must have NO FALSE POSITIVES, and accepts false negatives
  // freely. The claim is not "the editor reverted it", which is unprovable from
  // here, but "the write was not durable":
  //
  //   * before the event, live text still equals the corrected text
  //   * no composition has occurred since the write
  //   * the beforeinput supplies exactly ONE target range, collapsed, strictly
  //     OUTSIDE the corrected interval
  //   * after the event, live text equals pre-correction text plus exactly that
  //     user edit, byte for byte
  //
  // Together those prove the user's edit was accepted while the correction was
  // lost. Backspacing over the correction and select-and-retype fail the
  // non-overlap test; IME fails the composition test; anything less exact is
  // inconclusive rather than a veto.
  //
  // Contenteditable only. A textarea has no model to disagree with its own
  // value, and `getTargetRanges()` is empty there anyway.
  const SN_DURABILITY_MS = 30000;
  // How long the field is given to SETTLE after the user's keystroke before the
  // veto reads it. Not a sampling interval: the read happens once, at the end.
  // Long enough for the editor's own handlers plus a controlled render behind a
  // microtask, short enough to be over before the next keystroke at any human
  // rate.
  const SN_DURABILITY_SETTLE_MS = 60;
  let sentenceDurabilityWatch = null;

  function stopSentenceDurabilityWatch() {
    if (!sentenceDurabilityWatch) return;
    sentenceDurabilityWatch.ac.abort();
    clearTimeout(sentenceDurabilityWatch.expiry);
    sentenceDurabilityWatch = null;
  }

  /** A StaticRange's endpoints as text offsets, or null if it is not inside el. */
  function staticRangeOffsets(el, r) {
    if (!r || !el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
    const { spans } = buildSegmentsForElement(el);
    const start = domOffsetToTextOffset(r.startContainer, r.startOffset, spans);
    const end = domOffsetToTextOffset(r.endContainer, r.endOffset, spans);
    if (start == null || end == null) return null;
    return { start, end };
  }

  function watchSentenceDurability(requestId, el, start, endAfter, replacement, before) {
    stopSentenceDurabilityWatch();
    if (!snIsCE(el)) return;
    const ac = new AbortController();
    const w = { ac, expiry: null, composed: false, settled: false };
    sentenceDurabilityWatch = w;

    const veto = () => {
      if (w.settled) return;
      w.settled = true;
      const family = sentenceFieldStatus(el).family;
      sentenceSkip("not-durable:" + (family || "unknown"));
      // The record still says sentence-applied for a correction that is no
      // longer in the field. Every one of those inflates the keep rate.
      reportOutcome(requestId, "sentence-not-durable");
      sentenceUndo = null;
      stopSentenceEditWatch();
      clearSentenceFlash();
      // NO AUTOMATIC ROLLBACK. A blind execCommand("undo") here may undo the
      // USER'S own work: the editor may have grouped our write with their
      // typing, or never created a history entry for it at all. Surface the
      // failure and stop.
      blockSentenceField(el, "not-durable");
      stopSentenceDurabilityWatch();
    };

    el.addEventListener("compositionstart", () => { w.composed = true; }, { signal: ac.signal });

    el.addEventListener("beforeinput", (e) => {
      if (sentenceDurabilityWatch !== w || w.settled) return;
      // Our own writes are not evidence about anything.
      if (!e.isTrusted || applyingRewrite) return;
      if (w.composed || e.isComposing) { stopSentenceDurabilityWatch(); return; }
      // Only an ordinary insertion is decidable. A deletion overlapping the
      // correction is exactly the ambiguous case the non-overlap test exists to
      // exclude, and there is nothing to gain by guessing at the others.
      if (e.inputType !== "insertText" || typeof e.data !== "string" || !e.data) return;
      const pre = snText(el);
      if (pre.slice(start, endAfter) !== replacement) {
        // The correction is already gone, or the offsets have moved. Either way
        // this event cannot prove anything: stop rather than guess.
        stopSentenceDurabilityWatch();
        return;
      }
      const ranges = typeof e.getTargetRanges === "function" ? e.getTargetRanges() : [];
      if (ranges.length !== 1) return;
      const off = staticRangeOffsets(el, ranges[0]);
      if (!off || off.start !== off.end) return;
      const at = off.start;
      if (at > start && at < endAfter) return;          // inside: inconclusive
      const delta = replacement.length - before.length;
      const preCorrection = pre.slice(0, start) + before + pre.slice(endAfter);
      const atPre = at >= endAfter ? at - delta : at;
      const durable = pre.slice(0, at) + e.data + pre.slice(at);
      const reverted = preCorrection.slice(0, atPre) + e.data + preCorrection.slice(atPre);
      // A correction that changes nothing has no distinguishable revert.
      if (durable === reverted) return;
      // ONE sample, and it is the LAST one. Deciding on the first match makes
      // both errors possible and neither is acceptable here: a transient
      // stale-render snapshot at 0ms reads as `reverted` and demotes a healthy
      // family for the rest of the session, and a correct-looking snapshot at
      // 0ms stops the watch before a controlled render commits the revert at
      // 20-60ms -- which is the slow-render case the second sample was added
      // for, made inert by the first. Waiting for the window to settle costs
      // one interval and removes the false positive outright.
      setTimeout(() => {
        if (sentenceDurabilityWatch !== w || w.settled || !el.isConnected) return;
        const live = snText(el);
        if (live === reverted) { veto(); return; }
        // Proven durable through a real keystroke: nothing more to watch for.
        // Anything else is inconclusive, and inconclusive means keep watching
        // rather than guess.
        if (live === durable) stopSentenceDurabilityWatch();
      }, SN_DURABILITY_SETTLE_MS);
    }, { signal: ac.signal, capture: true });

    // Same budget as the edit watch. Past this the field is being written
    // rather than reviewed, and a much later revert is not attributable.
    w.expiry = setTimeout(stopSentenceDurabilityWatch, SN_DURABILITY_MS);
  }

  // --- The green flash -----------------------------------------------------
  //
  // A faint green flash over the words that changed, at the moment they change.
  // The guards cannot catch a one-word insertion that changes meaning while
  // passing every structural check. The flash makes the edit visible and Undo
  // lets the user reject it.
  //
  // TWO MECHANISMS, ONE CONTRACT. A textarea has no text nodes, so its flash is
  // measured once and painted as fixed-position divs. A contenteditable's text
  // IS in the document, so its flash is a CSS Custom Highlight over LIVE Ranges
  // and the browser repaints them wherever the text went.
  //
  // WHAT THAT CHANGES, AND WHAT IT DELIBERATELY DOES NOT. The overlay's teardown
  // rule mixes two different questions, and only one of them stops applying:
  //
  //   GEOMETRY -- "could these rects be in the wrong place now?" The field
  //   moved, the page scrolled, the field resized, the line is centred so
  //   appending slid it. All of that is dropped for a highlight, because a
  //   live Range has no stored position to be wrong: the browser paints it
  //   from the text. This is the part that is an upgrade.
  //
  //   TEXT -- "is the text Escape needs still exactly there?" That one is KEPT,
  //   and the reason is the undo, not the paint. `sentenceUndo` is a fixed
  //   `{start, endAfter}` pair and `sentenceUndoAnchored` checks it by offset,
  //   so an edit before the correction breaks Escape whether the flash noticed
  //   or not. A green flash whose Escape silently does nothing is worse than no
  //   flash: it is the one affordance this path has, advertised and dead. THE
  //   FLASH AND THE UNDO MUST AGREE, so the flash dies exactly where the undo
  //   stops anchoring -- which takes three checks, not one, because "the same
  //   bytes are there" is weaker than "the same text is there":
  //     * the prefix runs through the ANCHOR's end, not the last changed word,
  //       or editing a later word in the corrected sentence leaves green over
  //       a dead Escape;
  //     * each Range must still be at the OFFSET it was armed at, or an
  //       aliased insertion (a byte-identical copy of the sentence pasted in
  //       front) satisfies every string comparison while the Range sits on the
  //       second copy and Escape splices the first;
  //     * the registered NAME must still hold our Ranges, or a page that
  //       registers `proofer-sn-flash-2` paints somebody else's text green.
  //   Making the undo re-anchor through the live Range is the other way round
  //   and is NOT taken here: it moves the undo path, the async verifier and the
  //   chip's Undo together, and the measurement below covers the paint alone.
  //
  // The hazard the mechanism buys is the opposite one, and it is why this was
  // measured rather than assumed: a live Range is only alive while its boundary
  // nodes are, so an editor that REPLACES the text node on re-render collapses
  // it, and a flash that dies at 200ms because React re-rendered is "never
  // shown" -- the same failure teardown-on-input already produced once.
  // `flash-highlight-probe.mjs` splices a real correction in through the
  // shipping recipe on each certified editor, registers the Range, and types
  // jittered keystrokes (22-129 ms) into the next sentence for the full
  // 1600 ms. One randomized run per family, 19-23 CORRELATED samples within it
  // -- time samples of one trial, not independent trials:
  //
  //   [A] survives the whole 1600 ms on 6/6 -- Slate, ProseMirror, Quill,
  //       Lexical, Draft, Trix -- registered, contained, naming the same word
  //       at every sample, and visibly tinted at three points (birth, mid-burst
  //       and end). Tint is proved by DIFFERENCE: the Range's own rect
  //       screenshotted with the registration present and removed, counting
  //       pixels that got greener, because Trix's page is itself green and a
  //       colour detector scored 1765 px of it. Tint box lands 0-1 px from the
  //       Range's rect on every family.
  //   [B] an edit BEFORE it: the Range itself tracks the text on ProseMirror
  //       (+32.6px), Quill (+75.8px), Lexical (+36.5px) and Trix (+42px), and
  //       COLLAPSES on Slate and Draft, which paints nothing -- and never, on
  //       any family, paints over the wrong words. Recorded because it is what
  //       a re-anchored undo would be able to spend; the flash is torn down on
  //       it regardless, per the contract above.
  //
  // The geometry half is not a free swap either -- it FIXES a case the overlay
  // guard cannot see. `stableUnderAppend` reads `textAlign` off the FIELD, but
  // in a contenteditable the alignment lives on the block: on slatejs.org's own
  // richtext demo the surviving paragraph is `text-align: center`, the editor
  // computes `start`, and typing 14 characters after the flash slid the flashed
  // word 48px left (~3.4px per keystroke, monotonic) with the guard reporting
  // "alive" at all 24 samples. A highlight cannot have it. The overlay still
  // can, on the fallback path, so `sentenceAlignmentStableEl` now reads the
  // alignment off the BLOCK the flash actually ends in.
  //
  // A round trip, not a property check: `CSS.highlights` and `Highlight` can
  // both exist behind a shim that registers nothing.
  const SN_HL_SUPPORTED = (() => {
    try {
      if (typeof CSS === "undefined" || !CSS || !CSS.highlights) return false;
      if (typeof Highlight !== "function") return false;
      CSS.highlights.set("proofer-sn-probe", new Highlight());
      try {
        const ok = CSS.highlights.has("proofer-sn-probe");
        CSS.highlights.delete("proofer-sn-probe");
        return ok && !CSS.highlights.has("proofer-sn-probe");
      } finally {
        // The probe name is not in SN_HL_NAMES, so nothing else ever deletes
        // it: a throw from `has` or `delete` after a successful `set` would
        // leave a registration behind for the life of the page, on a shim
        // broken enough that we are about to refuse to use it at all.
        try { CSS.highlights.delete("proofer-sn-probe"); } catch {}
      }
    } catch { return false; }
  })();
  // Registered NAMES, not classes: a highlight is not an element and cannot
  // carry one, so one name is one appearance and the fade is three names rather
  // than three alpha values on one. Their colours live in styles.css with
  // everything else and deliberately not in an injected <style>: `::highlight()`
  // takes no transition and no animation in Chrome, so a fade has to be stepped
  // from JS either way, and a page CSP of `style-src 'self'` would block an
  // injected stylesheet on exactly the sites most worth working on.
  // Hold to 60% then two steps down -- the same curve the textarea keyframes
  // run, so the two paths look like one feature.
  const SN_HL_STEPS = [
    { at: 0, name: "proofer-sn-flash-3" },
    { at: Math.round(SENTENCE_FLASH_MS * 0.60), name: "proofer-sn-flash-2" },
    { at: Math.round(SENTENCE_FLASH_MS * 0.80), name: "proofer-sn-flash-1" },
  ];
  const SN_HL_NAMES = SN_HL_STEPS.map((s) => s.name);

  function snReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
    catch { return false; }
  }

  function clearSentenceHighlights() {
    if (!SN_HL_SUPPORTED) return;
    for (const n of SN_HL_NAMES) CSS.highlights.delete(n);
  }

  function changedRanges(before, after, base, want) {
    const diff = computeWordDiff(before, after);
    const out = [];
    let pos = 0;
    for (const seg of diff) {
      const other = want === "ins" ? "del" : "ins";
      if (seg.type === other) continue;         // not present in the side we measure
      const len = seg.text.length;
      if (seg.type === want && seg.text.trim()) out.push({ start: base + pos, end: base + pos + len });
      pos += len;
    }
    // Merge runs separated by a single space so "a b" reads as one highlight
    const merged = [];
    for (const r of out) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    return merged;
  }

  /**
   * The word that CLOSES UP over a gap, in the same offset space `changedRanges`
   * measures -- and it takes the same four arguments for the same reason.
   *
   * `changedRanges` returns the segments present in the side it measures, and a
   * correction that only DELETES has none of them on the insert side -- so a
   * doubled word being removed (`the the invoice` -> `the invoice`, which every
   * guard passes and which is one of the commonest corrections there is) landed
   * silently with NO flash at all. `flashSentenceRanges` returned on the empty
   * array before it did anything. A change nobody can see is the same defect as
   * a refusal nobody can see, and worse here, because the flash is also the only
   * thing telling the user that Escape has something to take back. The mirror
   * holds on the suggestion side: marking what a correction REMOVES leaves a
   * pure insertion unmarked.
   *
   * There is no span to paint -- what changed is a gap -- so paint the word that
   * moved into it, or in front of which one is about to open. For
   * `the the invoice` -> `the invoice` the join lands on `invoice`; at the end
   * of the text nothing follows the gap, so the word BEFORE it is the one that
   * appears to have changed.
   *
   * ONE FORWARD DIFF, ALWAYS, and `want` selects the side -- exactly as
   * `changedRanges` does. Reversing the arguments to get the mirror was the
   * first cut and it is WRONG: `computeWordDiff` is greedy and not symmetric,
   * so `D(after, before)` is not `D(before, after)` with the labels swapped.
   * Measured on the shape that separates them --
   * `nothing but work remains.` -> `but nothing but work remains.` -- the
   * reversed diff put the join at offset 12 and marked `work`, while Apply
   * inserts at offset 0. A mark pointing at the wrong word is the state the
   * mark exists to prevent.
   *
   * A FALLBACK only. Any correction with something to paint paints that: the
   * inserted (or removed) text is the evidence, and a join is only evidence of
   * where.
   */
  function joinRanges(before, after, base, want) {
    const diff = computeWordDiff(before, after);
    // The side we are NOT measuring is where the gap is: measuring the `after`
    // (`ins`) makes a `del` run the gap, and vice versa.
    const gap = want === "ins" ? "del" : "ins";
    const text = want === "ins" ? after : before;
    const joins = [];
    let pos = 0, prevGap = false;
    for (const seg of diff) {
      if (seg.type === gap) {
        // One join per RUN. A deleted word and the space beside it are two
        // segments and one gap, and marking each would double-count it.
        if (!prevGap) joins.push(pos);
        prevGap = true;
        continue;
      }
      prevGap = false;
      pos += seg.text.length;
    }
    const out = [];
    for (const at of joins) {
      const span = wordSpanAt(text, at);
      if (span) out.push({ start: base + span.start, end: base + span.end });
    }
    // Merged exactly as changedRanges merges, and for a reason of its own:
    // deletions either side of one surviving word both name that word, and two
    // Ranges over the same characters paint the tint twice.
    const merged = [];
    for (const r of out.sort((a, b) => a.start - b.start)) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    return merged;
  }

  /** The whitespace-delimited word at or after `at`; at the end, the one before. */
  function wordSpanAt(text, at) {
    const ws = (c) => /\s/.test(c);
    let i = Math.max(0, Math.min(at, text.length));
    while (i < text.length && ws(text[i])) i++;
    if (i >= text.length) {
      // The gap took the tail, so nothing closed up over it from the right.
      let e = text.length;
      while (e > 0 && ws(text[e - 1])) e--;
      let st = e;
      while (st > 0 && !ws(text[st - 1])) st--;
      return e > st ? { start: st, end: e } : null;
    }
    let st = i;
    while (st > 0 && !ws(text[st - 1])) st--;
    let e = i;
    while (e < text.length && !ws(text[e])) e++;
    return e > st ? { start: st, end: e } : null;
  }

  // Every property that can move a glyph. Miss one and the highlight lands on
  // the wrong word, which is worse than no highlight at all.
  const MIRROR_PROPS = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch",
    "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent",
    "textAlign", "textRendering", "whiteSpace", "overflowWrap", "wordBreak", "tabSize",
    "direction", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  ];

  // A textarea cannot style a range, so measure one: clone its text into a
  // hidden div with identical layout, wrap the changed spans, and read their
  // rects back.
  // A contenteditable needs no mirror at all: its text IS in the document, so a
  // Range over the changed span reports its own rects. That sidesteps the whole
  // mirror bug family -- copied properties, scrollbar widths, padding-box
  // alignment -- none of which can be got wrong here because nothing is being
  // reconstructed.
  function measureSentenceRangesCE(el, ranges) {
    const rects = [];
    for (const r of ranges) {
      const range = rangeForInnerTextOffset(el, r.start, r.end - r.start);
      if (!range) continue;
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      }
    }
    return rects;
  }

  function measureSentenceRanges(el, ranges) {
    if (snIsCE(el)) return measureSentenceRangesCE(el, ranges);
    // The mirror is appended to documentElement, so it sits OUTSIDE any CSS
    // transform or zoom applied to an ancestor of the field. Under one, the
    // field's rect is scaled and the mirror's is not, and every highlight lands
    // on the wrong word -- which is worse than no highlight at all. offsetWidth
    // is the untransformed border-box width, so a mismatch detects it.
    const r = el.getBoundingClientRect();
    if (el.offsetWidth && Math.abs(r.width - el.offsetWidth) > 1) return [];
    // Height too, not just width: scaleY(2) leaves the width equal to
    // offsetWidth while every vertical coordinate is transformed, and client
    // rects include transforms on the element and its ancestors.
    if (el.offsetHeight && Math.abs(r.height - el.offsetHeight) > 1) return [];
    const cs = getComputedStyle(el);
    const mirror = document.createElement("div");
    for (const p of MIRROR_PROPS) mirror.style[p] = cs[p];
    mirror.style.position = "absolute";
    mirror.style.top = "0";
    mirror.style.left = "-99999px";
    mirror.style.visibility = "hidden";
    // whiteSpace and overflowWrap are COPIED above, not forced here. Forcing
    // pre-wrap made the mirror wrap where a `wrap="off"` textarea (computed
    // white-space: pre) does not, and every highlight after the first long line
    // landed on the wrong row.
    if (!mirror.style.whiteSpace) mirror.style.whiteSpace = "pre-wrap";
    mirror.style.boxSizing = "content-box";
    mirror.style.borderStyle = "solid";
    mirror.style.borderColor = "transparent";
    // clientWidth, NOT getBoundingClientRect().width: the rect includes the
    // scrollbar (measured 420 vs 418), and those 2px move every wrap point.
    const padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
    mirror.style.width = Math.max(0, el.clientWidth - padL - padR) + "px";

    const text = snText(el);
    const spans = [];
    let pos = 0;
    for (const r of ranges) {
      if (r.start < pos || r.end > text.length) continue;
      mirror.appendChild(document.createTextNode(text.slice(pos, r.start)));
      const span = document.createElement("span");
      span.textContent = text.slice(r.start, r.end);
      mirror.appendChild(span);
      spans.push(span);
      pos = r.end;
    }
    if (!spans.length) return [];
    // A zero-width space keeps the final line box alive when the text ends here
    mirror.appendChild(document.createTextNode(text.slice(pos) + "​"));

    document.documentElement.appendChild(mirror);
    let rects = [];
    try {
      const mRect = mirror.getBoundingClientRect();
      const eRect = el.getBoundingClientRect();
      // Align PADDING-box origins, not border-box origins. clientLeft is the
      // left border width PLUS any scrollbar rendered on that side -- and in an
      // RTL textarea Chrome puts the vertical scrollbar on the LEFT. Measuring
      // from the border box put every highlight a full scrollbar width off:
      // 15px, 1.6 characters, covering "e techncia" instead of "techncian".
      // Only reachable with classic scrollbars, which is why headless never saw
      // it -- headless always uses zero-width overlay scrollbars.
      const dx = (eRect.left + el.clientLeft) - (mRect.left + mirror.clientLeft) - el.scrollLeft;
      const dy = (eRect.top + el.clientTop) - (mRect.top + mirror.clientTop) - el.scrollTop;
      for (const span of spans) {
        for (const r of span.getClientRects()) {
          rects.push({ left: r.left + dx, top: r.top + dy, width: r.width, height: r.height });
        }
      }
    } finally {
      mirror.remove();
    }
    return rects;
  }

  function clearSentenceFlash() {
    sentenceFlashGuard = null;
    if (!sentenceFlashTeardown) return;
    const t = sentenceFlashTeardown;
    sentenceFlashTeardown = null;
    t();
  }

  /**
   * The CHEAP half, run every frame: are these Ranges still where they think?
   *
   * WHAT A REPLACED NODE ACTUALLY DOES TO A RANGE, measured rather than
   * reasoned about -- this comment used to assert the opposite, and the first
   * cut of the repair below was built against the wrong mechanism because of
   * it. It said a replaced node is "DETACHED ... so a Range over it keeps
   * stringifying to the right characters while pointing at nothing on screen".
   * It does not. The DOM spec's remove steps RELOCATE every live boundary point
   * whose container is an inclusive descendant of the removed node onto the
   * PARENT, at the removed child's index -- so swapping a text node for a
   * byte-identical one leaves the Range `{container: DIV, offset: 0, collapsed:
   * true}`, stringifying to `""`, and still INSIDE the field. Containment
   * passes and the spelling check is what fires. (The [B] column of
   * flash-highlight-probe has been reporting `collapsed ("")` for this the
   * whole time, one scenario away.)
   *
   * Registration too. The guard used to validate its own private Range objects
   * and never ask whether the registered NAME still holds them -- and a page
   * may register anything it likes under `proofer-sn-flash-2`, at which point
   * the extension's own green rule paints somebody else's Range. Names are the
   * only handle `::highlight()` has, so the collision has to be checked rather
   * than designed away.
   *
   * Returns the CAUSE, not a boolean, because the causes do not share one
   * correct response and this returned `false` for all of them:
   *   null       -- intact
   *   "stolen"   -- the registered NAME no longer holds our ranges. The one
   *                 cause that must NOT be repaired: the page owns that name
   *                 now, and re-registering under it fights them every frame.
   *   "detached" -- a boundary has left the field entirely.
   *   "adrift"   -- a range no longer names the words it flashed.
   *
   * `adrift` is deliberately not called "edited". A range reading the wrong
   * text is the SAME observation for "the user retyped that word" and "the
   * framework rebuilt the DOM under us", and nothing in the Range separates
   * them -- so the name stops at what was seen, and reanchorSentenceHighlight
   * decides, by asking the field instead of the Range.
   */
  function sentenceHighlightIntact(f) {
    if (SN_HL_SUPPORTED && f.name) {
      const h = CSS.highlights.get(f.name);
      // Set-like: `has` is identity over our own Range objects.
      if (!h || !f.live.every((r) => h.has(r))) return "stolen";
    }
    for (let i = 0; i < f.live.length; i++) {
      const r = f.live[i];
      if (!f.el.contains(r.startContainer) || !f.el.contains(r.endContainer)) return "detached";
      if (r.toString() !== f.texts[i]) return "adrift";
    }
    return null;
  }

  /**
   * A framework re-render is not an edit, and it was killing the flash.
   *
   * React replaces a text node outright whenever the host element does not have
   * exactly one text child (`node.textContent = text` rather than an in-place
   * `nodeValue` write), so a Slate or Lexical composer that re-renders from its
   * OWN app state -- a draft being persisted, a decorator resolving, anything
   * with nothing to do with us -- COLLAPSES every Range we registered while
   * the characters on screen do not move by one pixel. The watchdog read that
   * as gone and cleared, and the whole signal for a silent
   * correction was a green tint the user never saw. Measured through the
   * shipping pipeline: flash up, swap the text node for a byte-identical one,
   * gone within 120 ms -- with ESCAPE STILL WORKING, which is the proof the
   * teardown was answering the wrong question. `sentenceUndo` is a fixed
   * {start, endAfter} pair in text-offset space and a re-render moves neither.
   *
   * So rebuild each Range from the offset it was ARMED at and re-register.
   *
   * THE VERIFICATION IS THE WHOLE SAFETY ARGUMENT, and it is why this can be
   * offered to every failing cause but `stolen` without telling a re-render
   * from an edit first. It rebuilds at the ARMED OFFSET and requires the SAME
   * CHARACTERS to be there: a re-render leaves both intact and it succeeds,
   * while a user who retyped the word leaves different characters at that
   * offset and it fails, so the flash clears exactly as it used to. The repair
   * cannot move a mark onto text it was not armed over, it must land inside
   * the field, and the caller still runs sentenceHighlightAnchored afterwards
   * -- so the prefix and offset guarantees Escape depends on are untouched.
   *
   * Cost is bounded by the thing that provokes it: re-anchoring is one segment
   * build, which is what sentenceHighlightAnchored already spends on every
   * frame the MutationObserver marks dirty -- and a rebuilt node IS such a
   * mutation, so this can only run on a frame that was already paying it. No
   * attempt cap, deliberately: a constant there would be standing in for a
   * mechanism, and it would end the flash mid-way on an editor that re-renders
   * once per keystroke, which is the common case rather than the pathological
   * one.
   */
  function reanchorSentenceHighlight(f) {
    if (!f.starts || f.starts.length !== f.live.length) return false;
    let seg;
    try { seg = buildSegmentsForElement(f.el); } catch { return false; }
    // THE FIELD MUST NOT HAVE CHANGED AT ALL. Rebuilding at the armed offset
    // and requiring the same characters is BYTE equality standing in for
    // IDENTITY, and aliasing is this repo's documented counter-example to that:
    // a byte-identical copy of the corrected sentence inserted in FRONT leaves
    // the same characters at the armed offset and the same prefix, so the
    // repair would happily re-arm onto the copy -- and `sentenceUndo` is a
    // fixed offset pair, so Escape would then splice a sentence the user is not
    // looking at, under a green mark saying it is safe to. The live Range was
    // the only thing carrying that identity and a collapse is precisely the
    // browser throwing it away, so nothing in the DOM can recover it.
    //
    // An unchanged field restores it for free: if every character is where it
    // was, then every OFFSET means what it meant, and the undo record is
    // offset-space. So compare the whole thing, not the prefix -- an insertion
    // after `end` is exactly as fatal to offset identity as one before it is,
    // and the prefix cannot see it.
    //
    // What this costs is a re-render that lands in the SAME frame as a
    // keystroke: the flash clears, which is what it did before this repair
    // existed. Typing on the six certified families does not collapse a Range
    // (the probe's [A] column is 1600 ms of it), and the repair is re-offered
    // on every later frame, so the loss is a frame-aligned coincidence rather
    // than a class of correction.
    if (seg.text !== f.text) return false;
    const fresh = [];
    for (let i = 0; i < f.live.length; i++) {
      const want = f.texts[i];
      const range = rangeForInnerTextOffset(f.el, f.starts[i], want.length, seg);
      if (!range || range.toString() !== want) return false;
      if (!f.el.contains(range.startContainer) || !f.el.contains(range.endContainer)) return false;
      fresh.push(range);
    }
    // AND THE AFFORDANCE MUST STILL BE PERFORMABLE. Byte-identical is not the
    // same as unchanged: a re-render can rebuild the sentence with different
    // MARKUP -- one word bold, a decorator wrapping a run -- and every text
    // comparison above passes while `spliceSentenceCE` refuses the undo as
    // `non-uniform-range`. Escape's keydown has already been swallowed by then,
    // so the result is a green mark advertising a key that silently does
    // nothing, which is the one thing the flash must never be. The splice's own
    // question is the only honest one to ask, so ask it, over the span the
    // affordance will splice rather than over the words that changed.
    //
    // Repair-only, and the residual is named rather than implied: a markup
    // change ELSEWHERE in the sentence that leaves our Ranges intact never
    // reaches this function at all, and that hole predates the repair. Closing
    // it means a style comparison on every one of ~96 frames, which is a
    // different trade and wants its own measurement.
    if (Number.isFinite(f.anchorStart) && f.anchorStart < f.end) {
      const span = rangeForInnerTextOffset(f.el, f.anchorStart, f.end - f.anchorStart, seg);
      if (!span || !snRangeIsUniform(f.el, f.anchorStart, f.end, span)) return false;
    }
    // IN PLACE. `show()` closes over the SAME array object to re-register the
    // fade steps, so reassigning `f.live` would leave every later step
    // registering the detached ranges this just replaced -- the flash would
    // reappear broken at 960 ms.
    f.live.length = 0;
    for (const r of fresh) f.live.push(r);
    if (SN_HL_SUPPORTED && f.name) {
      clearSentenceHighlights();
      CSS.highlights.set(f.name, new Highlight(...f.live));
    }
    return true;
  }

  /**
   * Does this highlight still hold -- repairing it if a repair is all it needs?
   *
   * One copy, because the two callers differ only in whether they pay for the
   * expensive anchoring half, and a second copy of "which causes are
   * repairable" is exactly how the two would come apart.
   */
  function sentenceFlashHolds(f, checkAnchor) {
    const why = sentenceHighlightIntact(f);
    // Every cause but `stolen` is offered to the repair, which refuses on its
    // own evidence rather than on this classification -- see the block comment
    // there. Gating it on one cause was the first cut and it was wrong on the
    // measurement: a replaced node presents as `adrift`, not as `detached`, so
    // the repair never ran at all and the case stayed red.
    if (why && (why === "stolen" || !reanchorSentenceHighlight(f))) return false;
    return !checkAnchor || sentenceHighlightAnchored(f);
  }

  /**
   * The EXPENSIVE half: is the text Escape needs still byte-for-byte there, and
   * is each Range still at the offset it was armed at?
   *
   * TWO questions, one segment build, and both of them exist because of Escape
   * rather than because of the paint.
   *
   * The prefix runs through the anchor's END, not through the last changed
   * word. `sentenceUndoAnchored` checks `slice(start, endAfter) === after` over
   * the WHOLE rewritten sentence, so editing a later word in that sentence
   * kills Escape -- and a flash that only watched as far as the last change
   * stayed green over it. Green visible must imply Escape works.
   *
   * The offset check is what makes the guard identity rather than spelling.
   * Byte equality alone is fooled by ALIASING: paste a second copy of the
   * corrected sentence in front of the first and `slice(0, end)` is unchanged,
   * `slice(start, endAfter)` is unchanged, so both guards pass -- while the
   * live Range has moved onto the second copy and Escape would splice the
   * first. Same mechanism answers the identical-occurrence relocation the
   * earlier contract simply conceded: an editor that re-homed the boundaries
   * onto another copy of the same word lands at a different offset, and a
   * different offset is a different word however it is spelled.
   */
  function sentenceHighlightAnchored(f) {
    let seg;
    try { seg = buildSegmentsForElement(f.el); } catch { return false; }
    if (seg.text.slice(0, f.end) !== f.prefix) return false;
    for (let i = 0; i < f.live.length; i++) {
      const r = f.live[i];
      const at = domOffsetToTextOffset(r.startContainer, r.startOffset, seg.spans);
      if (at !== f.starts[i]) return false;
    }
    // Passing here is what makes this text a KNOWN-GOOD baseline: the live
    // Ranges have just been proved to sit at the offsets they were armed at, so
    // the offsets in this string mean what the undo record means. That is the
    // only claim reanchorSentenceHighlight needs from it, and taking the
    // snapshot anywhere weaker would launder an unverified field into the one
    // thing the repair trusts.
    f.text = seg.text;
    return true;
  }

  // The overlay is measured once and never recomputed, so it has to be
  // destroyed the moment anything could have moved it -- but NOT on any input
  // at all, which is what an earlier version did. That was measured and it is
  // fatal: the flash appears while the user is mid-word in the next sentence,
  // so the very next keystroke destroyed it and the one thing standing between
  // the user and an invisible edit was never on screen.
  //
  // Text validity extends through the supplied undo anchor, so green cannot
  // outlive Escape when an unchanged word later in the sentence is edited.
  // Geometry validity concerns the painted rectangles: typing after the anchor
  // can keep the overlay only while the field's own position stays unchanged.
  function revalidateSentenceFlash() {
    const f = sentenceFlashGuard;
    if (!f) return;
    if (!f.el.isConnected) { clearSentenceFlash(); return; }
    if (f.kind === "highlight") {
      // The TEXT half of the rule, unchanged from the overlay, and kept for the
      // undo rather than for the paint: `sentenceUndo` is a fixed offset pair,
      // so an edit before the correction breaks Escape whether the Range
      // noticed or not. The Range would happily follow the text (measured:
      // +32.6 to +75.8px on four families); following it here would leave a
      // green mark advertising an Escape that silently does nothing.
      //
      // And the GEOMETRY half is replaced by these two: does each range still
      // name the words it flashed, and is it still at the offset it named them
      // at? An editor that replaced the block collapses it, typing INSIDE the
      // flashed word grows it over characters the correction never touched, and
      // an aliased insertion moves it onto a byte-identical copy. None of the
      // three is visible in a rect.
      if (!sentenceFlashHolds(f, true)) clearSentenceFlash();
      return;
    }
    if (snText(f.el).slice(0, f.end) !== f.prefix) { clearSentenceFlash(); return; }
    // "Typing after the range cannot move it" holds only for a left-aligned
    // LTR line. In an RTL, right-aligned or centred field, appending text
    // slides the WHOLE line -- measured at 58.9px, seven characters, with the
    // green box sitting over "nician arr". Re-measuring on every keystroke
    // would put a forced layout in the typing path, so those fields simply
    // lose the flash on the next keystroke instead of showing a wrong one.
    if (!f.stableUnderAppend) { clearSentenceFlash(); return; }
    const r = f.el.getBoundingClientRect();
    // Width matters as much as position: a field that resizes at the same
    // origin rewraps its text under an overlay that is still sitting there.
    if (Math.abs(r.left - f.left) > 0.5 || Math.abs(r.top - f.top) > 0.5
        || Math.abs(r.width - f.width) > 0.5) clearSentenceFlash();
  }

  // Nothing that moves a field fires `input`: an ad or a banner loading above
  // it, an accordion opening, a font swapping in. Measured -- the textarea
  // overlay flash ended up 98px above its field. So while a flash is on screen,
  // watch the field's own geometry, bounded by its 1600ms lifetime.
  let sentenceWatchdog = null;

  function startOverlayWatchdog(el) {
    // Always restart rather than keeping an existing loop. rAF stops firing in
    // a backgrounded tab, so a handle left set would block every later overlay
    // from ever being watched -- and a new overlay may be on a different field
    // than the one the old loop measured.
    if (sentenceWatchdog) cancelAnimationFrame(sentenceWatchdog);
    let rect0 = el.getBoundingClientRect();
    const same = (a, b) => Math.abs(a - b) <= 0.5;
    // The expensive half of the highlight guard rebuilds the element's text
    // segments, so it runs when the DOM has actually changed rather than on
    // every one of ~96 frames. A MutationObserver is precisely the missing
    // event: "the editor normalized something" IS a mutation, and it is the
    // case a capture-phase `input` handler cannot see because the editor's own
    // handler runs after it. Starts dirty, so the first frame validates.
    let domDirty = true;
    let mo = null;
    try {
      mo = new MutationObserver(() => { domDirty = true; });
      mo.observe(el, { subtree: true, childList: true, characterData: true });
    } catch { mo = null; }
    const stop = () => {
      if (mo) { mo.disconnect(); mo = null; }
      sentenceWatchdog = null;
    };
    const tick = () => {
      if (!sentenceFlashGuard) { stop(); return; }
      if (!el.isConnected) { clearSentenceFlash(); stop(); return; }
      const f = sentenceFlashGuard;
      const hl = f && f.kind === "highlight";
      // A highlight is re-checked EVERY FRAME, not only on `input`. Revalidation
      // runs from a capture-phase input handler, and a rich editor's own
      // target-phase handler normalizes or replaces nodes AFTER that -- so the
      // one check that ran proved the DOM as it was before the editor touched
      // it. There is no event for "React finished reconciling", and a frame is
      // the granularity the paint happens at anyway. The cheap half is string
      // compares over word-length ranges plus a Set lookup; the anchoring half
      // is gated on the observer above.
      if (hl && !sentenceFlashHolds(f, domDirty)) {
        clearSentenceFlash();
        stop();
        return;
      }
      domDirty = false;
      if (sentenceFlashGuard && !hl) {
        const r = el.getBoundingClientRect();
        if (!same(r.left, rect0.left) || !same(r.top, rect0.top)
            || !same(r.width, rect0.width) || !same(r.height, rect0.height)) {
          // A highlight flash is painted from the text's own live position, so
          // a field that moved carries it along and it is never here; the
          // overlay fallback is fixed-position divs, and a moved field leaves
          // them over the wrong words.
          clearSentenceFlash();
          stop();
          return;
        }
      }
      // The chip promises an Undo that may stop anchoring at any moment.
      sentenceWatchdog = requestAnimationFrame(tick);
    };
    sentenceWatchdog = requestAnimationFrame(tick);
  }

  /** Is the one undo record still applicable to the live text? */
  function sentenceUndoAnchored() {
    const u = sentenceUndo;
    return !!u && u.el.isConnected && snText(u.el).slice(u.start, u.endAfter) === u.after;
  }

  /**
   * The element whose alignment decides whether appending moves this flash.
   *
   * A textarea's alignment is on the field, so the field is the answer. A
   * contenteditable's is on the BLOCK, and the field almost always computes
   * `start` regardless -- which is how slatejs.org's centred paragraph slid the
   * flashed word 48px with the guard reporting stable at all 24 samples. This
   * matters on the overlay FALLBACK path (no Highlight support, or a range that
   * could not be built): the highlight path is immune, but the fallback is the
   * same fixed-position divs with the same blind spot, so it needs the same
   * answer. The block the flash ENDS in, because that is the line append
   * touches.
   */
  function sentenceAlignmentEl(el, ranges) {
    if (!snIsCE(el)) return el;
    try {
      const end = Math.max(...ranges.map((r) => r.end));
      const range = rangeForInnerTextOffset(el, Math.max(0, end - 1), 1);
      let n = range && range.endContainer;
      if (n && n.nodeType === 3) n = n.parentElement;
      // Up to the nearest non-inline ancestor: `text-align` is inherited, so a
      // <span> reports the block's value anyway, but stopping at the block is
      // what makes the intent legible.
      while (n && n !== el && getComputedStyle(n).display === "inline") n = n.parentElement;
      return n && el.contains(n) ? n : el;
    } catch { return el; }
  }

  function flashSentenceHighlight(el, ranges, className, opts, end) {
    const full = snText(el);
    // All three arrays are appended in the SAME branch, so index i means the
    // same range in every one of them. `starts` used to be derived afterwards
    // as `ranges.slice(0, live.length)`, which assumes the ranges that built
    // successfully are a PREFIX of the ones asked for -- and the loop below
    // skips failures, so one unbuildable first range silently paired every
    // later Range with the wrong offset. sentenceHighlightAnchored then reads a
    // mismatch on the first frame and clears a flash that was perfectly fine.
    const live = [], texts = [], starts = [];
    for (const r of ranges) {
      const range = rangeForInnerTextOffset(el, r.start, r.end - r.start);
      if (!range) continue;
      const want = full.slice(r.start, r.end);
      // Verified against the live DOM rather than trusted. `changedRanges`
      // works in the text-offset space the guards use, and an editor that
      // structures its blocks differently can map the same offsets elsewhere;
      // a highlight over the wrong words is worse than no highlight at all.
      if (range.toString() !== want) continue;
      live.push(range);
      texts.push(want);
      starts.push(r.start);
    }
    if (!live.length) return false;

    const show = (name) => {
      clearSentenceHighlights();
      // A fresh Highlight over the SAME Range objects each step. The ranges are
      // what track the text, so re-registering them is free and re-deriving
      // them would not be.
      CSS.highlights.set(name, new Highlight(...live));
      // Recorded so the watchdog can ask whether this name STILL holds our
      // ranges -- see sentenceHighlightIntact.
      if (sentenceFlashGuard) sentenceFlashGuard.name = name;
    };

    // What has to stay true. Deliberately NOT a geometry snapshot -- see
    // revalidateSentenceFlash.
    //
    // The affordance's START, carried for the same reason `anchorEnd` is: the
    // repair has to be able to re-ask whether the span Escape will splice is
    // still WRITABLE, and that question is about the whole sentence,
    // not about the words that changed.
    const anchorStart = opts && Number.isFinite(opts.anchorStart)
      ? opts.anchorStart : Math.min(...ranges.map((r) => r.start));
    sentenceFlashGuard = {
      el, kind: "highlight", live, texts,
      end, anchorStart, prefix: full.slice(0, end),
      // The WHOLE field as of the last frame this guard was known good, not
      // just the prefix. Only reanchorSentenceHighlight reads it, and it is the
      // identity evidence a collapsed Range has destroyed -- see there.
      // Refreshed by sentenceHighlightAnchored, which already holds the
      // segments to do it with.
      text: full,
      // Where each range STARTED, in the same text-offset space the guards and
      // the undo use. Identity, not spelling -- see sentenceHighlightAnchored.
      // Built alongside `live` above rather than sliced out of `ranges`, and it
      // is also what reanchorSentenceHighlight rebuilds from.
      starts,
    };
    show(SN_HL_STEPS[0].name);

    const timers = [];
    const ac = new AbortController();
    // Reduced motion holds the tint instead of skipping it: the flash is a
    // signal, not an animation. Same rule the textarea keyframes follow, and
    // the same reason -- nothing else on screen says a correction was made.
    if (!snReducedMotion()) {
      for (const s of SN_HL_STEPS.slice(1)) timers.push(setTimeout(() => show(s.name), s.at));
    }
    timers.push(setTimeout(() => clearSentenceFlash(), SENTENCE_FLASH_MS));
    sentenceFlashTeardown = () => {
      for (const t of timers) clearTimeout(t);
      ac.abort();
      clearSentenceHighlights();
    };
    // No scroll or resize listener, and that is the point: neither can make a
    // live Range wrong. (Suggestion mode's amber mark needed them, because it
    // was half of a fixed-position chip; both went on 2026-09-24.)
    startOverlayWatchdog(el);
    return true;
  }

  function flashSentenceRanges(el, ranges, className, opts) {
    clearSentenceFlash();
    if (!ranges || !ranges.length) return;
    // `end` is the ANCHOR's end, not the last changed word's. The caller passes
    // the span the undo will need -- `job.start + replacement.length` -- because
    // `sentenceUndoAnchored`
    // checks the whole rewritten sentence. Watching only as far as the last
    // change left the flash green while a later word in the same sentence was
    // edited and Escape had already become a no-op.
    const end = opts && Number.isFinite(opts.anchorEnd)
      ? Math.max(opts.anchorEnd, ...ranges.map((r) => r.end))
      : Math.max(...ranges.map((r) => r.end));
    // The contenteditable path first. It measures nothing, so the whole mirror
    // bug family and the whole "destroy it before it can lie" teardown policy
    // stop applying -- see the block comment above the constants.
    if (snIsCE(el) && SN_HL_SUPPORTED) {
      try {
        if (flashSentenceHighlight(el, ranges, className, opts, end)) return;
      } catch {
        // Half-registered is not a state to leave behind -- and a throw between
        // `CSS.highlights.set` and the teardown being assigned is exactly the
        // window where `clearSentenceFlash` has nothing to call. Delete the
        // registrations directly, then clear whatever state did get set.
        clearSentenceHighlights();
        clearSentenceFlash();
      }
      // and fall through: a highlight that could not be built is a reason to
      // measure rects, not a reason to show the user nothing.
    }
    let rects;
    try { rects = measureSentenceRanges(el, ranges); }
    catch { return; }
    if (!rects.length) return;

    const clip = el.getBoundingClientRect();
    const nodes = [];
    for (const r of rects) {
      const left = Math.max(r.left, clip.left), right = Math.min(r.left + r.width, clip.right);
      const top = Math.max(r.top, clip.top), bottom = Math.min(r.top + r.height, clip.bottom);
      if (right - left < 1 || bottom - top < 1) continue;
      const d = document.createElement("div");
      d.className = "proofer-sentence-mark " + className;
      d.style.left = left + "px";
      d.style.top = top + "px";
      d.style.width = (right - left) + "px";
      d.style.height = (bottom - top) + "px";
      document.documentElement.appendChild(d);
      nodes.push(d);
    }
    if (!nodes.length) return;

    // Text must stay valid through the undo anchor; geometry must keep the
    // painted rects correct. Rechecked on input by revalidateSentenceFlash.
    const cs = getComputedStyle(sentenceAlignmentEl(el, ranges));
    const align = cs.textAlign;
    sentenceFlashGuard = {
      el,
      end, prefix: snText(el).slice(0, end),
      left: clip.left,
      top: clip.top,
      width: clip.width,
      // Only a left-aligned LTR line keeps its glyphs in place when text is
      // appended after them. See revalidateSentenceFlash.
      stableUnderAppend: cs.direction !== "rtl"
        && (align === "left" || align === "start" || align === ""),
    };
    startOverlayWatchdog(el);

    const ac = new AbortController();
    let timer = null;
    const teardown = () => {
      if (timer) clearTimeout(timer);
      ac.abort();
      for (const n of nodes) n.remove();
    };
    sentenceFlashTeardown = teardown;
    const drop = () => clearSentenceFlash();
    el.addEventListener("scroll", drop, { signal: ac.signal });
    window.addEventListener("scroll", drop, { capture: true, passive: true, signal: ac.signal });
    window.addEventListener("resize", drop, { signal: ac.signal });
    timer = setTimeout(() => clearSentenceFlash(), SENTENCE_FLASH_MS);
  }

  // Test seam. Content scripts run in an isolated world, so this is invisible
  // to the page; the suites reach it by loading content.js directly (see
  // test/lib/content-sandbox.mjs). It exists so the segmenter and the trigger
  // are tested as they SHIP rather than as a copy in test/lib that drifts.
  globalThis.__prooferSentence = {
    MIN_SENTENCE_CHARS, SENTENCE_TRIGGER_CHARS, SENTENCE_IDLE_MS,
    SENTENCE_BULK_CHARS, SENTENCE_MAX_JOB_MS, SENTENCE_CONTEXT_CHARS,
    SENTENCE_WARM_RENEW_MS,
    segmentSentences, nextSentenceTarget, sentenceContextFor,
    sentenceAnchorFailure, sentenceCaretRefusal, changedRanges, endsSentence,
    endsWithAbbreviation, hasUnbalancedOpener, endsMidNumber, describeChange,
    // The field adapter. Exported so the suites drive the SHIPPING accessors
    // against a contenteditable rather than a second implementation of them.
    SENTENCE_CE_MAX_CHARS, snIsCE, snText, snCaret, snMaxLength, snIsFocused, snIsEmptyComposer,
    // The skip batch flushes on a 30s timer, which no suite can wait for.
    // Exposed so the coverage tally can be asserted at all -- without it the
    // `field:*` counting has no gate, and "delete the counting" is a mutant
    // that stays green.
    flushSentenceSkips,
    sentenceEligibleEl, sentenceWriteLanded, sentenceWriteDisposition, spliceSentenceCE, spliceSentenceSlate, snIsSlate, rangeForInnerTextOffset, snCollapsedRange,
    narrowEdit,
    // The transport registry and the status vocabulary. Exported so
    // sentence-editors-test.mjs drives the SHIPPING recipe selection against a
    // real editor rather than re-deriving which recipe it thinks should run.
    SN_TRANSPORTS, editorAdapterFor, sentenceFieldStatus, spliceSentenceVia,
    sentenceStatusReport,
    // The block itself. Exported because the two NON-demoting causes are what
    // the popup could not tell apart, and reaching them through a real write
    // needs two editors that fail in two different ways -- so the suite would
    // be measuring the fixtures rather than the reporting.
    blockSentenceField,
    // The durability veto. Driven directly because the situation it exists for
    // -- an editor that accepts a write and discards it on the next keystroke
    // -- is by definition one no fixture reproduces on its own.
    watchSentenceDurability, stopSentenceDurabilityWatch,
    // The PRODUCTION caller. Exported because the failure paths -- the caret
    // gating on `ignored` and `misplaced` -- are decided here and not in the
    // splice, so a probe that calls the splice directly measures half the
    // behaviour and reports it as all of it.
    applySentenceWrite,
    // Whether a real apply ARMED the watch. Driving watchSentenceDurability
    // directly proves the watcher works and says nothing about whether
    // applySentence ever calls it -- deleting that call left the veto suite
    // green.
    sentenceDurabilityArmed: () => !!sentenceDurabilityWatch,
    // Whether a correction is being held for a pause. The configuration-change
    // case has to act while one is, and "held" has no other observable.
    sentenceDeferredHeld: () => !!sentenceDeferred,
  };

  // --- Status reporting to the popup ---------------------------------------

  function sentenceStatusReport() {
    return {
      ok: true,
      status: sentenceStatus.status,
      detail: sentenceStatus.detail,
      family: sentenceStatus.family,
      // Named so the popup can say WHERE, and because a wrong frame answering
      // is otherwise undiagnosable.
      frame: window.location.host || null,
      top: window === window.top,
      // Cached current worker permission. The popup checks it before calling
      // either the current or a remembered field running; history grants nothing.
      apply: sentenceAllowed,
      last: sentenceLastField
        ? { ...sentenceLastField, agoMs: Date.now() - sentenceLastField.at }
        : null,
    };
  }

  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || msg.type !== "SENTENCE_STATUS") return;
        return replySentenceStatus(focusedEditable, sentenceLastField, sentenceStatusReport, sendResponse);
      });
    }
  } catch {
    // An orphaned content script has no chrome.runtime. Nothing to register on,
    // and the popup's own "could not reach the page" path already covers it.
  }

  // --- Focus / blur / input handlers ---

  function handleFocusIn(e) {
    if (!e.isTrusted) return;
    const el = e.target;
    if (!isEditableElement(el)) return;
    const root = getEditableRoot(el);
    focusedEditable = root;
    loadSettings().then(() => {
      if (focusedEditable !== root) return;
      loadSentenceConsent().then(() => {
        if (focusedEditable === root) sentenceAttach(root);
      });
    });
  }

  function handleFocusOut(e) {
    if (!e.isTrusted) return;
    const blurredEl = e.target;
    setTimeout(() => {
      const active = document.activeElement;
      if (active && isEditableElement(active)) {
        // Switching to a different editable. Compare roots, since focus may
        // move between children of the same contenteditable.
        const activeRoot = getEditableRoot(active);
        const blurredRoot = getEditableRoot(blurredEl);
        if (blurredRoot && activeRoot !== blurredRoot) teardownSentence();
        focusedEditable = activeRoot;
        // Unconditional: sentenceAttach is also where the refusal gets its
        // name, so gating it on sentenceAllowed put the mode being off and the
        // field being unusable back into one silence.
        sentenceAttach(activeRoot);
        return;
      }
      focusedEditable = null;
      // The LIVE status only; sentenceLastField deliberately survives, because
      // opening the popup is itself a blur.
      sentenceStatus = { status: "no-field", detail: null, family: null };
      teardownSentence();
    }, 0);
  }

  function handleInput(e) {
    if (!e.isTrusted) return;
    if (applyingRewrite) return;
    // Checked for every field, not just the tracked one: an edit anywhere can
    // reflow the page under an overlay that is already on screen.
    revalidateSentenceFlash();
    // contains(), not identity: a contenteditable fires `input` on its editing
    // host, but nested editors and shadow-hosted lines can retarget it.
    if (sentenceTrack && (e.target === sentenceTrack.el || sentenceTrack.el.contains(e.target))) {
      onSentenceInput(sentenceTrack.el, e);
    }
  }

  // --- Keyboard handler ---

  function handleKeydown(e) {
    if (!e.isTrusted) return;

    // A silent apply shows no chip, so Escape is the affordance that replaced
    // its Undo button -- and it is the ONLY one. Ctrl+Z is not a substitute:
    // measured on the textarea path, after the user types on, one Ctrl+Z undoes
    // THEIR typing and it takes two to reach the splice. On Slate it is worse,
    // because the correction is one of Slate's own history entries and the
    // arithmetic depends on the editor.
    //
    // Anchored-only: doSentenceUndo refuses if the text moved. The check is
    // repeated here because the call is async and preventDefault is not -- the
    // key has to be claimed now, on evidence gathered now.
    if (e.key === "Escape" && sentenceUndoAnchored()) {
      e.preventDefault();
      doSentenceUndo();
      return;
    }
  }

  // --- Init ---

  document.addEventListener("focusin", handleFocusIn, { capture: true, signal: globalAC.signal });
  document.addEventListener("focusout", handleFocusOut, { capture: true, signal: globalAC.signal });
  document.addEventListener("input", handleInput, { capture: true, signal: globalAC.signal });

  // A rich editor can consume a keystroke with NO `input` event at all, and
  // this is the only listener that can see it happen.
  //
  // slate-react takes the browser's native edit path only for `insertText`
  // whose data matches /[a-z ]/i over a collapsed selection. For anything else
  // -- a PERIOD, notably -- it calls preventDefault() on `beforeinput` and
  // applies the edit through its own model instead, so the browser never fires
  // `input`. Measured on the real Slate capture: every letter of
  // "The techncian arrived early" delivered an input event and the terminator
  // delivered none, while the DOM gained it regardless.
  //
  // To a provenance check that is indistinguishable from a page mutation -- and
  // it lands on precisely the character that makes a sentence eligible, so
  // EVERY sentence completion on Slate read as unaccounted. Corrections went
  // from 4-6/6 to 0/6: not a tightened guard but a mode that had stopped
  // working, and the offline suites could not see it because a Slate-SHAPED
  // fixture has no model to cancel anything, so the browser applies the period
  // natively there and `input` arrives as normal.
  //
  // `beforeinput` is the evidence that survives an editor cancelling its own
  // default. It is trusted, a page cannot forge it, and it fires whether or not
  // the edit is then performed by the browser. It says only "the user is
  // editing this field"; WHAT they typed is read afterwards, once the editor
  // has rendered, and is still size-bounded by the settle poll.
  //
  // Registered here rather than inside the splice guard on purpose: that guard
  // attaches later and calls stopImmediatePropagation, so it cannot be relied
  // on to leave this listener a turn -- but capture listeners run in
  // registration order, and this one exists from init. Synthetic dispatches
  // from our own splice are untrusted and drop out at the first line.
  document.addEventListener("beforeinput", (e) => {
    if (!e.isTrusted || applyingRewrite) return;
    if (sentenceComposing) return;
    const st = sentenceTrack;
    if (!st || !sentenceAllowed) return;
    if (!(e.target === st.el || st.el.contains(e.target))) return;
    // Adopts NOTHING on trust. `beforeinput` fires before the edit exists, so a
    // synchronous adoption here would re-baseline whatever is in the field on
    // the strength of a keystroke that has not happened yet -- which is exactly
    // how a page mutation followed by one keypress would launder itself. The
    // poll starts from the EXISTING baseline instead, so anything that appeared
    // since is measured in full and fenced if it clears the size cap.
    // The verifier's half: say a trusted edit is in flight NOW (so a sample
    // taken before the poll finishes waits instead of judging), and hand it the
    // observer's own conclusion when the poll lands.
    // This poll is the ONLY source of a receipt for an edit the editor applies
    // without an `input` event -- a period on Slate.
    st.userEditWait = (st.userEditWait || 0) + 1;
    settleSentenceObserved(st, st.observedText, (text) => {
      if (st.userEditWait > 0) st.userEditWait--;
      if (text != null) { noteSentenceUserEdit(st, text, "poll"); return; }
      // Nothing to report. Whether that is an AMBIGUITY depends on what
      // superseded this poll, not on the sequence number: the input path
      // answering this very keystroke means it is accounted for, while another
      // poll adopting in the meantime leaves this keystroke unaccounted and the
      // receipt naming only the earlier one.
      if (st.userEditVia === "input") return;
      noteSentenceUserEdit(st, null, "poll");
    });
  }, { capture: true, signal: globalAC.signal });
  document.addEventListener("keydown", handleKeydown, { capture: true, signal: globalAC.signal });
  // Resumption for a caret-deferred target (see the `pre-send:` branch in
  // maybeFireSentence). Coalesced: the flag is cleared on the first selection
  // change after a deferral, so a caret that stays inside costs one idle scan
  // per movement and is never polled. It schedules the GUARDED scan and
  // nothing else -- that scan re-reads caret and provenance like any other and
  // adopts nothing.
  document.addEventListener("selectionchange", () => {
    const st = sentenceTrack;
    if (!st || !st.caretHeld) return;
    st.caretHeld = false;
    if (sentenceAllowed && st.el.isConnected) scheduleSentenceIdle();
  }, { signal: globalAC.signal });

  // An IME session is bracketed by these two events. Tracking the session --
  // rather than reading isComposing off one input event -- is what stops a
  // response landing in the middle of someone composing Japanese.
  document.addEventListener("compositionstart", (e) => {
    if (!e.isTrusted) return;
    sentenceComposing = true;
    // The verifier has to hear about this AT THE START. While a session is
    // open the `beforeinput` listener skips and `onSentenceInput` returns, so
    // no receipt is written -- and a correction whose 150ms sample lands inside
    // an open composition saw an unchanged sequence, read the composing text as
    // a page rewrite, and blocked a perfectly healthy field. Recorded as
    // unattributable, which is what an open IME session honestly is.
    if (sentenceTrack) noteSentenceUserEdit(sentenceTrack, null, "input");
    if (sentenceJob) sentenceJob.dirty = true;
    clearSentenceIdle();
  }, { capture: true, signal: globalAC.signal });
  document.addEventListener("compositionend", (e) => {
    if (!e.isTrusted) return;
    sentenceComposing = false;
    // The composed text arrived as one insertion the input path deliberately
    // ignored, so every offset is stale.
    //
    // This is also where the session's text is adopted as accounted for. The
    // input path skips every intermediate composition state -- those are the
    // IME's working copy rather than the user's text -- so without an adoption
    // here the first scan after committing Japanese would refuse the whole
    // field as an unseen mutation. `compositionstart`/`compositionend` cannot
    // be synthesized with `isTrusted`, and both handlers check it, so the
    // session as a whole is user-driven. The residual is named rather than
    // covered: a page mutation landing DURING the session is committed with it,
    // because at `compositionend` the two are no longer distinguishable.
    if (sentenceTrack) {
      rederiveWatermark("composition-end");
      noteSentenceObservedSettled(sentenceTrack);
      // A commit is the user's, and the residual above is exactly why the write
      // verifier is told "the user did something, and I cannot say what the
      // field holds because of it": a page mutation landing during the session
      // is committed with it. Uncertain, so unverified rather than a block.
      noteSentenceUserEdit(sentenceTrack, null, "input");
    }
  }, { capture: true, signal: globalAC.signal });

  // Skip counters are batched, so a tab closing mid-batch would lose them.
  window.addEventListener("pagehide", flushSentenceSkips, { signal: globalAC.signal });

  // Hide extension UI during print (CSS @media print can be unreliable for content scripts)
  let prePrintDisplay = {};
  window.addEventListener("beforeprint", () => {
    prePrintDisplay = {};
    clearSentenceFlash();
    const srLive = document.getElementById("proofer-sr-live");
    for (const [key, node] of [["sr", srLive]]) {
      if (node) { prePrintDisplay[key] = node.style.display; node.style.display = "none"; }
    }
  }, { signal: globalAC.signal });
  window.addEventListener("afterprint", () => {
    const srLive = document.getElementById("proofer-sr-live");
    for (const [key, node] of [["sr", srLive]]) {
      if (node && key in prePrintDisplay) node.style.display = prePrintDisplay[key];
    }
    prePrintDisplay = {};
  }, { signal: globalAC.signal });
})();
