// The Trix website artwork has no established redistribution grant. This
// locally authored wrapper exercises the same captured Trix engine without it.
import fs from "node:fs";
import path from "node:path";

export function writeTrixFixture(outDir) {
  const base = "_external/unpkg.com/trix@2.1.19/dist/";
  for (const file of ["trix.umd.min.js", "trix.css"]) {
    if (!fs.existsSync(path.join(outDir, base, file))) {
      throw new Error(`missing pinned Trix 2.1.19 asset: ${base}${file}; restore it from version control`);
    }
  }
  const html = `<!doctype html>
<!-- Proofer-authored offline harness, 2026-10-21.
     The Trix 2.1.19 engine and stylesheet are unchanged captured upstream files.
     License and source evidence: test/fixtures/THIRD_PARTY_NOTICES.md. -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'">
  <title>Trix offline editor fixture</title>
  <link rel="icon" href="data:,">
  <link rel="stylesheet" href="/${base}trix.css">
  <script src="/${base}trix.umd.min.js" defer></script>
  <style>
    body { max-width: 900px; margin: 40px auto; padding: 0 24px; color: #202124;
           font: 16px/1.6 system-ui, sans-serif; }
    trix-editor { min-height: 300px; background: white; }
  </style>
</head>
<body>
  <h1>Trix offline editor fixture</h1>
  <p>This page uses the real Trix document model and editing surface.</p>
  <input id="fixture-document" type="hidden" value="&lt;div&gt;A short paragraph for editing.&lt;/div&gt;&lt;div&gt;A second paragraph with &lt;strong&gt;bold text&lt;/strong&gt;.&lt;/div&gt;">
  <trix-editor input="fixture-document" aria-label="Test document"></trix-editor>
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, "index.html"), html);
  const types = {
    "index.html": "text/html; charset=utf-8",
    [`${base}trix.css`]: "text/css; charset=utf-8",
    [`${base}trix.umd.min.js`]: "text/javascript; charset=utf-8",
  };
  fs.writeFileSync(path.join(outDir, "_types.json"), JSON.stringify(types, null, 1) + "\n");
  return { name: "trix", files: 4, bytes: Buffer.byteLength(html), external: [], version: "Trix 2.1.19" };
}
