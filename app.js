require([
  "esri/Map",
  "esri/views/MapView",
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
  Map, MapView, FeatureLayer, GraphicsLayer, Graphic,
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
  var currentPopulation = 0;
  var savedQueries = [];
  var queryCounter = 0;
  var savedGraphicsLayer = new GraphicsLayer();
  var drawGraphicsLayer = new GraphicsLayer();
  var drawSketchVM = null;
  var currentGeometry = null; // tracks the active query geometry (buffer or drawn polygon)
  var activeSavedQuery = null; // saved query currently being moved
  var activeDrawnGraphic = null; // drawn polygon currently being moved

  var QUERY_COLORS = [
    [255, 165, 0],   // orange
    [220, 80, 220],  // magenta
    [80, 220, 120],  // green
    [255, 220, 60],  // yellow
    [255, 100, 100]  // coral
  ];

  // NZ total population (2026 mid-year estimate, worldometers.info)
  var NZ_POPULATION = 5287479;

  // ========== UI References ==========
  var popValueEl = document.getElementById("popValue");
  var popPercentEl = document.getElementById("popPercent");
  var radiusSlider = document.getElementById("radiusSlider");
  var radiusLabel = document.getElementById("radiusLabel");
  var saveQueryBtn = document.getElementById("saveQueryBtn");
  var savedQueryList = document.getElementById("savedQueryList");
  var drawPolygonBtn = document.getElementById("drawPolygonBtn");
  var clearDrawBtn = document.getElementById("clearDrawBtn");

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

  // ========== Map & View ==========
  var map = new Map({
    basemap: "dark-gray-vector",
    layers: [popLayer, drawGraphicsLayer, savedGraphicsLayer, graphicsLayer]
  });

  var view = new MapView({
    container: "viewDiv",
    map: map,
    center: [174.7785, -41.2890],
    zoom: 11
  });

  // ========== Widgets ==========
  new Search({ view: view, container: document.getElementById("searchContainer") });
  view.ui.add(new BasemapToggle({ view: view, nextBasemap: "satellite" }), "bottom-right");

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

  // ========== Layer View for Client-Side Queries ==========
  view.whenLayerView(popLayer).then(function (lv) {
    popLayerView = lv;
  });

  // ========== SketchViewModel ==========
  sketchVM = new SketchViewModel({
    view: view,
    layer: graphicsLayer,
    defaultUpdateOptions: {
      tool: "move",
      enableRotation: false,
      enableScaling: false,
      toggleToolOnClick: false
    }
  });

  sketchVM.on("update", function (event) {
    var updatedGraphic = event.graphics[0];
    if (!updatedGraphic) return;

    // When done moving, return graphic to its home layer
    if (event.state === "cancel" || event.state === "complete") {
      if (activeSavedQuery) {
        var q = activeSavedQuery;
        graphicsLayer.remove(updatedGraphic);
        updatedGraphic.symbol = q.graphic.symbol;
        q.graphic = updatedGraphic;
        q.geometry = updatedGraphic.geometry;
        savedGraphicsLayer.add(updatedGraphic);
        originalSymbolColors.delete(updatedGraphic);
        activeSavedQuery = null;
      } else if (activeDrawnGraphic) {
        graphicsLayer.remove(updatedGraphic);
        updatedGraphic.symbol = {
          type: "simple-fill",
          color: [180, 130, 255, 0.15],
          outline: { color: [180, 130, 255, 0.8], width: 2 }
        };
        drawGraphicsLayer.add(updatedGraphic);
        originalSymbolColors.delete(updatedGraphic);
        activeDrawnGraphic = updatedGraphic;
        currentGeometry = updatedGraphic.geometry;
      }
      return;
    }

    if (activeSavedQuery || activeDrawnGraphic) {
      // Moving a saved query or drawn polygon — update population live
      currentGeometry = updatedGraphic.geometry;
      queryPopulation(updatedGraphic.geometry);
    } else {
      // Moving the buffer
      bufferGraphic = updatedGraphic;
      bufferCenter = updatedGraphic.geometry.centroid;
      queryPopulation(updatedGraphic.geometry);
    }
  });

  // ========== Draw SketchViewModel ==========
  drawSketchVM = new SketchViewModel({
    view: view,
    layer: drawGraphicsLayer,
    defaultCreateOptions: { hasZ: false },
    polygonSymbol: {
      type: "simple-fill",
      color: [180, 130, 255, 0.15],
      outline: { color: [180, 130, 255, 0.8], width: 2 }
    }
  });

  drawSketchVM.on("create", function (event) {
    if (event.state === "complete") {
      drawPolygonBtn.classList.remove("active");
      clearDrawBtn.disabled = false;
      // Clear any existing buffer
      sketchVM.cancel();
      graphicsLayer.removeAll();
      bufferCenter = null;
      bufferGraphic = null;

      // Move the drawn graphic to graphicsLayer so it can be moved
      var drawnGraphic = event.graphic;
      drawGraphicsLayer.remove(drawnGraphic);
      drawnGraphic.symbol = {
        type: "simple-fill",
        color: [180, 130, 255, 0.15],
        outline: { color: [180, 130, 255, 0.8], width: 2 }
      };
      graphicsLayer.add(drawnGraphic);
      activeDrawnGraphic = drawnGraphic;

      currentGeometry = drawnGraphic.geometry;
      queryPopulation(drawnGraphic.geometry);
      sketchVM.update(drawnGraphic);
    }
  });

  drawPolygonBtn.addEventListener("click", function () {
    if (drawSketchVM.state === "active") {
      drawSketchVM.cancel();
      drawPolygonBtn.classList.remove("active");
    } else {
      drawSketchVM.create("polygon");
      drawPolygonBtn.classList.add("active");
    }
  });

  clearDrawBtn.addEventListener("click", function () {
    drawGraphicsLayer.removeAll();
    clearDrawBtn.disabled = true;
  });

  // ========== Default 500m Polygon (10 Lombard St) ==========
  view.when(function () {
    var lombardPoint = { type: "point", longitude: 174.7785, latitude: -41.2890, spatialReference: { wkid: 4326 } };
    var lombardBuffer = geometryEngine.geodesicBuffer(lombardPoint, 0.5, "kilometers");
    var lombardGraphic = new Graphic({
      geometry: lombardBuffer,
      symbol: {
        type: "simple-fill",
        color: [180, 130, 255, 0.12],
        outline: { color: [180, 130, 255, 0.7], width: 2, style: "dash" }
      },
      attributes: { label: "10 Lombard St (500m)" }
    });
    drawGraphicsLayer.add(lombardGraphic);
    clearDrawBtn.disabled = false;
  });

  // ========== Default Buffer ==========
  view.when(function () {
    bufferCenter = { type: "point", longitude: 174.7785, latitude: -41.2890, spatialReference: { wkid: 4326 } };
    bufferRadius = 1;
    radiusSlider.value = "1";
    radiusLabel.textContent = "1.0";
    placeBuffer();
  });

  // ========== Map Click ==========
  view.on("click", function (event) {
    if (sketchVM.state === "active" || drawSketchVM.state === "active") return;
    bufferCenter = event.mapPoint;
    placeBuffer();
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
    currentGeometry = buffer;
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
    var percent = (currentPopulation / NZ_POPULATION * 100);
    popPercentEl.textContent = percent < 0.01 && currentPopulation > 0
      ? "< 0.01% of NZ population"
      : percent.toFixed(2) + "% of NZ population";
    if (currentPopulation === 0) popPercentEl.textContent = "";
    saveQueryBtn.disabled = !currentGeometry;
  }

  // ========== Save & Compare Queries ==========
  saveQueryBtn.addEventListener("click", function () {
    if (!currentGeometry || savedQueries.length >= 5) return;

    queryCounter++;
    var colorIndex = (savedQueries.length) % QUERY_COLORS.length;
    var color = QUERY_COLORS[colorIndex];
    var id = "q" + queryCounter;

    var isBuffer = !!bufferCenter && !activeDrawnGraphic;
    var query = {
      id: id,
      label: "Query " + queryCounter,
      population: currentPopulation,
      color: color,
      geometry: currentGeometry.clone(),
      radius: isBuffer ? bufferRadius : null,
      method: isBuffer ? "buffer" : "polygon"
    };

    var savedGraphic = new Graphic({
      geometry: currentGeometry.clone(),
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
      var methodLabel = q.method === "buffer"
        ? "&#9711; Buffer &middot; " + q.radius.toFixed(1) + " km"
        : "&#11039; Drawn polygon";
      var detail = q.population.toLocaleString() + " pop &middot; " + methodLabel;
      var labelInput = document.createElement("input");
      labelInput.className = "saved-query-label-input";
      labelInput.type = "text";
      labelInput.value = q.label;
      labelInput.addEventListener("change", function () {
        q.label = labelInput.value || q.label;
      });
      labelInput.addEventListener("blur", function () {
        q.label = labelInput.value || q.label;
      });

      var detailDiv = document.createElement("div");
      detailDiv.className = "saved-query-detail";
      detailDiv.innerHTML = detail;

      info.appendChild(labelInput);
      info.appendChild(detailDiv);

      var del = document.createElement("button");
      del.className = "saved-query-delete";
      del.textContent = "\u00D7";
      del.title = "Remove query";
      del.addEventListener("click", function () {
        removeQuery(q.id);
      });

      item.addEventListener("click", function (e) {
        // Don't trigger when clicking the label input or delete button
        if (e.target === labelInput || e.target === del) return;

        // Cancel any active sketches
        sketchVM.cancel();
        drawSketchVM.cancel();
        graphicsLayer.removeAll();
        bufferCenter = null;
        bufferGraphic = null;

        // Move saved graphic to graphicsLayer so sketchVM can move it
        savedGraphicsLayer.remove(q.graphic);
        // Reset to simple-fill so sketchVM can work with it
        q.graphic.symbol = {
          type: "simple-fill",
          color: [q.color[0], q.color[1], q.color[2], 0.12],
          outline: {
            color: [q.color[0], q.color[1], q.color[2], 0.8],
            width: 2,
            style: "dash"
          }
        };
        graphicsLayer.add(q.graphic);
        activeSavedQuery = q;

        // Zoom to it and start move interaction
        view.goTo(q.geometry.extent.expand(1.5)).then(function () {
          sketchVM.update(q.graphic);
        });

        currentGeometry = q.geometry;
        queryPopulation(q.geometry);
      });
      item.style.cursor = "pointer";

      item.appendChild(swatch);
      item.appendChild(info);
      item.appendChild(del);
      savedQueryList.appendChild(item);
    });

    if (savedQueries.length >= 5) {
      saveQueryBtn.disabled = true;
    }
  }

  // ========== Marching Dashes Animation ==========
  var dashOffset = 0;
  var originalSymbolColors = new Map();

  // Convert simple-fill color (alpha 0–1) to CIM color (alpha 0–255)
  function toCIMColor(c) {
    if (!c) return [255, 255, 255, 204];
    var r, g, b, a;
    if (Array.isArray(c)) {
      r = c[0]; g = c[1]; b = c[2];
      a = c[3] !== undefined ? c[3] : 1;
    } else {
      r = c.r; g = c.g; b = c.b;
      a = c.a !== undefined ? c.a : 1;
    }
    return [r, g, b, Math.round((a <= 1 ? a : a / 255) * 255)];
  }

  setInterval(function () {
    dashOffset = (dashOffset + 0.5) % 12;

    function animateGraphics(layer) {
      layer.graphics.forEach(function (graphic) {
        // Capture original colors on first encounter
        if (!originalSymbolColors.has(graphic)) {
          var sym = graphic.symbol;
          if (!sym || sym.type === "CIMSymbolReference") return;
          originalSymbolColors.set(graphic, {
            fill: toCIMColor(sym.color),
            outline: toCIMColor(sym.outline && sym.outline.color),
            width: (sym.outline && sym.outline.width) || 2
          });
        }

        var colors = originalSymbolColors.get(graphic);
        if (!colors) return;

        graphic.symbol = {
          type: "CIMSymbolReference",
          symbol: {
            type: "CIMPolygonSymbol",
            symbolLayers: [
              {
                type: "CIMSolidFill",
                enable: true,
                color: colors.fill
              },
              {
                type: "CIMSolidStroke",
                enable: true,
                color: colors.outline,
                width: colors.width,
                effects: [
                  {
                    type: "CIMGeometricEffectDashes",
                    dashTemplate: [8, 4],
                    lineDashEnding: "NoConstraint",
                    offsetAlongLine: dashOffset
                  }
                ]
              }
            ]
          }
        };
      });
    }

    animateGraphics(drawGraphicsLayer);
    animateGraphics(savedGraphicsLayer);
  }, 60);

  function removeQuery(id) {
    var idx = savedQueries.findIndex(function (q) { return q.id === id; });
    if (idx === -1) return;

    var q = savedQueries[idx];
    savedGraphicsLayer.remove(q.graphic);
    savedQueries.splice(idx, 1);
    renderSavedQueries();

    if (bufferCenter && savedQueries.length < 5) {
      saveQueryBtn.disabled = false;
    }
  }

});
