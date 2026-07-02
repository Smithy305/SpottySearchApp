#!/usr/bin/env python3
"""
test_square.py — quick check that the Square API works for SpottySearch.

Lists *yesterday's* Square payments and prints the customer emails attached to
them. This mirrors what the `enrich-square` edge function does (payments ->
linked customer -> email_address / buyer_email_address), so it tests two things
at once:

  1. Does the access token actually work against the production API?
  2. Do real payments actually carry customer email addresses? (PLAN.md flags
     this as the big open question for Phase 3 — most contacts only exist when
     the customer chose a digital receipt.)

Standard library only — no pip install needed.

USAGE
-----
  export SQUARE_ACCESS_TOKEN="EAAA...your production token..."
  python3 test_square.py

Optional environment variables:
  SQUARE_LOCATION_ID   Restrict to one location (recommended for the real shop).
                       If unset, the script lists your locations and scans all
                       of them.
  SQUARE_BASE          API base URL. Defaults to production:
                         https://connect.squareup.com
                       For the Square sandbox use:
                         https://connect.squareupsandbox.com
  TIMEZONE             Timezone used to work out "yesterday".
                       Defaults to Europe/London.
  DAYS_AGO             Which day to pull. 1 = yesterday (default), 0 = today.

You can also drop the variables in a local `.env` file next to this script
(KEY=value per line) instead of exporting them. Keep that file out of git.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, time, timedelta

SQUARE_VERSION = "2024-10-17"  # matches enrich-square/index.ts


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_dotenv(path: str) -> None:
    """Minimal .env loader so a token can live in a file, not the shell."""
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            os.environ.setdefault(key, val)


def get_timezone(name: str):
    """Return a tzinfo for `name`, falling back to UTC if zoneinfo is missing."""
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        print(f"  (note: timezone '{name}' unavailable, using UTC instead)")
        from datetime import timezone
        return timezone.utc


# ---------------------------------------------------------------------------
# Square API helpers
# ---------------------------------------------------------------------------

class SquareError(Exception):
    pass


def square_get(base: str, token: str, path: str, params: dict | None = None) -> dict:
    """GET a Square endpoint and return parsed JSON, with friendly errors."""
    url = f"{base}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Square-Version": SQUARE_VERSION,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if e.code == 401:
            raise SquareError(
                "401 Unauthorized — the access token was rejected. Check that "
                "SQUARE_ACCESS_TOKEN is the *production* token from "
                "developer.squareup.com (and that SQUARE_BASE matches: "
                "production token + production base, sandbox token + sandbox base)."
            ) from None
        raise SquareError(f"HTTP {e.code} from {path}:\n{body}") from None
    except urllib.error.URLError as e:
        raise SquareError(f"Network error reaching Square: {e.reason}") from None


def list_location_ids(base: str, token: str) -> list[str]:
    data = square_get(base, token, "/v2/locations")
    locations = data.get("locations", [])
    for loc in locations:
        print(f"  location {loc.get('id')}  {loc.get('name', '')!r}")
    return [loc["id"] for loc in locations if loc.get("id")]


def list_payments(base: str, token: str, location_id: str | None,
                  begin: str, end: str) -> list[dict]:
    """Page through /v2/payments for the given time window."""
    payments: list[dict] = []
    cursor: str | None = None
    while True:
        params = {
            "begin_time": begin,
            "end_time": end,
            "sort_order": "ASC",
            "limit": 100,
        }
        if location_id:
            params["location_id"] = location_id
        if cursor:
            params["cursor"] = cursor
        data = square_get(base, token, "/v2/payments", params)
        payments.extend(data.get("payments", []))
        cursor = data.get("cursor")
        if not cursor:
            break
    return payments


def get_customer(base: str, token: str, customer_id: str) -> dict | None:
    try:
        data = square_get(base, token, f"/v2/customers/{customer_id}")
        return data.get("customer")
    except SquareError:
        # Customer record removed, or an "instant profile" with no details.
        return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

    token = os.environ.get("SQUARE_ACCESS_TOKEN")
    if not token:
        print("ERROR: SQUARE_ACCESS_TOKEN is not set.\n")
        print('  export SQUARE_ACCESS_TOKEN="EAAA...your token..."')
        print("  python3 test_square.py")
        print("\n(or put it in a .env file next to this script)")
        return 1

    base = os.environ.get("SQUARE_BASE", "https://connect.squareup.com").rstrip("/")
    tz = get_timezone(os.environ.get("TIMEZONE", "Europe/London"))
    days_ago = int(os.environ.get("DAYS_AGO", "1"))

    # Build the day window in the chosen timezone, then express as RFC3339.
    target_day = (datetime.now(tz) - timedelta(days=days_ago)).date()
    begin_dt = datetime.combine(target_day, time.min, tzinfo=tz)
    end_dt = datetime.combine(target_day, time.max, tzinfo=tz)
    begin, end = begin_dt.isoformat(), end_dt.isoformat()

    label = "yesterday" if days_ago == 1 else f"{days_ago} day(s) ago"
    print(f"Square API test — pulling customer emails for {label} "
          f"({target_day.isoformat()})")
    print(f"  base   : {base}")
    print(f"  window : {begin}  ->  {end}\n")

    # Which locations to scan.
    location_id = os.environ.get("SQUARE_LOCATION_ID")
    if location_id:
        location_ids: list[str | None] = [location_id]
        print(f"Scanning location: {location_id}\n")
    else:
        print("No SQUARE_LOCATION_ID set — listing locations and scanning all:")
        try:
            location_ids = list_location_ids(base, token) or [None]
        except SquareError as e:
            print(f"\nFAILED: {e}")
            return 2
        print()

    # Pull payments and resolve emails.
    rows: list[dict] = []
    payment_count = 0
    customer_cache: dict[str, dict | None] = {}

    try:
        for loc in location_ids:
            payments = list_payments(base, token, loc, begin, end)
            payment_count += len(payments)
            for p in payments:
                email = p.get("buyer_email_address")
                name = None
                phone = None
                cust_id = p.get("customer_id")
                if cust_id:
                    if cust_id not in customer_cache:
                        customer_cache[cust_id] = get_customer(base, token, cust_id)
                    cust = customer_cache[cust_id]
                    if cust:
                        name = " ".join(
                            x for x in (cust.get("given_name"),
                                        cust.get("family_name")) if x
                        ).strip() or None
                        email = email or cust.get("email_address")
                        phone = cust.get("phone_number")
                if email:
                    rows.append({
                        "name": name or "(no name)",
                        "email": email,
                        "phone": phone or "",
                        "time": p.get("created_at", ""),
                    })
    except SquareError as e:
        print(f"FAILED: {e}")
        return 2

    # Report.
    print("=" * 60)
    print(f"Payments found     : {payment_count}")
    print(f"Payments w/ email  : {len(rows)}")
    if payment_count:
        pct = 100 * len(rows) / payment_count
        print(f"Email coverage     : {pct:.0f}%")
    unique = sorted({r['email'].lower() for r in rows})
    print(f"Unique emails      : {len(unique)}")
    print("=" * 60)

    if rows:
        print()
        for r in sorted(rows, key=lambda x: x["time"]):
            stamp = r["time"][11:16] if len(r["time"]) >= 16 else r["time"]
            line = f"  {stamp}  {r['email']:<35}  {r['name']}"
            if r["phone"]:
                line += f"  {r['phone']}"
            print(line)
        print()
        print("Unique customer emails:")
        for e in unique:
            print(f"  {e}")
    else:
        print("\nNo emails found for that day. The token works if you got here "
              "without an error — but either there were no payments, or none of "
              "them carried an email (cash + paper receipt leaves nothing to "
              "attach). Try DAYS_AGO=<n> for a busier day to confirm.")

    print("\n✓ API call succeeded — token is valid.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
