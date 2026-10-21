// Few-shot contamination check.
//
// A prompt whose examples demonstrate the exact word substitution a test case
// requires is teaching the answer, not the skill. That is what happened with
// the v16 prompt: its 8 examples covered 14.6% of the lab corpus and 0% of the
// holdout, which is precisely why an 8.4pp tuning-corpus gain transferred to
// +1 case out of 160.
//
// Overlap is measured at the SUBSTITUTION level (which word becomes which),
// not the sentence level. "No example sentence appears in the corpus" is true
// of almost every prompt and tells you nothing.

const norm = s => s.toLowerCase().replace(/[.,!?;:]+$/g, "");

/** Word-level substitutions between two strings, as "before>after" keys. */
export function substitutions(before, after) {
  const a = before.split(/\s+/).map(norm).filter(Boolean);
  const b = after.split(/\s+/).map(norm).filter(Boolean);
  const out = new Set();

  // Longest-common-subsequence alignment, then read off the non-matching runs.
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0, delBuf = [], insBuf = [];
  const flush = () => {
    if (delBuf.length || insBuf.length) out.add(`${delBuf.join(" ")}>${insBuf.join(" ")}`);
    delBuf = []; insBuf = [];
  };
  while (i < m && j < n) {
    if (a[i] === b[j]) { flush(); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { delBuf.push(a[i++]); }
    else { insBuf.push(b[j++]); }
  }
  while (i < m) delBuf.push(a[i++]);
  while (j < n) insBuf.push(b[j++]);
  flush();
  return out;
}

/** Pull "before" -> "after" example pairs out of a prompt string. */
export function extractExamplePairs(promptText) {
  const pairs = [];
  const arrow = /"([^"]{3,120})"\s*(?:->|→|=>)\s*"([^"]{3,120})"/g;
  let m;
  while ((m = arrow.exec(promptText)) !== null) pairs.push([m[1], m[2]]);
  // JSON-style example pairs: {"...": "input"} ... {"rewritten": "output"}
  const jsonish = /"(?:input|text|before)"\s*:\s*"([^"]{3,120})"[\s\S]{0,80}?"(?:rewritten|corrected_text|output|after)"\s*:\s*"([^"]{3,120})"/g;
  while ((m = jsonish.exec(promptText)) !== null) pairs.push([m[1], m[2]]);

  // Simulated ChatML turns: the user's bare text, then an assistant turn whose
  // JSON carries the correction. This is how multi-turn few-shot is expressed
  // through Ollama's single-prompt API, and it was invisible to the patterns
  // above — which reported "0 examples taught" and looked like a clean result.
  const chatml = /(?:^|<\|im_start\|>user\s*\n?)([^\n<]{3,200}?)\s*<\|im_end\|>\s*<\|im_start\|>assistant\s*\n?(.{3,300}?)<\|im_end\|>/gs;
  while ((m = chatml.exec(promptText)) !== null) {
    const after = m[2].trim();
    const asJson = after.match(/"(?:rewritten|corrected_text|corrected|text|output)"\s*:\s*"([^"]{3,200})"/);
    pairs.push([m[1].trim(), asJson ? asJson[1] : after.replace(/^["']|["']$/g, "")]);
  }

  // UNQUOTED arrows: Input -> Output on one line. The quoted-operand pattern
  // above silently misses these, which reads as "no examples, nothing to check".
  const bareArrow = /^[^\n]{0,20}?([A-Z][^\n"]{4,120}?)\s*(?:->|→|=>)\s*([^\n"]{4,120}?)\s*$/gm;
  while ((m = bareArrow.exec(promptText)) !== null) pairs.push([m[1].trim(), m[2].trim()]);

  // Inline labelled pair on a single line: Input: x  Reply: {"rewritten":"y"}
  const inline = /(?:input|user)\s*:\s*([^\n]{3,120}?)\s+(?:reply|output|assistant|response)\s*:\s*(?:\{[^}]*"(?:rewritten|corrected_text|text)"\s*:\s*"([^"]{3,120})"[^}]*\}|([^\n]{3,120}))/gi;
  while ((m = inline.exec(promptText)) !== null) pairs.push([m[1].trim(), (m[2] || m[3] || "").trim()]);

  // Plain "before" / "after" lines: Input: x  Output: y
  const labelled = /(?:input|before)\s*:\s*"?([^\n"]{3,200}?)"?\s*\n\s*(?:output|after|corrected)\s*:\s*"?([^\n"]{3,200}?)"?\s*(?:\n|$)/gi;
  while ((m = labelled.exec(promptText)) !== null) pairs.push([m[1].trim(), m[2].trim()]);

  return pairs;
}

/**
 * What fraction of `cases` require a substitution that the prompt's examples
 * already demonstrate.
 */
export function contaminationRate(promptText, cases) {
  const taught = new Set();
  for (const [before, after] of extractExamplePairs(promptText)) {
    for (const s of substitutions(before, after)) taught.add(s);
  }
  if (!taught.size) return { taught: 0, hits: 0, total: cases.length, rate: 0, examples: [] };

  const hits = [];
  for (const c of cases) {
    if (c.expected === c.input) continue; // clean cases teach nothing
    for (const s of substitutions(c.input, c.expected)) {
      if (taught.has(s)) { hits.push({ input: c.input, substitution: s }); break; }
    }
  }
  return {
    taught: taught.size,
    hits: hits.length,
    total: cases.length,
    rate: (hits.length / cases.length) * 100,
    examples: hits.slice(0, 5),
  };
}
