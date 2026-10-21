// Deterministic tokenizer + aligner producing MINIMAL EDIT GROUPS between a
// source sentence and a teacher-corrected sentence.
//
// Why this exists: training judgments operate at the level of EDIT GROUPS, not whole sentences — `required-correction` and
// `benign-optional` survive into the training target, `unnecessary`,
// `meaning-damage` and `uncertain` revert that group to the source text. That
// only works if the decomposition is (a) deterministic, so a stored verdict
// still names the same span a week later, and (b) EXACT, so applying every
// group reproduces the corrected sentence byte for byte and reverting one
// leaves the rest intact.
//
// The decomposition is region-based rather than op-based, which is what buys
// both properties at once:
//
//   1. Tokenize both sides into significant tokens (words / punctuation runs).
//      Whitespace is NOT a token — it is the gap between them, carried by the
//      char offsets.
//   2. LCS over token text (case-sensitive; a case-only change is an edit).
//      The forward backtrack takes the EARLIEST optimal match, so a doubled
//      word groups as "the second one went away" rather than the first.
//   3. Every matched pair is an ANCHOR. The source is then partitioned by the
//      anchors, and each inter-anchor region is compared against the
//      corresponding region of the corrected text. A region whose two sides
//      differ IS an edit group; a region whose sides are equal is not.
//
// This merges adjacent changed tokens for free (they share a region), handles
// moved spaces in both directions (`wek nwo` -> `we know`, `filtererrors` ->
// `filter errors`) without a special case, and makes the round trip a theorem
// rather than a hope: unchanged regions are byte-identical by construction and
// anchor tokens matched, so `applyGroups(src, groups, ALL)` === corrected.
//
// The one cosmetic step is `narrowRegion`, which trims a common leading /
// trailing run of WHITESPACE off a region's two sides. Whitespace only — never
// partial word characters. Character-level narrowing gives smaller spans and
// unreadable ones (`wek nwo` -> `we know` narrows to `k nwo` -> ` know`,
// because the trailing `o` matches), and the judge has to read these.
//
// ONE CONSEQUENCE THE JUDGE PROMPT HAS TO CARRY. Adjacent changed tokens share
// a region and therefore share a verdict (§3's merge rule). So a correct typo
// fix sitting next to a meaning change is a SINGLE group — `1200 unts` ->
// `1300 units` cannot be split into "keep the plural, revert the number". The
// standing asymmetry settles it in the safe direction: any damage inside a
// group makes the whole group damage, and the fix riding along is lost. That is
// a missed fix, which is cheap. The prompt states the rule explicitly, because
// a judge that assumes one group is one change will label these wrong, and
// judge-edit-groups-test.mjs pins the shape so nobody "fixes" it by splitting
// groups on token boundaries and quietly makes half a group applicable.
//
// No side effects at import. Other files import it.

const WORD_RE = /[\p{L}\p{N}_]+(?:['’\-][\p{L}\p{N}_]+)*['’]?/uy;

// Above this many token pairs the LCS table is not worth building; the whole
// string becomes one group instead. Sentence-mode inputs are one sentence, so
// this is a guard against a malformed record, not a normal path.
const LCS_CELL_CAP = 1_000_000;

/**
 * Split text into significant tokens. Whitespace is skipped (it lives in the
 * gaps between token offsets); a run of the SAME punctuation character is one
 * token, so `...` and `!!` do not fragment.
 *
 * `_` counts as a word character so `__init__` and `snake_case` stay whole —
 * they are protected-token shapes and a group forming inside one would be
 * misleading. An interior `'`/`’`/`-` joins two alphanumeric runs, so
 * `don't`, `it's`, `36-day` and `covid-19` are single tokens; a trailing
 * apostrophe is absorbed, so `workers'` is one token. The known cost of that
 * last rule: `'quoted'` tokenizes as punct `'` + word `quoted'`. Both sides
 * tokenize the same way, so groups are still correct — it only affects where a
 * boundary falls.
 *
 * @param {string} text
 * @returns {{text: string, start: number, end: number, kind: "word"|"punct"}[]}
 */
export function tokenize(text) {
  const out = [];
  const s = String(text);
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    WORD_RE.lastIndex = i;
    const m = WORD_RE.exec(s);
    if (m && m.index === i && m[0].length) {
      out.push({ text: m[0], start: i, end: i + m[0].length, kind: "word" });
      i += m[0].length;
      continue;
    }
    let j = i + 1;
    while (j < s.length && s[j] === ch) j++;
    out.push({ text: s.slice(i, j), start: i, end: j, kind: "punct" });
    i = j;
  }
  return out;
}

/**
 * LCS anchors between two token arrays: pairs [ai, bi] of indices whose tokens
 * are byte-identical and lie on a longest common subsequence. Earliest optimal
 * match wins (for LCS, if a[i] === b[j] there is always an optimal solution
 * using that match, so the greedy forward walk is optimal, not a heuristic).
 *
 * @returns {[number, number][]}
 */
export function lcsAnchors(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  if (n * m > LCS_CELL_CAP) return [];
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i], next = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i].text === b[j].text
        ? next[j + 1] + 1
        : Math.max(next[j], row[j + 1]);
    }
  }
  const anchors = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) { anchors.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return anchors;
}

// Trim a common leading and then a common trailing run of WHITESPACE from the
// two sides of a region. Returns the offsets to advance/retract by.
function narrowRegion(srcText, outText) {
  let lead = 0;
  while (lead < srcText.length && lead < outText.length
         && srcText[lead] === outText[lead] && /\s/.test(srcText[lead])) lead++;
  let tail = 0;
  const sMax = srcText.length - lead, oMax = outText.length - lead;
  while (tail < sMax && tail < oMax
         && srcText[srcText.length - 1 - tail] === outText[outText.length - 1 - tail]
         && /\s/.test(srcText[srcText.length - 1 - tail])) tail++;
  return { lead, tail };
}

function classify(before, after) {
  if (before === "") return "insertion";
  if (after === "") return "deletion";
  if (/^\s*$/.test(before) && /^\s*$/.test(after)) return "whitespace";
  return "substitution";
}

/**
 * The edit groups between `source` and `corrected`.
 *
 * Each group is `{ id, srcSpan: [start, end), before, after, kind }`, where
 * `before === source.slice(...srcSpan)`, ids are 1-based in source order, and
 * `kind` is one of insertion / deletion / whitespace / substitution. `kind` is
 * derived metadata for stratifying calibration samples — it is NOT rendered
 * into the judge prompt, because handing the judge a pre-classification of the
 * edit is exactly the way to bias the verdict it is being asked for.
 *
 * An identical pair returns [].
 *
 * @param {string} source
 * @param {string} corrected
 * @returns {{id:number, srcSpan:[number,number], before:string, after:string, kind:string}[]}
 */
export function editGroups(source, corrected) {
  const src = String(source), out = String(corrected);
  if (src === out) return [];
  const a = tokenize(src), b = tokenize(out);
  const anchors = lcsAnchors(a, b);

  // Region boundaries: the gap before the first anchor, between each adjacent
  // pair, and after the last. Each is (source slice, corrected slice).
  const regions = [];
  let prevA = 0, prevB = 0;          // char offsets already consumed
  for (const [ai, bi] of anchors) {
    regions.push([prevA, a[ai].start, prevB, b[bi].start]);
    prevA = a[ai].end;
    prevB = b[bi].end;
  }
  regions.push([prevA, src.length, prevB, out.length]);

  const groups = [];
  for (const [as, ae, bs, be] of regions) {
    let sText = src.slice(as, ae), oText = out.slice(bs, be);
    if (sText === oText) continue;
    const { lead, tail } = narrowRegion(sText, oText);
    const before = sText.slice(lead, sText.length - tail);
    const after = oText.slice(lead, oText.length - tail);
    if (before === after) continue;   // unreachable given sText !== oText, kept honest
    groups.push({
      id: groups.length + 1,
      srcSpan: [as + lead, ae - tail],
      before,
      after,
      kind: classify(before, after),
    });
  }
  return groups;
}

/**
 * Rebuild a sentence from `source` by applying the groups whose ids are in
 * `keepIds` and reverting the rest. `applyGroups(src, editGroups(src, out))`
 * with every id kept === out, exactly; that round trip is asserted for every
 * fixture in judge-edit-groups-test.mjs and is what makes a per-group verdict
 * mean something.
 *
 * @param {string} source
 * @param {{id:number, srcSpan:[number,number], before:string, after:string}[]} groups
 * @param {Iterable<number>|null} keepIds  null/undefined = keep all
 */
export function applyGroups(source, groups, keepIds) {
  const keep = keepIds == null ? null : new Set(keepIds);
  const src = String(source);
  let out = "", pos = 0;
  for (const g of groups) {
    const [s, e] = g.srcSpan;
    out += src.slice(pos, s);
    out += (keep === null || keep.has(g.id)) ? g.after : g.before;
    pos = e;
  }
  return out + src.slice(pos);
}

/**
 * The source with each group's span bracketed as `⟦n:...⟧`, so the
 * judge can see WHERE an edit sits — a zero-width insertion has no before-span
 * to locate it by, and "before: '' after: ','" is unjudgeable on its own.
 */
export function markSource(source, groups) {
  const src = String(source);
  let out = "", pos = 0;
  for (const g of groups) {
    const [s, e] = g.srcSpan;
    out += src.slice(pos, s) + "⟦" + g.id + ":" + src.slice(s, e) + "⟧";
    pos = e;
  }
  return out + src.slice(pos);
}

/**
 * Render one example as the judge sees it. Spans are JSON-quoted so whitespace
 * is visible — a group that moves a space is otherwise invisible on the page.
 */
export function renderExample({ uid, context, input, output, groups }) {
  const gs = groups || editGroups(input, output);
  const lines = [];
  lines.push(`### EXAMPLE ${uid}`);
  lines.push(`PRIOR_CONTEXT: ${context ? JSON.stringify(context) : "(none)"}`);
  lines.push(`SOURCE:    ${JSON.stringify(input)}`);
  lines.push(`CORRECTED: ${JSON.stringify(output)}`);
  lines.push(`MARKED:    ${JSON.stringify(markSource(input, gs))}`);
  lines.push(`EDIT_GROUPS:`);
  for (const g of gs) {
    lines.push(`  [${g.id}] ${JSON.stringify(g.before)} -> ${JSON.stringify(g.after)}`
               + `   (source chars ${g.srcSpan[0]}-${g.srcSpan[1]})`);
  }
  return lines.join("\n");
}
