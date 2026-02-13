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

  // --- State ---
  let bufferCenter = null;
  let bufferRadius = 2;
  let bufferGraphic = null;
  let sketchVM = null;
  let popLayerView = null;
  let queryAbortController = null;

  // --- UI references ---
  const popValueEl = document.getElementById("popValue");
  const radiusSlider = document.getElementById("radiusSlider");
  const radiusLabel = document.getElementById("radiusLabel");

  // --- Layers ---
  const graphicsLayer = new GraphicsLayer();

  const popLayer = new FeatureLayer({
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

  // --- Map & View ---
  const map = new Map({
    basemap: "dark-gray-vector",
    layers: [popLayer, graphicsLayer]
  });

  const view = new MapView({
    container: "viewDiv",
    map: map,
    center: [174.7633, -36.8485],
    zoom: 10
  });

  // --- Widgets ---
  view.ui.add(new Search({ view }), "top-left");
  view.ui.add(new Locate({ view }), "top-left");
  view.ui.add(new BasemapToggle({ view, nextBasemap: "satellite" }), "bottom-right");

  // --- Get layer view for client-side queries ---
  view.whenLayerView(popLayer).then(function (lv) {
    popLayerView = lv;
  });

  // --- SketchViewModel for dragging ---
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
    if (event.state === "cancel" || event.state === "complete") return;

    var updatedGraphic = event.graphics[0];
    if (!updatedGraphic) return;

    bufferGraphic = updatedGraphic;
    // Derive center from the updated buffer geometry
    bufferCenter = updatedGraphic.geometry.centroid;
    queryPopulation(updatedGraphic.geometry);
  });

  // --- Map click handler ---
  view.on("click", function (event) {
    // Don't place a new buffer if user is dragging
    if (sketchVM.state === "active") return;

    bufferCenter = event.mapPoint;
    placeBuffer();
  });

  // --- Radius slider ---
  radiusSlider.addEventListener("input", function () {
    bufferRadius = parseFloat(this.value);
    radiusLabel.textContent = bufferRadius.toFixed(1);
    if (bufferCenter) {
      placeBuffer();
    }
  });

  // --- Place / replace the buffer circle ---
  function placeBuffer() {
    // Cancel any active sketching first
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

    // Make the buffer draggable
    sketchVM.update(bufferGraphic);

    queryPopulation(buffer);
  }

  // --- Query population within geometry ---
  function queryPopulation(geometry) {
    // Abort any in-flight query
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

    // Try client-side first, fallback to server
    if (popLayerView && !popLayerView.updating) {
      popLayerView.queryFeatures({
        ...queryParams,
        signal: signal
      }).then(handleResult).catch(function (err) {
        if (err.name === "AbortError") return;
        // Fallback to server-side
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
    popValueEl.textContent = Math.round(pop).toLocaleString();
  }
});
