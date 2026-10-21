#!/usr/bin/env python3
"""Bounded Spark-X2.5 v2 pilot; existing audited Transformers 4 environment.

No downloads or package installation. Requires a reviewed, pinned local snapshot.
CPU-only --preflight checks tensors, template, data boundaries, and base inference.
--smoke runs six optimizer steps and verifies the saved merged artifact.
Normal training uses the original dedup-cluster split and a two-epoch ceiling.
GGUF export and serving verification are separate gates, before a full pilot.
"""
import argparse
import gc
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import time

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / 'test/harvested/finetune/pilot-dataset.jsonl'
FROZEN = ROOT / 'test/harvested/finetune/benchmark-frozen-v1.jsonl'
DATA_SHA = '418b5b460b50e4e2c9e7e7e8a1ac1c1370535a4c235711f83180d3d9ab53e90d'
REVISIONS = {
    '14d6e83c13c7add2b62a7c39b2131f4ed1cddcf8': ('1.7B', 28),
    '0bcb35678590218655dff3765b9e61c83b35e9c4': ('4B', 36),
}
TARGETS = ['q_k_v_proj', 'g_proj', 'out_proj', 'gate_proj', 'up_proj', 'down_proj']
SYSTEM = 'Proofread. Reply {"rewritten": "..."} with the corrected sentence, or the input verbatim if clean.'
PROBES = ['The techncian arrived early.', 'we recieved the invocie.', 'The meeting starts at noon.']


def messages(context, sentence, target=None):
    system = SYSTEM + ('\n\nprior_context: ' + json.dumps(str(context), ensure_ascii=False) if context else '')
    result = [{'role': 'system', 'content': system}, {'role': 'user', 'content': sentence}]
    if target is not None:
        result.append({'role': 'assistant', 'content': json.dumps({'rewritten': target}, ensure_ascii=False)})
    return result


def dump(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--base', type=Path, required=True)
    ap.add_argument('--out', type=Path, required=True)
    ap.add_argument('--preflight', action='store_true')
    ap.add_argument('--smoke', action='store_true')
    ap.add_argument('--cpu-smoke', action='store_true', help='run the six-step smoke without occupying the GPU')
    args = ap.parse_args()
    if args.cpu_smoke:
        args.smoke = True
    os.umask(0o077)
    args.out.mkdir(parents=True, exist_ok=False)
    import torch
    import transformers
    from transformers import AutoTokenizer, AutoModelForCausalLM, set_seed
    from safetensors import safe_open
    manifest = json.loads((args.base.parent / 'source-manifest.json').read_text())
    revision = manifest['revision']
    assert revision in REVISIONS, 'Requires a reviewed, pinned Spark snapshot'
    model_size, layer_count = REVISIONS[revision]
    config = json.loads((args.base / 'config.json').read_text())
    assert config['num_hidden_layers'] == layer_count and config['model_type'] == 'spark2_5'
    for name, expected in manifest['files'].items():
        h = hashlib.sha256()
        with (args.base / name).open('rb') as f:
            for block in iter(lambda: f.read(1 << 20), b''):
                h.update(block)
        assert h.hexdigest() == expected['sha256'], name
    assert transformers.__version__ == '4.57.6'
    torch.set_num_threads(8)
    set_seed(3407)
    assert hashlib.sha256(DATA.read_bytes()).hexdigest() == DATA_SHA
    rows = [json.loads(l) for l in DATA.read_text().splitlines()]
    benchmark = [json.loads(l) for l in FROZEN.read_text().splitlines()]
    assert len(rows) == 7192
    for key in ['source_document_id', 'exclusion_group_id']:
        assert not ({r['lineage'][key] for r in rows} & {r['source'][key] for r in benchmark})
    clusters = [{r['card']['dedup_cluster'] for r in rows if r['card']['split'] == s}
                for s in ['train', 'validation']]
    assert not clusters[0] & clusters[1]
    # Verify the actual shard contents, not just the safetensors index.
    index = json.loads((args.base / 'model.safetensors.index.json').read_text())['weight_map']
    actual = {}
    for shard in set(index.values()):
        with safe_open(args.base / shard, framework='pt') as f:
            for k in f.keys():
                assert k not in actual
                actual[k] = shard
    assert actual == index
    tok = AutoTokenizer.from_pretrained(args.base, local_files_only=True)
    def render(msgs, generation=False):
        return tok.apply_chat_template(msgs, tokenize=True, add_generation_prompt=generation, enable_thinking=False)
    train, val, dropped = [], [], {'train': 0, 'validation': 0}
    split_uids = {'train': [], 'validation': []}
    for r in rows:
        msgs = messages(r['context'], r['input'], r['target'])
        full, pre = render(msgs), render(msgs[:-1], True)
        assert full[:len(pre)] == pre and len(full) > len(pre)
        assert tok.decode(pre).endswith('</think>')
        assert '<think>' not in tok.decode(full[len(pre):])
        split = r['card']['split']
        if len(full) > 1024:
            dropped[split] += 1
            continue
        (train if split == 'train' else val).append({'input_ids': full, 'labels': [-100] * len(pre) + full[len(pre):]})
        split_uids[split].append(r['uid'])
    assert len(train) >= 0.95 * 6199 and len(val) >= 0.95 * 993
    facts = dict(revision=revision, model_size=model_size, dataset_sha256=DATA_SHA, train=len(train), validation=len(val),
                 dropped=dropped, targets=TARGETS, seed=3407, r=32, alpha=32, learning_rate=2e-4,
                 max_epochs=2, effective_batch=16, torch=torch.__version__, transformers=transformers.__version__)
    dump(args.out / 'inputs.json', facts)
    dump(args.out / 'split-uids.json', split_uids)
    print(json.dumps(facts), flush=True)
    device = 'cpu' if args.preflight or args.cpu_smoke else 'cuda:0'
    if device != 'cpu':
        assert torch.cuda.is_available()
        free, _ = torch.cuda.mem_get_info()
        assert free >= 18 * 2**30, f'GPU busy: only {free / 2**30:.1f} GiB free'
    def load(base, dtype, device):
        m, info = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=True,
            dtype=dtype, device_map=device, attn_implementation='eager', output_loading_info=True)
        assert not info['missing_keys'] and not info['unexpected_keys'] and not info['mismatched_keys'], info
        m.config.use_cache = False
        return m
    model = load(args.base, torch.float32 if args.cpu_smoke else torch.bfloat16, device).eval()
    def generate(m):
        result = []
        for s in PROBES:
            t = torch.tensor([render(messages('', s), True)], device=m.device)
            with torch.no_grad():
                ids = m.generate(t, attention_mask=torch.ones_like(t), do_sample=False,
                    max_new_tokens=48, use_cache=True, pad_token_id=tok.pad_token_id)
            result.append(tok.decode(ids[0, t.shape[1]:], skip_special_tokens=True))
        return result
    base_text = generate(model)
    dump(args.out / 'base-probes.json', dict(zip(PROBES, base_text)))
    assert all(isinstance(json.loads(s).get('rewritten'), str) for s in base_text), base_text
    if args.preflight:
        print('CPU preflight passed: data, template, tensor index, base inference', flush=True)
        return
    from peft import LoraConfig, get_peft_model, PeftModel
    from transformers import Trainer, TrainingArguments, EarlyStoppingCallback
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={'use_reentrant': False})
    model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=32, lora_alpha=32, lora_dropout=0.0, bias='none',
            target_modules=TARGETS, task_type='CAUSAL_LM'))
    hits = {t: sum(1 for n, _ in model.named_parameters() if f'.{t}.lora_A.' in n) for t in TARGETS}
    assert all(v == layer_count for v in hits.values()), hits
    facts['lora_parameters'] = sum(p.numel() for p in model.parameters() if p.requires_grad)
    dump(args.out / 'inputs.json', facts)
    if args.smoke:
        train, val = train[:64], val[:16]
    class Collate:
        def __call__(self, feats):
            n = max(len(f['input_ids']) for f in feats)
            return {k: torch.tensor([f[k] + [pad] * (n - len(f[k])) for f in feats])
                    for k, pad in [('input_ids', tok.pad_token_id), ('labels', -100)]} | {
                'attention_mask': torch.tensor([[1] * len(f['input_ids']) + [0] * (n - len(f['input_ids'])) for f in feats])}
    collate = Collate()
    def loss(m, examples):
        total, count = 0., 0
        for i in range(0, len(examples), 2):
            b = {k: v.to(m.device) for k, v in collate(examples[i:i+2]).items()}
            n = (b['labels'][:, 1:] != -100).sum().item()
            with torch.no_grad():
                total += float(m(**b, use_cache=False).loss) * n
            count += n
        return total / count
    eval_steps = 2 if args.smoke else max(1, math.ceil(len(train) / 16) // 4)
    ta = TrainingArguments(output_dir=str(args.out / 'checkpoints'), per_device_train_batch_size=2,
        per_device_eval_batch_size=2, gradient_accumulation_steps=8, num_train_epochs=2,
        max_steps=6 if args.smoke else -1, learning_rate=2e-4, lr_scheduler_type='linear',
        warmup_ratio=0.03, logging_steps=2 if args.smoke else 25, eval_strategy='steps',
        eval_steps=eval_steps, save_strategy='steps', save_steps=eval_steps, save_total_limit=2,
        bf16=not args.cpu_smoke, optim='adamw_torch', seed=3407, data_seed=3407, report_to=[],
        gradient_checkpointing=True, gradient_checkpointing_kwargs={'use_reentrant': False},
        load_best_model_at_end=True, metric_for_best_model='eval_loss', greater_is_better=False,
        remove_unused_columns=False, disable_tqdm=True, use_cpu=args.cpu_smoke)
    trainer = Trainer(model=model, args=ta, train_dataset=train, eval_dataset=val, data_collator=collate,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=2)])
    start = time.time()
    result = trainer.train()
    assert math.isfinite(result.training_loss) and result.training_loss > 0
    dump(args.out / 'training.json', {'seconds': time.time()-start,
        'peak_cuda_allocated_bytes': torch.cuda.max_memory_allocated() if device != 'cpu' else None,
        'metrics': result.metrics,
        'best_checkpoint': trainer.state.best_model_checkpoint, 'history': trainer.state.log_history})
    model.eval()
    model.gradient_checkpointing_disable()
    adir = args.out / 'adapter'
    model.save_pretrained(adir); tok.save_pretrained(adir)
    assert all(torch.count_nonzero(p) for n, p in model.named_parameters() if '.lora_B.' in n)
    fidelity_rows = val[:16]
    tuned_loss, tuned_text = loss(model, fidelity_rows), generate(model)
    with model.disable_adapter():
        off_loss = loss(model, fidelity_rows)
    del model, trainer
    gc.collect(); torch.cuda.empty_cache()
    # FP32 CPU merge avoids rounding the low-rank update before export.
    base32 = load(args.base, torch.float32, 'cpu')
    adapted32 = PeftModel.from_pretrained(base32, adir).eval()
    on32 = loss(adapted32, fidelity_rows)
    with adapted32.disable_adapter():
        off32 = loss(adapted32, fidelity_rows)
    merged = adapted32.merge_and_unload()
    merged32_loss = loss(merged, fidelity_rows)
    delta32 = abs(on32 - merged32_loss)
    fp32_fidelity = dict(adapter_on_loss=on32, adapter_off_loss=off32,
        merged_loss=merged32_loss, merged_loss_delta=delta32)
    dump(args.out / 'fp32-merge-fidelity.json', fp32_fidelity)
    assert delta32 < 1e-5, fp32_fidelity
    assert abs(off32 - on32) > 10 * max(delta32, 1e-6), fp32_fidelity
    mdir = args.out / 'merged32'
    merged.save_pretrained(mdir, safe_serialization=True); tok.save_pretrained(mdir)
    for name in ['configuration_spark.py', 'modeling_spark.py', 'chat_template.jinja']:
        shutil.copy2(args.base / name, mdir / name)
    del merged, base32, adapted32
    gc.collect()
    merged = load(mdir, torch.bfloat16, device).eval()
    merged_loss, merged_text = loss(merged, fidelity_rows), generate(merged)
    delta = abs(merged_loss - tuned_loss)
    fidelity = dict(adapter_on_loss=tuned_loss, adapter_off_loss=off_loss, merged_loss=merged_loss,
        merged_loss_delta=delta, adapter_text=tuned_text, merged_text=merged_text,
        greedy_matches=sum(a == b for a, b in zip(tuned_text, merged_text)))
    dump(args.out / 'merge-fidelity.json', fidelity)
    assert delta < 0.05, fidelity
    # A BF16 merged weight and a separately evaluated LoRA update round at
    # different points. The FP32 gate above isolates merge correctness from
    # that rounding, with an adapter-disabled negative control.
    assert all(isinstance(json.loads(s).get('rewritten'), str) for s in merged_text)
    print('Training and merge fidelity passed; GGUF export/inference gate remains.', flush=True)


if __name__ == '__main__':
    main()
