#!/usr/bin/env python3
"""Generate the public OAuth client config and invalidate its browser cache.

Run from the repo's root. The client ID is public; don't put secrets here.
"""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path


def sync(root: Path, client_id: str) -> str:
    client_id = client_id.strip()
    if not re.fullmatch(r"[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com", client_id):
        raise ValueError("Repository Variable GOOGLE_OAUTH_CLIENT_ID must contain a nonempty Web OAuth client ID.")

    index_path = root / "index.html"
    index = index_path.read_text(encoding="utf-8")
    fingerprint = hashlib.sha256(client_id.encode("utf-8")).hexdigest()[:12]
    # Keep the semantic app version (v=...), append a stable ID-specific cache key.
    pattern = r'(<script src="google-config\.js\?v=[^"&]+)(?:&(?:amp;)?id=[0-9a-f]{12})?(" defer></script>)'
    changed, count = re.subn(
        pattern, lambda match: match.group(1) + "&amp;id=" + fingerprint + match.group(2),
        index,
    )
    if count != 1:
        raise ValueError("Cannot find exactly one versioned google-config.js script in index.html.")

    config = (
        "/* Generated from the GitHub Repository Variable GOOGLE_OAUTH_CLIENT_ID. OAuth client IDs are public. */\n"
        + "globalThis.MINKOME_GOOGLE_OAUTH_CLIENT_ID="
        + json.dumps(client_id, ensure_ascii=False)
        + ";\n"
    )
    (root / "google-config.js").write_text(config, encoding="utf-8")
    if changed != index:
        index_path.write_text(changed, encoding="utf-8")
    return fingerprint


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    try:
        key = sync(args.root, os.environ.get("GOOGLE_OAUTH_CLIENT_ID", ""))
        print("Google OAuth config generated; index.html cache key updated (" + key + ").")
    except (ValueError, OSError) as exc:
        parser.exit(1, "Google OAuth config sync failed: " + str(exc) + "\n")
