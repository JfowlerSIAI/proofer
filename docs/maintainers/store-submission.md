# Chrome Web Store submission

This is the publisher workflow for a reviewed Proofer extension package.
Publishing the source repository does not submit an extension to a store.
The listing copy is in [store-listing.md](store-listing.md); the intended beta
visibility is **Unlisted**. No live store listing URL is supplied here.

## Prepare the package

Follow [the release guide](../releasing.md) to validate the source and build a
versioned extension ZIP and checksum file:

```bash
node tools/test.mjs source
node tools/release.mjs
```

Upload the generated extension ZIP, with `manifest.json` at its root. Do not
upload a ZIP of the repository or a developer's working directory. Confirm the
manifest version is newer than the previous store upload, and check that its
name, description, permissions and model pin match the listing copy.

The canonical [privacy policy](../privacy-policy.md) is generated from the
single policy template and `maintainer.js`; its [contact section](../privacy-policy.md#contact)
is the maintainer contact. Before submission, publish the reviewed repository
and replace the duplicate body at the legacy
[privacy-site URL](https://jfowlersiai.github.io/proofer-privacy/) with a redirect
to that canonical page, as described in [the release guide](../releasing.md#maintaining-the-privacy-policy).
Verify the live link and the policy's match with the release behavior. A fork
must change its publisher identity, repository URLs and maintainer setting,
then regenerate the policy.

## Dashboard workflow

1. Sign in to the intended publisher account in the
   [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).
   Complete any account registration, verification and publisher declarations
   requested there.
2. Create the item or upload a new package to the existing item. Use the
   description, single purpose, permission justifications and reviewer
   instructions from [store-listing.md](store-listing.md).
3. Upload the assets listed there. They show the real extension with a fake
   local Ollama and synthetic mail; no user messages or browser profile are
   pictured. Regenerate them when the relevant UI changes.
4. Complete the Privacy practices tab from the current data inventory and
   hosted policy. Free-form writing may contain personal or sensitive data;
   local-only processing does not justify blanket negative declarations.
5. Select the intended distribution and review the entire draft. Submit the
   reviewed package, then choose automatic or deferred publication according
   to the [reviewed release procedure](../releasing.md#publish-a-reviewed-release).

Google documents these steps in its
[publishing guide](https://developer.chrome.com/docs/webstore/publish) and
[privacy-fields guide](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy).

## Review the install experience

Run [the acceptance test](acceptance-test.md) against the actual package.
Ollama and the engine download are required, and a slow computer can correctly
receive a **Too slow** result and remain off. The reviewer instructions should
explain this prerequisite without bypassing setup's qualification or consent.

The extension processes text through loopback and can keep it in
`chrome.storage.local`. Its setup disclosure appears before **Turn on**.
The publisher must verify the current store requirements for disclosure,
consent and storage; the listing text alone is not a substitute for in-product
disclosure. See Google's
[User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq).

After approval, add the actual store URL to the installation guide. For later
updates, increment the manifest version and repeat package validation and
submission. Review time and dashboard fields can change; use the linked
Google documentation for the current process.
