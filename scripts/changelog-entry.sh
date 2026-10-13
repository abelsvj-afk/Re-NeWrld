#!/bin/sh
# Appends an entry to CHANGELOG.md under ## [Unreleased].
#
# Usage: scripts/changelog-entry.sh <Section> "<entry text>"
#   Section (case-insensitive): Added | Changed | Deprecated | Removed | Fixed | Security
#
# The entry is inserted as a bullet under the matching ### <Section> header
# inside the ## [Unreleased] block, creating the section in canonical
# Keep-a-Changelog order if it does not exist yet. Re-running with the same
# text is a no-op (no duplicate bullets).
#
# Agents: run this after completing a task (see AGENTS.md) so the changelog
# never falls behind again.
set -e

SECTION="$1"
TEXT="$2"
CHANGELOG="$(git rev-parse --show-toplevel)/CHANGELOG.md"

if [ -z "$SECTION" ] || [ -z "$TEXT" ]; then
  echo "Usage: $0 <Section> \"<entry text>\"" >&2
  echo "Section: Added | Changed | Deprecated | Removed | Fixed | Security" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "changelog-entry.sh requires python3" >&2
  exit 1
fi

if [ ! -f "$CHANGELOG" ]; then
  echo "CHANGELOG.md not found at $CHANGELOG" >&2
  exit 1
fi

python3 - "$CHANGELOG" "$SECTION" "$TEXT" << 'PYEOF'
import re
import sys

path, section_raw, text = sys.argv[1], sys.argv[2], sys.argv[3]

CANONICAL = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]
section = next((c for c in CANONICAL if c.lower() == section_raw.lower()), None)
if section is None:
    sys.exit(f"Unknown section '{section_raw}'. Use one of: {', '.join(CANONICAL)}")

with open(path, "r", encoding="utf-8") as f:
    lines = f.readlines()

# Locate the ## [Unreleased] block (up to the next ## header or EOF).
start = next((i for i, l in enumerate(lines) if re.match(r"^## \[Unreleased\]\s*$", l)), None)
if start is None:
    sys.exit("No '## [Unreleased]' section found in CHANGELOG.md")
end = next(
    (i for i in range(start + 1, len(lines)) if re.match(r"^## \s", lines[i])),
    len(lines),
)
block = lines[start:end]

bullet = f"- {text.strip()}\n"
if any(l.rstrip("\n") == bullet.rstrip("\n") for l in block):
    print("Entry already present; nothing to do.")
    sys.exit(0)

header = f"### {section}\n"
try:
    idx = next(i for i, l in enumerate(block) if l.rstrip("\n") == header.rstrip("\n"))
    # Append after the last bullet of this section (or right after the header).
    insert_at = idx + 1
    j = idx + 1
    while j < len(block) and block[j].startswith("- "):
        insert_at = j + 1
        j += 1
    # Preserve a blank line between the new bullet and a following header.
    if insert_at < len(block) and block[insert_at].startswith("###"):
        block.insert(insert_at, "\n")
        insert_at += 1
    block.insert(insert_at, bullet)
except StopIteration:
    # Create the section in canonical order relative to existing sections.
    existing = [
        (i, l) for i, l in enumerate(block) if re.match(r"^### (Added|Changed|Deprecated|Removed|Fixed|Security)\s*$", l)
    ]
    pos = CANONICAL.index(section)
    insert_at = len(block)
    for i, l in existing:
        if CANONICAL.index(l.strip()[4:]) > pos:
            insert_at = i
            break
    new_lines = [header, bullet]
    # Keep blank lines tidy around the inserted section.
    if insert_at > 0 and block[insert_at - 1].strip() != "":
        new_lines.insert(0, "\n")
    if insert_at < len(block) and block[insert_at].strip() != "":
        new_lines.append("\n")
    block[insert_at:insert_at] = new_lines

lines[start:end] = block
with open(path, "w", encoding="utf-8") as f:
    f.writelines(lines)
print(f"Added entry under '### {section}'.")
PYEOF
