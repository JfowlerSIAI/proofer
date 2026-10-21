// EXPERIMENT, NOT A GATE. Where the prompt-cache study reads and writes.
//
// One place, so the run-*.sh scripts and every Node script agree: both honour
// the RAW environment variable (the private raw-data directory) and
// FINETUNE_ART (the frozen-benchmark artifacts). Each script's --raw / --art
// flag, where it has one, overrides these.

import { fileURLToPath } from "node:url";

export const RAW = process.env.RAW
  || fileURLToPath(new URL("../harvested/cache-study", import.meta.url));
export const FT = process.env.FINETUNE_ART
  || fileURLToPath(new URL("../harvested/finetune", import.meta.url));
