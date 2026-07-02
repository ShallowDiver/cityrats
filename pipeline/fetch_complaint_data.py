#!/usr/bin/env python3
"""Fetch 311 rat sighting complaints and aggregate them for the map.

Pulls every "Rat Sighting" complaint from the NYC 311 dataset (which covers
2020 to the present; the city archived earlier years out of this dataset)
and bins them into the same lat/lng grid the bait pipeline uses.

Also computes a complaint-propensity factor per grid cell: ALL 311
complaints of any type are aggregated onto the same grid server-side, and
each rat-complaint cell's baseline is the total inside a moving window
centered on it (a raw 100m cell is too noisy to divide by on its own).
Areas that call 311 about everything get factors below 1, areas that rarely
call get factors above 1, so the frontend can optionally show rat
complaints adjusted for how much an area uses 311 at all.

Usage:
    python3 pipeline/fetch_complaint_data.py

No third-party dependencies. Output goes to web/data/complaints_grid.json.
"""

import datetime
import json
import statistics
from collections import defaultdict
from pathlib import Path

from socrata import fetch, fetch_all

ENDPOINT = "https://data.cityofnewyork.us/resource/erm2-nwe9.json"

# Same axis as the bait data so the frontend can align the two without
# remapping; complaint counts before 2020 will simply be zero.
MIN_YEAR = 2010

LAT_MIN, LAT_MAX = 40.4, 41.0
LNG_MIN, LNG_MAX = -74.3, -73.6

GRID_DECIMALS = 3

# The propensity baseline sums all-type 311 counts over a square window of
# grid cells centered on each rat cell. Radius 2 means 5x5 cells, roughly
# 550m x 425m, about a quarter mile. Tunable: 1 is finer but noisier, 3
# smoother but blurrier.
WINDOW_RADIUS = 2

# Factors are clamped so sparse windows (water, parks, industrial land)
# cannot dominate.
FACTOR_MIN, FACTOR_MAX = 0.25, 4.0

BOROUGH_NAMES = {
    "MANHATTAN": "Manhattan",
    "BROOKLYN": "Brooklyn",
    "BRONX": "Bronx",
    "QUEENS": "Queens",
    "STATEN ISLAND": "Staten Island",
}

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "web" / "data" / "complaints_grid.json"


def grid_totals():
    """All-type 311 complaint counts per grid cell, aggregated server-side.

    Keys are integer milli-degrees, (round(lat*1000), round(lng*1000)), to
    keep the window lookups free of float drift.
    """
    totals = {}
    offset = 0
    page_size = 50000
    while True:
        print(f"fetching 311 grid totals, rows {offset} to {offset + page_size}...")
        rows = fetch(ENDPOINT, {
            "$select": (
                f"round(latitude, {GRID_DECIMALS}) as la,"
                f"round(longitude, {GRID_DECIMALS}) as lo,count(*) as c"
            ),
            "$where": (
                f"latitude between {LAT_MIN} and {LAT_MAX} "
                f"AND longitude between {LNG_MIN} and {LNG_MAX}"
            ),
            "$group": "la,lo",
            "$order": "la,lo",
            "$limit": page_size,
            "$offset": offset,
        })
        for row in rows:
            key = (round(float(row["la"]) * 1000), round(float(row["lo"]) * 1000))
            totals[key] = totals.get(key, 0) + int(row["c"])
        if len(rows) < page_size:
            break
        offset += page_size
    print(f"  {len(totals)} cells with 311 activity")
    return totals


def window_total(totals, ilat, ilng):
    """Sum of all-type 311 counts in the window centered on a cell."""
    t = 0
    for dlat in range(-WINDOW_RADIUS, WINDOW_RADIUS + 1):
        for dlng in range(-WINDOW_RADIUS, WINDOW_RADIUS + 1):
            t += totals.get((ilat + dlat, ilng + dlng), 0)
    return t


def main():
    totals = grid_totals()

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
        select="latitude,longitude,created_date,borough",
        where=(
            "complaint_type='Rodent' AND descriptor='Rat Sighting' "
            f"AND latitude between {LAT_MIN} and {LAT_MAX} "
            f"AND longitude between {LNG_MIN} and {LNG_MAX}"
        ),
    )
    for row in rows:
        try:
            lat = float(row["latitude"])
            lng = float(row["longitude"])
            year = int(row["created_date"][:4])
        except (KeyError, ValueError):
            skipped += 1
            continue
        if year not in year_index:
            skipped += 1
            continue
        yi = year_index[year]
        key = (round(lat, GRID_DECIMALS), round(lng, GRID_DECIMALS))
        cells[key][yi] += 1
        borough = BOROUGH_NAMES.get(row.get("borough", "").upper(), "Unknown")
        boroughs[borough][yi] += 1
        total += 1

    # The scaling constant is the median window total across rat cells, so
    # factors center near 1 and adjusted counts stay in a familiar range.
    window_totals = {
        (lat, lng): window_total(totals, round(lat * 1000), round(lng * 1000))
        for (lat, lng) in cells
    }
    median_window = statistics.median(window_totals.values())
    print(f"median window total: {median_window:.0f} complaints "
          f"({2 * WINDOW_RADIUS + 1}x{2 * WINDOW_RADIUS + 1} cells)")

    cell_list = []
    for (lat, lng), counts in sorted(cells.items()):
        wt = window_totals[(lat, lng)]
        adj = FACTOR_MAX if wt <= 0 else min(
            FACTOR_MAX, max(FACTOR_MIN, median_window / wt)
        )
        cell_list.append([lat, lng, counts, round(adj, 2)])

    out = {
        "generated": datetime.date.today().isoformat(),
        "source": "NYC Open Data, 311 Service Requests (erm2-nwe9), descriptor='Rat Sighting'",
        "note": (
            "311 dataset covers 2020 to present; earlier years are archived "
            "by the city. Each cell's adj factor divides by all-type 311 "
            f"activity in a {2 * WINDOW_RADIUS + 1}x{2 * WINDOW_RADIUS + 1} "
            "grid-cell window, scaled by the citywide median window."
        ),
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
