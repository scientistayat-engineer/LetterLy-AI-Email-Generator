"""Turns a Firebase service account JSON file into one safe line for an environment variable.

Usage:  python tools/encode_firebase_key.py path/to/your-service-account.json

Paste the printed line into Vercel as FIREBASE_SERVICE_ACCOUNT_B64 (and into .env if you
want to test Firestore locally). Never commit the JSON file or this output to GitHub.
"""

import base64
import json
import sys
from pathlib import Path

REQUIRED = ("project_id", "client_email", "private_key")


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 1
    path = Path(sys.argv[1])
    try:
        info = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"Could not read {path}: {exc}")
        return 1
    missing = [key for key in REQUIRED if key not in info]
    if missing:
        print(f"This does not look like a service account key. Missing: {', '.join(missing)}")
        return 1
    encoded = base64.b64encode(json.dumps(info).encode("utf-8")).decode("ascii")
    print(f"Project: {info['project_id']}")
    print("Copy the line below into FIREBASE_SERVICE_ACCOUNT_B64:\n")
    print(encoded)
    return 0


if __name__ == "__main__":
    sys.exit(main())
