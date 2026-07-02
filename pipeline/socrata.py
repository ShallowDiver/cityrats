"""Small helper for paging through Socrata (NYC Open Data) datasets."""

import json
import sys
import time
import urllib.parse
import urllib.request

PAGE_SIZE = 50000


def fetch(endpoint, params):
    """Fetch one request with retries and return parsed JSON."""
    url = endpoint + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.load(resp)
        except Exception as exc:  # noqa: BLE001
            if attempt == 3:
                raise
            wait = 2 ** (attempt + 1)
            print(f"  request failed ({exc}), retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    return []


def fetch_all(endpoint, select, where, page_size=PAGE_SIZE):
    """Yield every row matching the query, paging by :id order."""
    offset = 0
    while True:
        print(f"fetching rows {offset} to {offset + page_size}...")
        rows = fetch(endpoint, {
            "$select": select,
            "$where": where,
            "$order": ":id",
            "$limit": page_size,
            "$offset": offset,
        })
        yield from rows
        if len(rows) < page_size:
            break
        offset += page_size
