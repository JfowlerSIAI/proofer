# Proofer sentence model: v1-q4

**All-local proofreading.** This is the engine for [Proofer](https://github.com/JfowlerSIAI/proofer),
a Chrome and Brave extension that corrects completed English sentences while
you keep typing. All proofreading runs on your computer through Ollama, with
no cloud fallback. Proofer and this fine-tune were created by Jay Fowler.

This release is a **Q4_K_M** quantization of Proofer's **v1 LoRA fine-tune** of
[Liquid AI's LFM2.5-2.6B](https://huggingface.co/LiquidAI/LFM2.5-2.6B).
The model download is about **1.7 GB**.

## Use with Proofer

> [!WARNING]
> **A GPU is a practical requirement for meaningfully fast proofreading.**
> CPU-only proofreading can be slow. **The Proofer extension keeps corrections
> disabled until your computer passes its setup speed check.**
>
> **Windows and macOS have had very little usability work.** Proofer development
> and validation have focused on Linux; Windows/macOS installer flows have not
> been validated for this release.

Follow [Proofer's installation instructions](https://github.com/JfowlerSIAI/proofer#install-from-this-repository).
Setup downloads this engine, verifies it, and checks your computer's speed
before live proofreading can be enabled.

If you already have Ollama installed, you can pull this model tag with:

```bash
ollama pull jayafowler/proofer:v1-q4
```

Then complete the extension's setup and click **Turn on** after its speed
check passes.

## How the model is used

Proofer sends each completed sentence with preceding text for context to
Ollama running on your own computer. There is no cloud fallback. The
extension supplies the prompt, JSON response format, and output guards,
then rechecks the text, cursor, timing, and editor compatibility before
applying a correction.

A plain `ollama run jayafowler/proofer:v1-q4` session does not include that
pipeline. Use the [shipping application code](https://github.com/JfowlerSIAI/proofer/blob/main/background.js)
when evaluating Proofer's proofreading behavior.

The intended use is English sentence proofreading through Proofer. The model
can miss errors, make incorrect corrections, or change meaning. Review
important text before sending it. See the
[model details](https://github.com/JfowlerSIAI/proofer/blob/main/docs/model.md)
for scope, limitations, and training reproducibility, and the
[privacy policy](https://github.com/JfowlerSIAI/proofer/blob/main/docs/privacy-policy.md)
for local writing logs and controls.

## License and attribution

- **Model:** [LFM Open License v1.0](https://huggingface.co/LiquidAI/LFM2.5-2.6B/blob/main/LICENSE),
  including its commercial-use conditions. The
  [release Modelfile](https://github.com/JfowlerSIAI/proofer/blob/main/docs/Modelfile.proofer-v1-q4)
  records the license and Jay Fowler's modification notice.
- **Extension:** Proofer's original source code and documentation use the
  [Apache License 2.0](https://github.com/JfowlerSIAI/proofer/blob/main/LICENSE).
  That license does not relicense this model or other third-party material.
