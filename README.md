# NYC Rodenticide Heat Map

A web app that maps where rat poison is most heavily applied across New York City, alongside where New Yorkers report rats.

Two signals are rendered as one blended heat map:

1. **Bait treatments.** The Department of Health and Mental Hygiene logs every rodent inspection it performs, including treatment visits where bait (rodenticide) was applied at a specific location.
2. **311 rat complaints.** Every "Rat Sighting" complaint filed through 311.

A mix slider sets the relative importance of the two signals. Each signal has an optional recency decay (records lose half their weight every chosen half life, adjustable from one month to ten years), and the complaints signal has an optional correction for reporting habits: rat complaints are divided by all-type 311 activity within a moving window of about a quarter mile (a 5x5 block of grid cells), rescaled by the citywide median window, so areas that call 311 about everything do not dominate the map.

## Data sources

- [DOHMH Rodent Inspection](https://data.cityofnewyork.us/Health/Rodent-Inspection/p937-wjvj) (dataset `p937-wjvj`): records where `result = 'Bait applied'`, around 420,000 going back to 2010.
- [311 Service Requests](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9) (dataset `erm2-nwe9`): records where `descriptor = 'Rat Sighting'`, around 145,000. The city keeps only 2020 to present in this dataset, so the complaints layer starts in 2020. The same dataset, aggregated server-side onto the map's own grid across all complaint types, provides the baseline for the reporting-habits correction.

Records with missing or out-of-range coordinates are dropped, as are records with implausible dates.

## Project layout

```
pipeline/   Python script that fetches and aggregates the data
web/        Static site (no build step) that renders the heat map
web/data/   Generated JSON consumed by the site
web/vendor/ Vendored Leaflet and leaflet.heat, so the site is self-contained
```

## Running the pipeline

Requires Python 3, no third-party packages.

```
python3 pipeline/fetch_bait_data.py
python3 pipeline/fetch_complaint_data.py
```

Each script downloads its records from the Socrata API, aggregates them into roughly 100 meter grid cells with per-year counts, and writes a JSON file under `web/data/`. The complaints script also attaches each cell's reporting-habits adjustment factor, computed from all-type 311 totals in the surrounding window of cells. The complaints script takes a few minutes; most of that is the server-side aggregation of 21 million complaints onto the grid. Re-run both whenever you want fresh data.

## Running the site

Any static file server works:

```
python3 -m http.server 8000 --directory web
```

Then open http://localhost:8000. The site is also suitable for GitHub Pages, since everything (libraries included) is served from this repo.

## The map's math

Every view is shareable: the controls mirror into the URL hash, for example `/#mix=70&decay=bc&hl=6m&adj=1` (`hl` is the half life in months).

Per grid cell and per signal, the value is the record count under the current year filter, times the decay weight `0.5^(age_in_years / half_life)` when decay is on, times the cell's window adjustment factor when the correction is on. Values are square-root compressed (counts are heavy-tailed), normalized by each signal's own 98th percentile so the mix slider compares like with like, then blended by the mix weight into a single heat layer.

## Notes on interpretation

Bait application records are a proxy for rodenticide concentration, not a direct measurement of poison quantity. Each record is one treatment visit where bait was applied; the map weights each cell by its visit count. City treatment also tends to follow complaints and failed inspections, so the map partly reflects where the city looks, not only where rats are. Complaints reflect both rats and the people reporting them, which is what the reporting-habits correction tries to compensate for.
