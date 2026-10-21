// Keep fork contact changes and the published policy synchronized.
import assert from "node:assert/strict";
import fs from "node:fs";
import { policyForCheckout, renderPolicy } from "../tools/privacy-policy.mjs";

assert.equal(fs.readFileSync(new URL("../docs/privacy-policy.md", import.meta.url), "utf8"), policyForCheckout());
const changed = renderPolicy('const PROOFER_MAINTAINER = { name: "Example Maintainer", email: "support@example.org" };',
  "Contact {{maintainerName}} at {{maintainerEmail}}. Again: {{maintainerEmail}}.");
assert.match(changed, /Contact Example Maintainer at support@example\.org\. Again: support@example\.org\./);
assert.throws(() => renderPolicy('const PROOFER_MAINTAINER = { name: "", email: "invalid" };', ""), /name and email/);
assert.match(policyForCheckout(), /does not authorize model training/);
console.log("Privacy policy generation, fork contact and support-only purpose checks passed.");
