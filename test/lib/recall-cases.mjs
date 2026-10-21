// The hand-built recall corpora, READ OUT OF sentence-typo-recall-test.mjs.
//
// That suite is a script (it calls process.exit), so it cannot be imported.
// This holds no cases of its own: it slices the two array literals out of the
// suite's source and evaluates them, so an audit tool measures the same cases
// the suite asserts on and cannot drift from them.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "sentence-typo-recall-test.mjs"), "utf8");

function arrayLiteral(name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) throw new Error(`no array named ${name}`);
  const open = src.indexOf("[", start);
  const end = src.indexOf("\n];", open);
  if (end < 0) throw new Error(`unterminated array ${name}`);
  return eval(src.slice(open, end + 2));
}

/** Ordinary typing mistakes that SHOULD apply: [input, human correction]. */
export const RECALL_SHOULD = arrayLiteral("should");
/** Damage cases that MUST be refused: [input, bad model output]. */
export const RECALL_MUST_REFUSE = arrayLiteral("mustRefuse");
