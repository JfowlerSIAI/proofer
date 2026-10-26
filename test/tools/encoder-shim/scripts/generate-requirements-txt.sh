#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/generate-requirements-txt.sh [--upgrade] [--allow-recent-package PACKAGE]...

Compile requirements.txt from requirements.in, then audit the lockfile.

Options:
  --upgrade       Refresh transitive dependencies instead of preserving pins
                  from an existing requirements.txt.
  --allow-recent-package PACKAGE
                  Keep the 10-day quarantine globally, but allow one named
                  package to use versions older than 1 day. Repeat this flag
                  to allow multiple package-scoped CVE exceptions in one run.
  -h, --help      Show this help.
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

upgrade=0
allow_recent_packages=()

while (($# > 0)); do
  case "$1" in
    --upgrade)
      upgrade=1
      ;;
    --allow-recent-package)
      if (($# < 2)); then
        echo "Missing package name after --allow-recent-package" >&2
        usage >&2
        exit 2
      fi
      allow_recent_packages+=("$2")
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

for command_name in uv pip-audit python3; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 127
  fi
done

cd "$repo_root"

if [[ ! -f requirements.in ]]; then
  echo "requirements.in not found in $repo_root" >&2
  exit 1
fi

compile_cmd=(
  uv pip compile
  requirements.in
  -o requirements.txt
  --universal
  --generate-hashes
  --exclude-newer "10 days"
  --python-version 3.12
  # This optional encoder helper intentionally uses CPU Torch.
  --torch-backend cpu
)

if ((upgrade)); then
  compile_cmd+=(--upgrade)
fi

if ((${#allow_recent_packages[@]})); then
  for allow_recent_package in "${allow_recent_packages[@]}"; do
    compile_cmd+=(--exclude-newer-package "${allow_recent_package}=1 day")
  done
fi

printf 'Compiling requirements.txt with --exclude-newer %q\n' "10 days"
if ((${#allow_recent_packages[@]})); then
  for allow_recent_package in "${allow_recent_packages[@]}"; do
    printf 'Allowing package %q to use versions older than %q\n' "$allow_recent_package" "1 day"
  done
fi
"${compile_cmd[@]}"

echo "Auditing requirements.txt with pip-audit"
# The CPU wheels have +cpu versions absent from PyPI. Supply only Torch's
# official CPU wheel listing to pip-audit's hash-checked resolution, rather
# than adding an unrestricted second package index.
PIP_FIND_LINKS="https://download.pytorch.org/whl/cpu/torch/" pip-audit --require-hashes -r requirements.txt

# PyPI does not register +cpu distribution versions. The full hash-checked
# audit above therefore skips that wheel. Also query the corresponding Torch
# release advisories, without installing/resolving the regular (CUDA) wheel.
torch_audit="$(mktemp)"
trap 'rm -f "$torch_audit"' EXIT
python3 - requirements.txt "$torch_audit" <<'PY'
from pathlib import Path
import re
import sys
versions = set()
for line in Path(sys.argv[1]).read_text().splitlines():
    if line.startswith("torch=="):
        match = re.match(r"torch==([0-9]+\.[0-9]+\.[0-9]+)(?:\+cpu)?(?:\s|$)", line)
        if not match:
            raise SystemExit("Unrecognized Torch pin; cannot audit its base release")
        versions.add(match[1])
if len(versions) != 1:
    raise SystemExit("Expected one Torch base version in the CPU lockfile")
Path(sys.argv[2]).write_text("torch==" + versions.pop() + "\n")
PY
echo "Auditing the CPU wheel's corresponding Torch release (advisory metadata only)"
pip-audit --no-deps --disable-pip -r "$torch_audit"
