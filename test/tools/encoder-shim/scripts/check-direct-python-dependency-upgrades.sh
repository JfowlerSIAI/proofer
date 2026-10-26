#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/check-direct-python-dependency-upgrades.sh [--allow-recent-package PACKAGE]...

Check pinned direct dependencies in requirements.in against the latest eligible
PyPI releases. This script does not modify any files.

Options:
  --allow-recent-package PACKAGE
                  Keep the 10-day quarantine globally, but allow one named
                  direct dependency to use versions older than 1 day. Repeat
                  this flag to allow multiple direct dependencies in one run.
  -h, --help      Show this help.
EOF
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

allow_recent_packages=()

while (($# > 0)); do
  case "$1" in
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

for command_name in python3; do
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

python_args=("$repo_root/requirements.in")
if ((${#allow_recent_packages[@]})); then
  python_args=("${allow_recent_packages[@]}" "${python_args[@]}")
fi

python3 - "${python_args[@]}" <<'PY'
import json
import re
import shlex
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

try:
    from packaging.specifiers import InvalidSpecifier, SpecifierSet
    from packaging.utils import (
        InvalidSdistFilename,
        InvalidWheelFilename,
        canonicalize_name,
        parse_sdist_filename,
        parse_wheel_filename,
    )
    from packaging.version import InvalidVersion, Version
except ModuleNotFoundError:
    try:
        from pip._vendor.packaging.specifiers import InvalidSpecifier, SpecifierSet
        from pip._vendor.packaging.utils import (
            InvalidSdistFilename,
            InvalidWheelFilename,
            canonicalize_name,
            parse_sdist_filename,
            parse_wheel_filename,
        )
        from pip._vendor.packaging.version import InvalidVersion, Version
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "This script requires the Python packaging module. "
            "Install packaging or use a Python environment that bundles it."
        ) from exc


USER_AGENT = "python-direct-upgrade-checker"
PYTHON_VERSION = "3.12"
SIMPLE_API_ACCEPT = "application/vnd.pypi.simple.v1+json"
REQUIREMENT_RE = re.compile(
    r"^(?P<indent>\s*)"
    r"(?P<requirement>[A-Za-z0-9][A-Za-z0-9_.-]*(?:\[[A-Za-z0-9_.\-,]+\])?)"
    r"\s*==\s*"
    r"(?P<version>[^\s;#]+)"
    r"(?P<tail>\s*(?:;[^#\r\n]*)?)"
    r"(?P<comment>\s*(?:#.*)?)"
    r"(?P<newline>\r?\n?)$"
)


def parse_timestamp(raw: str) -> datetime:
    return datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(timezone.utc)


def request_json(url: str, accept: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"PyPI request failed for {url}: HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise SystemExit(f"PyPI request failed for {url}: {exc.reason}") from exc


def file_version(filename: str) -> Optional[Version]:
    try:
        if filename.endswith(".whl"):
            _, version, _, _ = parse_wheel_filename(filename)
            return version
        _, version = parse_sdist_filename(filename)
        return version
    except (InvalidSdistFilename, InvalidWheelFilename):
        return None


def supports_python_312(requires_python: Optional[str]) -> bool:
    if not requires_python:
        return True
    try:
        return SpecifierSet(requires_python).contains(PYTHON_VERSION, prereleases=True)
    except InvalidSpecifier:
        return False


def latest_eligible_release(project_name: str, cutoff: datetime) -> tuple[str, str]:
    project_url = (
        "https://pypi.org/simple/"
        + urllib.parse.quote(project_name, safe="")
        + "/"
    )
    data = request_json(project_url, SIMPLE_API_ACCEPT)
    files_by_version: dict[Version, list[dict]] = defaultdict(list)

    for file_info in data.get("files", []):
        version = file_version(file_info.get("filename", ""))
        if version is None:
            continue
        files_by_version[version].append(file_info)

    candidates: list[tuple[Version, datetime]] = []
    for version, files in files_by_version.items():
        if version.is_prerelease or version.is_devrelease:
            continue

        non_yanked = [file_info for file_info in files if not file_info.get("yanked", False)]
        if not non_yanked:
            continue

        if not any(supports_python_312(file_info.get("requires-python")) for file_info in non_yanked):
            continue

        upload_times = [
            parse_timestamp(file_info["upload-time"])
            for file_info in non_yanked
            if file_info.get("upload-time")
        ]
        if not upload_times:
            continue

        release_time = max(upload_times)
        if release_time >= cutoff:
            continue

        candidates.append((version, release_time))

    if not candidates:
        raise SystemExit(
            f"No eligible stable non-yanked Python {PYTHON_VERSION}-compatible release found for {project_name}"
        )

    selected_version, selected_time = max(candidates, key=lambda item: item[0])
    return str(selected_version), selected_time.date().isoformat()


def likely_breaking_change(current_version: str, target_version: str) -> bool:
    try:
        current = Version(current_version)
        target = Version(target_version)
    except InvalidVersion:
        return False

    if current == target:
        return False

    current_release = current.release
    target_release = target.release

    current_major = current_release[0]
    target_major = target_release[0]
    current_minor = current_release[1] if len(current_release) > 1 else 0
    target_minor = target_release[1] if len(target_release) > 1 else 0

    if current_major != target_major:
        return True

    # For pre-1.0 packages, minor bumps often contain breaking changes.
    if current_major == 0 and current_minor != target_minor:
        return True

    return False


def main() -> int:
    args = sys.argv[1:]
    requirements_path = args[-1]
    allow_recent_packages = args[:-1]
    global_cutoff = datetime.now(timezone.utc) - timedelta(days=10)
    package_cutoff = datetime.now(timezone.utc) - timedelta(days=1)
    allow_recent_by_canonical = {
        canonicalize_name(package_name): package_name
        for package_name in allow_recent_packages
    }

    with open(requirements_path, "r", encoding="utf-8") as handle:
        lines = handle.readlines()

    candidates: list[str] = []
    warnings: list[str] = []
    seen_projects: dict[str, tuple[str, str]] = {}
    matched_allow_recent_packages: set[str] = set()

    for line_number, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        match = REQUIREMENT_RE.match(line)
        if not match:
            raise SystemExit(
                f"Unsupported requirements.in entry on line {line_number}: {line.rstrip()}"
            )

        requirement = match.group("requirement")
        current_version = match.group("version")
        project_name = requirement.split("[", 1)[0]
        project_canonical = canonicalize_name(project_name)

        cutoff = global_cutoff
        if project_canonical in allow_recent_by_canonical:
            cutoff = package_cutoff
            matched_allow_recent_packages.add(project_canonical)

        if project_name not in seen_projects:
            seen_projects[project_name] = latest_eligible_release(project_name, cutoff)

        target_version, release_date = seen_projects[project_name]
        if current_version == target_version:
            continue

        line_text = f"{requirement} {current_version} -> {target_version} ({release_date})"
        candidates.append(line_text)
        if likely_breaking_change(current_version, target_version):
            warnings.append(line_text)

    if candidates:
        print("Direct dependency upgrade candidates:")
        for item in candidates:
            print(f"  {item}")
        if warnings:
            print()
            print("Possible breaking changes detected:")
            for item in warnings:
                print(f"  {item}")
            print("Do not apply these upgrades without first reviewing upstream release notes or migration guides.")
            print("If in doubt, skip the major bump and only apply minor/patch upgrades.")
    else:
        print("requirements.in already matches the latest eligible direct dependency versions")

    unmatched_allow_recent_packages = [
        allow_recent_by_canonical[project_canonical]
        for project_canonical in allow_recent_by_canonical
        if project_canonical not in matched_allow_recent_packages
    ]
    if unmatched_allow_recent_packages:
        package_list = ", ".join(unmatched_allow_recent_packages)
        raise SystemExit(
            "--allow-recent-package did not match any direct dependency in "
            f"requirements.in: {package_list}"
        )

    print()
    print("No files were changed.")
    if candidates:
        print("Review the proposed changes, update requirements.in manually, then run ./scripts/generate-requirements-txt.sh --upgrade.")
        if allow_recent_packages:
            allow_recent_flags = " ".join(
                f"--allow-recent-package {shlex.quote(package_name)}"
                for package_name in allow_recent_packages
            )
            package_label = "that package" if len(allow_recent_packages) == 1 else "those packages"
            print(
                f"If you approve recent fixes for {package_label}, rerun generate with "
                f"--upgrade {allow_recent_flags}."
            )

    return 0


raise SystemExit(main())
PY
