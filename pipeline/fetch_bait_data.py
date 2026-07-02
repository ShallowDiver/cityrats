#!/usr/bin/env python3
"""Fetch NYC rodenticide bait application records and aggregate them for the map.

Pulls every "Bait applied" treatment record from the DOHMH Rodent Inspection
dataset on NYC Open Data, bins the points into a lat/lng grid (3 decimal
places, roughly 110m x 85m at NYC's latitude), and writes a compact JSON file
with per-year counts per cell plus citywide and per-borough totals.

Usage:
    python3 pipeline/fetch_bait_data.py

No third-party dependencies. Output goes to web/data/bait_grid.json.
"""

import datetime
import json
from collections import defaultdict
from pathlib import Path

from socrata import fetch_all

ENDPOINT = "https://data.cityofnewyork.us/resource/p937-wjvj.json"
MIN_YEAR = 2010

# Generous bounding box around the five boroughs. The dataset stores missing
# coordinates as 0.0, and a handful of records geocode outside the city.
LAT_MIN, LAT_MAX = 40.4, 41.0
LNG_MIN, LNG_MAX = -74.3, -73.6

GRID_DECIMALS = 3

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "web" / "data" / "bait_grid.json"


def main():
    max_year = datetime.date.today().year
    years = list(range(MIN_YEAR, max_year + 1))
    year_index = {y: i for i, y in enumerate(years)}
    n_years = len(years)

    cells = defaultdict(lambda: [0] * n_years)
    boroughs = defaultdict(lambda: [0] * n_years)
    total = 0
    skipped = 0

    rows = fetch_all(
        ENDPOINT,
        select="latitude,longitude,inspection_date,borough",
        where=(
            "result='Bait applied' "
            f"AND latitude between {LAT_MIN} and {LAT_MAX} "
            f"AND longitude between {LNG_MIN} and {LNG_MAX}"
        ),
    )
    for row in rows:
        try:
            lat = float(row["latitude"])
            lng = float(row["longitude"])
            year = int(row["inspection_date"][:4])
        except (KeyError, ValueError):
            skipped += 1
            continue
        if year not in year_index:
            skipped += 1
            continue
        yi = year_index[year]
        key = (round(lat, GRID_DECIMALS), round(lng, GRID_DECIMALS))
        cells[key][yi] += 1
        boroughs[row.get("borough", "Unknown")][yi] += 1
        total += 1

    cell_list = [
        [lat, lng, counts] for (lat, lng), counts in sorted(cells.items())
    ]

    out = {
        "generated": datetime.date.today().isoformat(),
        "source": "NYC Open Data, DOHMH Rodent Inspection (p937-wjvj), result='Bait applied'",
        "grid_decimals": GRID_DECIMALS,
        "years": years,
        "total_records": total,
        "boroughs": dict(sorted(boroughs.items())),
        "cells": cell_list,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    size_mb = OUTPUT_PATH.stat().st_size / 1e6
    print(
        f"wrote {OUTPUT_PATH} ({size_mb:.1f} MB): "
        f"{total} records in {len(cell_list)} cells, {skipped} skipped"
    )


if __name__ == "__main__":
    main()
