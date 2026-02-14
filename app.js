require([
  "esri/Map",
  "esri/views/MapView",
  "esri/views/SceneView",
  "esri/layers/FeatureLayer",
  "esri/layers/GraphicsLayer",
  "esri/Graphic",
  "esri/geometry/geometryEngine",
  "esri/widgets/Sketch/SketchViewModel",
  "esri/widgets/Search",
  "esri/widgets/Locate",
  "esri/widgets/BasemapToggle",
  "esri/rest/support/StatisticDefinition"
], function (
  Map, MapView, SceneView, FeatureLayer, GraphicsLayer, Graphic,
  geometryEngine, SketchViewModel, Search, Locate, BasemapToggle,
  StatisticDefinition
) {

  // ========== State ==========
  var bufferCenter = null;
  var bufferRadius = 2;
  var bufferGraphic = null;
  var sketchVM = null;
  var popLayerView = null;
  var queryAbortController = null;
  var view = null;
  var is3D = false;
  var searchWidget = null;
  var currentPopulation = 0;
  var savedQueries = [];
  var queryCounter = 0;
  var savedGraphicsLayer = new GraphicsLayer();

  var QUERY_COLORS = [
    [255, 165, 0],   // orange
    [220, 80, 220],  // magenta
    [80, 220, 120],  // green
    [255, 220, 60],  // yellow
    [255, 100, 100]  // coral
  ];

  // ========== UI References ==========
  var popValueEl = document.getElementById("popValue");
  var radiusSlider = document.getElementById("radiusSlider");
  var radiusLabel = document.getElementById("radiusLabel");
  var saveQueryBtn = document.getElementById("saveQueryBtn");
  var savedQueryList = document.getElementById("savedQueryList");
  var toggleViewBtn = document.getElementById("toggleViewBtn");

  // ========== Splash Screen ==========
  (function initSplash() {
    var splash = document.getElementById("splash");
    if (localStorage.getItem("popn-viewer-splash-dismissed")) {
      splash.style.display = "none";
      return;
    }
    document.getElementById("splash-dismiss").addEventListener("click", function () {
      splash.classList.add("hidden");
      setTimeout(function () { splash.style.display = "none"; }, 400);
      localStorage.setItem("popn-viewer-splash-dismissed", "1");
    });
  })();

  // ========== Sidebar Toggle ==========
  (function initSidebar() {
    var sidebar = document.getElementById("sidebar");
    var toggle = document.getElementById("sidebar-toggle");
    toggle.addEventListener("click", function () {
      sidebar.classList.toggle("collapsed");
      toggle.textContent = sidebar.classList.contains("collapsed") ? "\u25B6" : "\u2630";
    });
  })();

  // ========== Layers ==========
  var graphicsLayer = new GraphicsLayer();

  var popLayer = new FeatureLayer({
    url: "https://services2.arcgis.com/vKb0s8tBIA3bdocZ/arcgis/rest/services/NZGrid_250m_ERP/FeatureServer/1",
    outFields: ["PopEst2023"],
    renderer: {
      type: "simple",
      symbol: {
        type: "simple-fill",
        color: [86, 193, 255, 0.05],
        outline: { color: [86, 193, 255, 0.15], width: 0.5 }
      }
    },
    popupEnabled: false,
    minScale: 500000
  });

  // ========== Map ==========
  var map = new Map({
    basemap: "dark-gray-vector",
    ground: "world-elevation",
    layers: [popLayer, savedGraphicsLayer, graphicsLayer]
  });

  // ========== Create View ==========
  function createView(ViewClass, center, zoom) {
    var opts = {
      container: "viewDiv",
      map: map,
      center: center || [174.7633, -36.8485],
      zoom: zoom || 10
    };
    if (ViewClass === SceneView && opts.zoom) {
      // SceneView works with zoom too, so just pass it through
    }

    var v = new ViewClass(opts);

    // Clear search container before re-creating widget
    var searchContainer = document.getElementById("searchContainer");
    searchContainer.innerHTML = "";
    searchWidget = new Search({ view: v, container: searchContainer });

    v.ui.add(new BasemapToggle({ view: v, nextBasemap: "satellite" }), "bottom-right");

    // Layer view for client-side queries
    v.whenLayerView(popLayer).then(function (lv) {
      popLayerView = lv;
    });

    // SketchViewModel
    sketchVM = new SketchViewModel({
      view: v,
      layer: graphicsLayer,
      defaultUpdateOptions: {
        tool: "move",
        enableRotation: false,
        enableScaling: false,
        toggleToolOnClick: false
      }
    });

    sketchVM.on("update", function (event) {
      if (event.state === "cancel" || event.state === "complete") return;
      var updatedGraphic = event.graphics[0];
      if (!updatedGraphic) return;
      bufferGraphic = updatedGraphic;
      bufferCenter = updatedGraphic.geometry.centroid;
      queryPopulation(updatedGraphic.geometry);
    });

    // Map click
    v.on("click", function (event) {
      if (sketchVM.state === "active") return;
      bufferCenter = event.mapPoint;
      placeBuffer();
    });

    return v;
  }

  // Initial view
  view = createView(MapView);

  // ========== Locate Button ==========
  document.getElementById("locateBtn").addEventListener("click", function () {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function (pos) {
        view.goTo({
          center: [pos.coords.longitude, pos.coords.latitude],
          zoom: 13
        });
      });
    }
  });

  // ========== 2D/3D View Switcher ==========
  toggleViewBtn.addEventListener("click", function () {
    var center = view.center;
    var zoom = view.zoom;

    // Invalidate stale layer view before destroying
    popLayerView = null;

    // Detach map before destroying view so the map isn't destroyed with it
    view.map = null;
    view.destroy();
    searchWidget.destroy();

    is3D = !is3D;
    toggleViewBtn.textContent = is3D ? "2D" : "3D";

    // Create new view
    var ViewClass = is3D ? SceneView : MapView;
    view = createView(ViewClass, center, zoom);

    // Re-add buffer graphic if it exists
    if (bufferCenter) {
      placeBuffer();
    }

    // Re-draw saved query graphics (they persist on savedGraphicsLayer which is on the map)
  });

  // ========== Radius Slider ==========
  radiusSlider.addEventListener("input", function () {
    bufferRadius = parseFloat(this.value);
    radiusLabel.textContent = bufferRadius.toFixed(1);
    if (bufferCenter) {
      placeBuffer();
    }
  });

  // ========== Place / Replace Buffer ==========
  function placeBuffer() {
    sketchVM.cancel();
    graphicsLayer.removeAll();

    var buffer = geometryEngine.geodesicBuffer(
      bufferCenter, bufferRadius, "kilometers"
    );

    bufferGraphic = new Graphic({
      geometry: buffer,
      symbol: {
        type: "simple-fill",
        color: [86, 193, 255, 0.18],
        outline: { color: [86, 193, 255, 0.9], width: 2 }
      }
    });

    graphicsLayer.add(bufferGraphic);
    sketchVM.update(bufferGraphic);
    queryPopulation(buffer);
  }

  // ========== Query Population ==========
  function queryPopulation(geometry) {
    if (queryAbortController) {
      queryAbortController.abort();
    }
    queryAbortController = new AbortController();

    var statDef = new StatisticDefinition({
      statisticType: "sum",
      onStatisticField: "PopEst2023",
      outStatisticFieldName: "totalPop"
    });

    var queryParams = {
      geometry: geometry,
      spatialRelationship: "intersects",
      outStatistics: [statDef]
    };

    var signal = queryAbortController.signal;

    if (popLayerView && !popLayerView.updating) {
      popLayerView.queryFeatures({
        ...queryParams,
        signal: signal
      }).then(function (result) {
        // If client-side returned 0 (features may not be loaded at this scale), try server
        var pop = (result.features && result.features.length > 0)
          ? result.features[0].attributes.totalPop || 0 : 0;
        if (pop === 0) {
          serverQuery(queryParams, signal);
        } else {
          handleResult(result);
        }
      }).catch(function (err) {
        if (err.name === "AbortError") return;
        serverQuery(queryParams, signal);
      });
    } else {
      serverQuery(queryParams, signal);
    }
  }

  function serverQuery(queryParams, signal) {
    popLayer.queryFeatures({
      ...queryParams,
      signal: signal
    }).then(handleResult).catch(function (err) {
      if (err.name === "AbortError") return;
      console.error("Population query failed:", err);
    });
  }

  function handleResult(result) {
    var pop = 0;
    if (result.features && result.features.length > 0) {
      pop = result.features[0].attributes.totalPop || 0;
    }
    currentPopulation = Math.round(pop);
    popValueEl.textContent = currentPopulation.toLocaleString();
    saveQueryBtn.disabled = !bufferCenter;
  }

  // ========== Save & Compare Queries ==========
  saveQueryBtn.addEventListener("click", function () {
    if (!bufferCenter || savedQueries.length >= 5) return;

    queryCounter++;
    var colorIndex = (savedQueries.length) % QUERY_COLORS.length;
    var color = QUERY_COLORS[colorIndex];
    var id = "q" + queryCounter;

    var query = {
      id: id,
      label: "Query " + queryCounter,
      center: bufferCenter.clone(),
      radius: bufferRadius,
      population: currentPopulation,
      color: color
    };

    // Draw saved buffer on map
    var buffer = geometryEngine.geodesicBuffer(
      query.center, query.radius, "kilometers"
    );

    var savedGraphic = new Graphic({
      geometry: buffer,
      symbol: {
        type: "simple-fill",
        color: [color[0], color[1], color[2], 0.12],
        outline: {
          color: [color[0], color[1], color[2], 0.8],
          width: 2,
          style: "dash"
        }
      },
      attributes: { queryId: id }
    });

    savedGraphicsLayer.add(savedGraphic);
    query.graphic = savedGraphic;
    savedQueries.push(query);

    renderSavedQueries();
  });

  function renderSavedQueries() {
    savedQueryList.innerHTML = "";

    savedQueries.forEach(function (q) {
      var item = document.createElement("div");
      item.className = "saved-query-item";

      var swatch = document.createElement("div");
      swatch.className = "saved-query-swatch";
      swatch.style.background = "rgb(" + q.color.join(",") + ")";

      var info = document.createElement("div");
      info.className = "saved-query-info";
      info.innerHTML =
        '<div class="saved-query-label">' + q.label + '</div>' +
        '<div class="saved-query-detail">' +
          q.population.toLocaleString() + " pop &middot; " +
          q.radius.toFixed(1) + " km" +
        '</div>';

      var del = document.createElement("button");
      del.className = "saved-query-delete";
      del.textContent = "\u00D7";
      del.title = "Remove query";
      del.addEventListener("click", function () {
        removeQuery(q.id);
      });

      item.appendChild(swatch);
      item.appendChild(info);
      item.appendChild(del);
      savedQueryList.appendChild(item);
    });

    // Disable save button if at max
    if (savedQueries.length >= 5) {
      saveQueryBtn.disabled = true;
    }
  }

  function removeQuery(id) {
    var idx = savedQueries.findIndex(function (q) { return q.id === id; });
    if (idx === -1) return;

    var q = savedQueries[idx];
    savedGraphicsLayer.remove(q.graphic);
    savedQueries.splice(idx, 1);
    renderSavedQueries();

    // Re-enable save button
    if (bufferCenter && savedQueries.length < 5) {
      saveQueryBtn.disabled = false;
    }
  }

});
