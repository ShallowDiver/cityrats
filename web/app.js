/* Rodenticide in NYC: renders city bait treatments and 311 rat complaints
   as one blended heat layer, with a year filter, optional recency decay per
   signal, an optional correction for how much each area uses 311 at all,
   and a slider setting the relative weight of the two signals. */

(function () {
  "use strict";

  var BOROUGH_ORDER = ["Manhattan", "Brooklyn", "Bronx", "Queens", "Staten Island"];

  // Must mirror .legend-bar in style.css
  var HEAT_GRADIENT = {
    0.0: "#2a1a5e",
    0.35: "#7b2e8e",
    0.58: "#d6402b",
    0.78: "#f7841a",
    1.0: "#f7b500"
  };

  var map = L.map("map", {
    center: [40.72, -73.95],
    zoom: 11,
    minZoom: 10,
    maxZoom: 17,
    zoomControl: false
  });

  L.control.zoom({ position: "topright" }).addTo(map);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(map);

  var heatLayer = null;
  var bait = null;
  var complaints = null;

  // Half life slider positions, in months: one month up to ten years.
  var HL_STEPS = [1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 60, 84, 120];
  var HL_DEFAULT = 48;

  var state = {
    yearIndex: -1, // -1 means all years
    mix: 50,       // percent of the blend given to complaints
    decayBait: false,
    decayComp: false,
    halfLife: HL_DEFAULT, // months
    adjust: false  // correct complaints for 311 usage by zip
  };

  var el = {
    yearSlider: document.getElementById("yearSlider"),
    yearReadout: document.getElementById("yearReadout"),
    allBtn: document.getElementById("allYearsBtn"),
    mixSlider: document.getElementById("mixSlider"),
    mixReadout: document.getElementById("mixReadout"),
    decayBait: document.getElementById("decayBait"),
    decayComp: document.getElementById("decayComp"),
    halfLifeRow: document.getElementById("halfLifeRow"),
    halfLifeSlider: document.getElementById("halfLifeSlider"),
    halfLifeReadout: document.getElementById("halfLifeReadout"),
    adjustComp: document.getElementById("adjustComp"),
    boroughList: document.getElementById("boroughList")
  };

  function formatCount(n) {
    return n.toLocaleString("en-US");
  }

  // Decay multiplier for a year: halves every halfLife months of age.
  // Ages are whole years, the resolution the data is binned at.
  function decayFactors(years) {
    var last = years[years.length - 1];
    var halfLifeYears = state.halfLife / 12;
    return years.map(function (y) {
      return Math.pow(0.5, (last - y) / halfLifeYears);
    });
  }

  function nearestHalfLifeIndex(months) {
    var best = 0;
    for (var i = 1; i < HL_STEPS.length; i++) {
      if (Math.abs(HL_STEPS[i] - months) < Math.abs(HL_STEPS[best] - months)) {
        best = i;
      }
    }
    return best;
  }

  function formatHalfLife(months) {
    if (months < 12) {
      return months + (months === 1 ? " month" : " months");
    }
    var y = months / 12;
    var text = y % 1 === 0 ? String(y) : y.toFixed(1);
    return text + (y === 1 ? " year" : " years");
  }

  // Value of one cell under the current year selection and decay setting.
  function cellValue(counts, decay) {
    if (state.yearIndex >= 0) {
      return counts[state.yearIndex] || 0;
    }
    var v = 0;
    for (var j = 0; j < counts.length; j++) {
      v += decay ? counts[j] * decay[j] : counts[j];
    }
    return v;
  }

  function percentile(sortedAsc, p) {
    if (!sortedAsc.length) return 1;
    return sortedAsc[Math.floor(sortedAsc.length * p)] || 1;
  }

  // Accumulate one dataset's cells into the shared cell table. The square
  // root compresses heavy-tailed counts; each signal is then normalized by
  // its own 98th percentile so the mix slider compares like with like.
  function accumulate(table, data, share, decayOn, useAdj) {
    if (share <= 0) return;
    var decay = decayOn && state.yearIndex < 0 ? decayFactors(data.years) : null;
    var cells = data.cells;
    var weights = [];
    var i, w;
    for (i = 0; i < cells.length; i++) {
      var v = cellValue(cells[i][2], decay);
      if (v <= 0) continue;
      if (useAdj) v *= cells[i][3];
      w = Math.sqrt(v);
      weights.push(w);
      cells[i]._w = w;
    }
    var scale = percentile(weights.sort(function (a, b) { return a - b; }), 0.98);
    for (i = 0; i < cells.length; i++) {
      w = cells[i]._w;
      if (!w) continue;
      cells[i]._w = 0;
      var key = cells[i][0] + "," + cells[i][1];
      var add = (share * w) / scale;
      if (table[key]) {
        table[key][2] += add;
      } else {
        table[key] = [cells[i][0], cells[i][1], add];
      }
    }
  }

  function renderHeat() {
    var m = state.mix / 100;
    var table = {};
    accumulate(table, bait, 1 - m, state.decayBait, false);
    accumulate(table, complaints, m, state.decayComp, state.adjust);

    // Cells whose records have decayed to almost nothing must actually
    // drop out: leaflet.heat draws every point at minOpacity or above, and
    // a near-zero carpet would also drag the percentile scale down, so a
    // short half life would render much like no decay at all.
    var points = [];
    var weights = [];
    for (var key in table) {
      if (table[key][2] < 0.02) continue;
      points.push(table[key]);
      weights.push(table[key][2]);
    }
    weights.sort(function (a, b) { return a - b; });

    if (heatLayer) map.removeLayer(heatLayer);
    heatLayer = L.heatLayer(points, {
      radius: 12,
      blur: 10,
      // The plugin scales intensity by 1/2^(maxZoom - zoom) and sums points
      // that share a pixel bucket, so zoomed-out density is handled there.
      // maxZoom is the level where 100m grid cells stand alone on screen.
      maxZoom: 13,
      max: percentile(weights, 0.98) * 2.2,
      minOpacity: 0.03,
      gradient: HEAT_GRADIENT
    }).addTo(map);
  }

  // Borough totals are plain record counts under the year filter; decay and
  // the 311 correction shape the map, not these numbers.
  function boroughTotal(data, name) {
    var counts = data.boroughs[name] || [];
    if (state.yearIndex >= 0) return counts[state.yearIndex] || 0;
    var c = 0;
    for (var j = 0; j < counts.length; j++) c += counts[j];
    return c;
  }

  function renderStats() {
    var maxBait = 1;
    var maxComp = 1;
    var totals = BOROUGH_ORDER.map(function (name) {
      var b = boroughTotal(bait, name);
      var c = boroughTotal(complaints, name);
      if (b > maxBait) maxBait = b;
      if (c > maxComp) maxComp = c;
      return { name: name, bait: b, comp: c };
    });

    el.boroughList.innerHTML = "";
    totals.forEach(function (t) {
      var li = document.createElement("li");

      var label = document.createElement("span");
      label.className = "b-name";
      label.textContent = t.name;

      var bars = document.createElement("span");
      bars.className = "b-bars";
      var baitBar = document.createElement("span");
      baitBar.className = "b-bar bait";
      var baitFill = document.createElement("span");
      baitFill.style.width = (t.bait / maxBait) * 100 + "%";
      baitBar.appendChild(baitFill);
      var compBar = document.createElement("span");
      compBar.className = "b-bar comp";
      var compFill = document.createElement("span");
      compFill.style.width = (t.comp / maxComp) * 100 + "%";
      compBar.appendChild(compFill);
      bars.appendChild(baitBar);
      bars.appendChild(compBar);

      var counts = document.createElement("span");
      counts.className = "b-counts";
      var baitN = document.createElement("span");
      baitN.textContent = formatCount(t.bait);
      var compN = document.createElement("span");
      compN.className = "comp";
      compN.textContent = formatCount(t.comp);
      counts.appendChild(baitN);
      counts.appendChild(compN);

      li.appendChild(label);
      li.appendChild(bars);
      li.appendChild(counts);
      el.boroughList.appendChild(li);
    });
  }

  function updateControls() {
    if (state.yearIndex < 0) {
      var first = bait.years[0];
      var last = bait.years[bait.years.length - 1];
      el.yearReadout.textContent = "All years, " + first + " to " + last;
      el.allBtn.disabled = true;
    } else {
      el.yearReadout.textContent = String(bait.years[state.yearIndex]);
      el.allBtn.disabled = false;
    }

    el.mixReadout.innerHTML = "";
    var baitPart = document.createElement("span");
    baitPart.className = "mix-bait";
    baitPart.textContent = "Bait " + (100 - state.mix) + "%";
    var sep = document.createElement("span");
    sep.className = "mix-sep";
    sep.textContent = " / ";
    var compPart = document.createElement("span");
    compPart.className = "mix-comp";
    compPart.textContent = "311 " + state.mix + "%";
    el.mixReadout.appendChild(baitPart);
    el.mixReadout.appendChild(sep);
    el.mixReadout.appendChild(compPart);

    el.halfLifeReadout.textContent = formatHalfLife(state.halfLife);

    // Decay is about mixing years, so it is inert when one year is shown.
    var singleYear = state.yearIndex >= 0;
    el.decayBait.disabled = singleYear;
    el.decayComp.disabled = singleYear;
    var decayActive = !singleYear && (state.decayBait || state.decayComp);
    el.halfLifeSlider.disabled = !decayActive;
    el.halfLifeRow.classList.toggle("inactive", !decayActive);
  }

  // The URL hash mirrors the controls so any view is shareable, for example
  // #year=2023&mix=70&decay=bc&hl=3&adj=1. A bare #2023 also works.
  function writeHash() {
    var parts = [];
    if (state.yearIndex >= 0) parts.push("year=" + bait.years[state.yearIndex]);
    if (state.mix !== 50) parts.push("mix=" + state.mix);
    var decay = (state.decayBait ? "b" : "") + (state.decayComp ? "c" : "");
    if (decay) parts.push("decay=" + decay);
    if (state.halfLife !== HL_DEFAULT) parts.push("hl=" + state.halfLife + "m");
    if (state.adjust) parts.push("adj=1");
    history.replaceState(
      null, "",
      parts.length ? "#" + parts.join("&") : window.location.pathname
    );
  }

  function readHash() {
    var hash = window.location.hash.slice(1);
    if (!hash) return;
    if (/^\d{4}$/.test(hash)) {
      state.yearIndex = bait.years.indexOf(parseInt(hash, 10));
      return;
    }
    hash.split("&").forEach(function (part) {
      var kv = part.split("=");
      var val = kv[1] || "";
      switch (kv[0]) {
        case "year":
          state.yearIndex = bait.years.indexOf(parseInt(val, 10));
          break;
        case "mix":
          state.mix = Math.min(100, Math.max(0, parseInt(val, 10) || 0));
          break;
        case "decay":
          state.decayBait = val.indexOf("b") >= 0;
          state.decayComp = val.indexOf("c") >= 0;
          break;
        case "hl":
          // "18m" means months; a bare number is years (older links).
          var months = /m$/.test(val)
            ? parseInt(val, 10)
            : (parseInt(val, 10) || 4) * 12;
          state.halfLife = HL_STEPS[nearestHalfLifeIndex(months || HL_DEFAULT)];
          break;
        case "adj":
          state.adjust = val === "1";
          break;
      }
    });
  }

  function refresh() {
    updateControls();
    writeHash();
    renderHeat();
    renderStats();
  }

  function bindControls() {
    el.yearSlider.addEventListener("input", function () {
      var v = parseInt(el.yearSlider.value, 10);
      state.yearIndex = v === 0 ? -1 : v - 1;
      refresh();
    });

    el.allBtn.addEventListener("click", function () {
      el.yearSlider.value = 0;
      state.yearIndex = -1;
      refresh();
    });

    el.mixSlider.addEventListener("input", function () {
      state.mix = parseInt(el.mixSlider.value, 10);
      refresh();
    });

    el.decayBait.addEventListener("change", function () {
      state.decayBait = el.decayBait.checked;
      refresh();
    });

    el.decayComp.addEventListener("change", function () {
      state.decayComp = el.decayComp.checked;
      refresh();
    });

    el.halfLifeSlider.addEventListener("input", function () {
      state.halfLife = HL_STEPS[parseInt(el.halfLifeSlider.value, 10)];
      refresh();
    });

    el.adjustComp.addEventListener("change", function () {
      state.adjust = el.adjustComp.checked;
      refresh();
    });
  }

  function init(loadedBait, loadedComplaints) {
    bait = loadedBait;
    complaints = loadedComplaints;

    document.getElementById("totalAll").textContent = formatCount(bait.total_records);
    document.getElementById("totalComplaints").textContent =
      formatCount(complaints.total_records);
    document.getElementById("generatedDate").textContent = bait.generated;

    el.yearSlider.min = 0;
    el.yearSlider.max = bait.years.length;

    readHash();

    el.yearSlider.value = state.yearIndex < 0 ? 0 : state.yearIndex + 1;
    el.mixSlider.value = state.mix;
    el.decayBait.checked = state.decayBait;
    el.decayComp.checked = state.decayComp;
    el.halfLifeSlider.value = nearestHalfLifeIndex(state.halfLife);
    el.adjustComp.checked = state.adjust;

    bindControls();
    refresh();
  }

  var toggle = document.getElementById("panelToggle");
  var panel = document.getElementById("panel");
  toggle.addEventListener("click", function () {
    var collapsed = panel.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "Show" : "Hide";
    toggle.setAttribute("aria-expanded", String(!collapsed));
  });

  function getJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(url + ": HTTP " + r.status);
      return r.json();
    });
  }

  Promise.all([
    getJSON("data/bait_grid.json"),
    getJSON("data/complaints_grid.json")
  ])
    .then(function (results) {
      init(results[0], results[1]);
    })
    .catch(function (err) {
      el.yearReadout.textContent = "Data failed to load";
      console.error(err);
    });
})();
