/* Rodenticide in NYC: renders city bait treatments and 311 rat complaints
   as one blended heat layer, with a year filter, optional recency decay per
   signal, an optional correction for how much each area uses 311 at all,
   and a slider setting the relative weight of the two signals. */

(function () {
  "use strict";

  var BOROUGH_ORDER = ["Manhattan", "Brooklyn", "Bronx", "Queens", "Staten Island"];

  // Must mirror .legend-bar in style.css. Brightest color at the top end,
  // since intensity reads as brightness on the dark basemap.
  var HEAT_GRADIENT = {
    0.0: "#3f6d6a",
    0.4: "#c94f74",
    0.65: "#ff70a6",
    0.85: "#ff9770",
    1.0: "#ffd166"
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

  // Grid cells are fixed ground size (about 100m) but heat stamps are sized
  // in pixels, so past the zoom where stamps and cells match, a fixed stamp
  // dissolves every cell into a faint dot pinned to its grid point. Above
  // that zoom, stamps instead grow to a plateau covering each cell's real
  // footprint, so treated blocks read as filled area with soft edges.
  var BASE_HEAT_ZOOM = 13;
  var HEAT_RADIUS = 12;
  var HEAT_BLUR = 10;
  var GRID_STEP = 0.001; // must match the pipeline's grid rounding

  // Pixel height of one grid cell at the current zoom.
  function cellPixels() {
    var c = map.getCenter();
    var z = map.getZoom();
    var a = map.project(c, z);
    var b = map.project(L.latLng(c.lat + GRID_STEP, c.lng), z);
    return Math.abs(a.y - b.y);
  }

  // Stamp geometry plus a brightness compensation. Zoomed in, a stamp
  // covers its own cell but few neighbors, so far fewer stamps stack per
  // pixel than at BASE_HEAT_ZOOM, so the ramp ceiling is scaled down by
  // the lost overlap or the map goes dim as soon as stamps separate. The
  // exponent is empirical: 2 (the pure area ratio) overshoots because
  // stacked alpha saturates rather than summing at BASE_HEAT_ZOOM.
  function heatStamp() {
    var s = cellPixels();
    var radius = Math.max(HEAT_RADIUS, 0.75 * s);
    var blur = Math.max(HEAT_BLUR, 0.55 * s);
    var sBase = s / Math.pow(2, map.getZoom() - BASE_HEAT_ZOOM);
    var overlapNow = (radius + blur) / s;
    var overlapBase = (HEAT_RADIUS + HEAT_BLUR) / sBase;
    var comp = Math.pow(overlapNow / overlapBase, 1.2);
    return { radius: radius, blur: blur, comp: Math.min(1, comp) };
  }

  // Half life slider positions, in months: one month up to ten years.
  var HL_STEPS = [1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 60, 84, 120];
  var HL_DEFAULT = 3;

  var state = {
    yearIndex: -1, // -1 means all years
    mix: 50,       // percent of the blend given to complaints
    decayBait: true,
    decayComp: true,
    halfLife: HL_DEFAULT, // months
    adjust: true,  // correct complaints for local 311 usage
    glow: 50       // overall brightness, 0 to 100, 50 is neutral
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
    glowSlider: document.getElementById("glowSlider"),
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

    // The glow slider raises or lowers the ramp's ceiling exponentially:
    // 4x dimmer at 0, neutral at 50, 4x brighter at 100. A higher ceiling
    // means less of the map reaches the hot colors.
    var glowScale = Math.pow(2, (50 - state.glow) / 25);

    var stamp = heatStamp();
    if (heatLayer) map.removeLayer(heatLayer);
    heatLayer = L.heatLayer(points, {
      radius: stamp.radius,
      blur: stamp.blur,
      // The plugin scales intensity by 1/2^(maxZoom - zoom) and sums points
      // that share a pixel bucket, so zoomed-out density is handled there.
      // maxZoom is the level where 100m grid cells stand alone on screen;
      // above it, stamp scaling takes over.
      maxZoom: BASE_HEAT_ZOOM,
      max: percentile(weights, 0.98) * 2.2 * glowScale * stamp.comp,
      minOpacity: 0.03,
      gradient: HEAT_GRADIENT
    }).addTo(map);
  }

  // Stamp size and the overlap compensation both depend on zoom.
  map.on("zoomend", function () {
    if (heatLayer) renderHeat();
  });

  // ---- Location dot with compass beam ----------------------------------
  // A toggle button under the zoom control starts a geolocation watch and
  // shows a dot, an accuracy ring, and (where the device offers a compass)
  // a beam pointing the way the phone faces. Blue on purpose: it is the
  // one color the heat ramp never uses, so it always reads as "you".

  var locate = {
    active: false,
    watchId: null,
    marker: null,
    ring: null,
    beamEl: null,
    btn: null,
    hasFix: false,
    compass: false,
    orientationEvt: null,
    toastTimer: null
  };

  var LOCATE_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/>' +
    '<circle cx="12" cy="12" r="2.2" fill="currentColor"/>' +
    '<path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  var LocateControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      var div = L.DomUtil.create("div", "leaflet-bar locate-control");
      var btn = L.DomUtil.create("a", "locate-btn", div);
      btn.href = "#";
      btn.title = "Show my location";
      btn.setAttribute("role", "button");
      btn.setAttribute("aria-label", "Show my location");
      btn.setAttribute("aria-pressed", "false");
      btn.innerHTML = LOCATE_ICON;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(btn, "click", function (e) {
        L.DomEvent.stop(e);
        if (locate.active) stopLocate();
        else startLocate();
      });
      locate.btn = btn;
      return div;
    }
  });
  map.addControl(new LocateControl());

  function locateToast(msg) {
    var t = document.getElementById("locateToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "locateToast";
      document.getElementById("map").appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(locate.toastTimer);
    locate.toastTimer = setTimeout(function () {
      t.classList.remove("show");
    }, 4000);
  }

  function startLocate() {
    if (!("geolocation" in navigator)) {
      locateToast("This browser has no location support");
      return;
    }
    locate.active = true;
    locate.hasFix = false;
    locate.btn.classList.add("active");
    locate.btn.setAttribute("aria-pressed", "true");
    // iOS only reveals the compass after an explicit permission request,
    // and the request must come from a user gesture, hence here.
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission()
        .then(function (state) {
          if (state === "granted") bindOrientation();
        })
        .catch(function () { /* no compass; the dot still works */ });
    } else {
      bindOrientation();
    }
    locate.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 20000
    });
  }

  function stopLocate() {
    locate.active = false;
    locate.btn.classList.remove("active");
    locate.btn.setAttribute("aria-pressed", "false");
    if (locate.watchId !== null) {
      navigator.geolocation.clearWatch(locate.watchId);
      locate.watchId = null;
    }
    if (locate.orientationEvt) {
      window.removeEventListener(locate.orientationEvt, onOrientation);
      locate.orientationEvt = null;
    }
    if (locate.marker) { map.removeLayer(locate.marker); locate.marker = null; }
    if (locate.ring) { map.removeLayer(locate.ring); locate.ring = null; }
    locate.beamEl = null;
    locate.compass = false;
  }

  function onFix(pos) {
    if (!locate.active) return;
    var ll = [pos.coords.latitude, pos.coords.longitude];
    var acc = pos.coords.accuracy || 0;
    if (!locate.marker) {
      locate.ring = L.circle(ll, {
        radius: acc,
        color: "#4da3ff",
        weight: 1,
        opacity: 0.4,
        fillColor: "#4da3ff",
        fillOpacity: 0.08,
        interactive: false
      }).addTo(map);
      locate.marker = L.marker(ll, {
        icon: L.divIcon({
          className: "you-wrap",
          iconSize: [72, 72],
          iconAnchor: [36, 36],
          html: '<div class="you-beam"></div><div class="you-dot"></div>'
        }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000
      }).addTo(map);
      locate.beamEl = locate.marker.getElement().querySelector(".you-beam");
    } else {
      locate.marker.setLatLng(ll);
      locate.ring.setLatLng(ll);
      locate.ring.setRadius(acc);
    }
    // Without a compass, GPS course still gives a heading while moving.
    if (!locate.compass && pos.coords.heading != null &&
        !isNaN(pos.coords.heading) && (pos.coords.speed || 0) > 0.5) {
      setHeading(pos.coords.heading);
    }
    if (!locate.hasFix) {
      locate.hasFix = true;
      // Land the dot in the middle of the map area the panel does not
      // cover: to its right on desktop, above it on phones. A plain
      // setView would center the dot under the panel on small screens.
      map.setView(ll, Math.max(map.getZoom(), 15), { animate: false });
      var t = clearViewpoint();
      var c = map.getSize().divideBy(2);
      map.panBy([Math.round(c.x - t.x), Math.round(c.y - t.y)], { animate: false });
    }
  }

  // Center of the largest map region not covered by the control panel,
  // in container pixels.
  function clearViewpoint() {
    var mapRect = document.getElementById("map").getBoundingClientRect();
    var c = { x: mapRect.width / 2, y: mapRect.height / 2 };
    var panel = document.getElementById("panel");
    if (!panel || panel.classList.contains("collapsed")) return c;
    var p = panel.getBoundingClientRect();
    var rightW = mapRect.right - p.right;
    var aboveH = p.top - mapRect.top;
    if (rightW * mapRect.height >= aboveH * mapRect.width) {
      if (rightW < 120) return c; // not enough room to bother
      return { x: p.right - mapRect.left + rightW / 2, y: mapRect.height / 2 };
    }
    if (aboveH < 120) return c;
    return { x: mapRect.width / 2, y: aboveH / 2 };
  }

  function onFixError(err) {
    if (err.code === 1) {
      locateToast("Location permission was denied");
      stopLocate();
    } else if (!locate.hasFix) {
      locateToast("No location fix yet, still trying");
    }
  }

  function setHeading(h) {
    if (!locate.beamEl) return;
    locate.beamEl.style.transform = "rotate(" + h + "deg)";
    locate.beamEl.classList.add("on");
  }

  function bindOrientation() {
    if (locate.orientationEvt) return;
    // Chrome fires compass-grade readings on its own event; iOS Safari
    // uses the plain event plus webkitCompassHeading.
    locate.orientationEvt = "ondeviceorientationabsolute" in window
      ? "deviceorientationabsolute"
      : "deviceorientation";
    window.addEventListener(locate.orientationEvt, onOrientation);
  }

  function onOrientation(e) {
    var h = null;
    if (typeof e.webkitCompassHeading === "number") {
      h = e.webkitCompassHeading; // already clockwise from north
    } else if (e.absolute && typeof e.alpha === "number") {
      h = 360 - e.alpha;
    }
    if (h == null || isNaN(h)) return;
    // Compass values are in the device frame; the map is in the screen
    // frame, so rotate by however far the screen itself is turned.
    var screenAngle = (screen.orientation && screen.orientation.angle) ||
      window.orientation || 0;
    locate.compass = true;
    setHeading(((h + screenAngle) % 360 + 360) % 360);
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
    compPart.textContent = "Sightings " + state.mix + "%";
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
    // Defaults (decay on for both signals, adjustment on) are omitted, so
    // switching one OFF needs an explicit token: decay=none and adj=0.
    var decay = (state.decayBait ? "b" : "") + (state.decayComp ? "c" : "");
    if (decay !== "bc") parts.push("decay=" + (decay || "none"));
    if (state.halfLife !== HL_DEFAULT) parts.push("hl=" + state.halfLife + "m");
    if (!state.adjust) parts.push("adj=0");
    if (state.glow !== 50) parts.push("glow=" + state.glow);
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
          break; // "none" (or any other value) turns both off
        case "hl":
          // "18m" means months; a bare number is years (older links).
          var months = /m$/.test(val)
            ? parseInt(val, 10)
            : (parseInt(val, 10) || 4) * 12;
          state.halfLife = HL_STEPS[nearestHalfLifeIndex(months || HL_DEFAULT)];
          break;
        case "adj":
          state.adjust = val !== "0";
          break;
        case "glow":
          state.glow = Math.min(100, Math.max(0, parseInt(val, 10) || 0));
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

    el.glowSlider.addEventListener("input", function () {
      state.glow = parseInt(el.glowSlider.value, 10);
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
    el.glowSlider.value = state.glow;

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
