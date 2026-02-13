require([
  "esri/Map",
  "esri/views/MapView",
  "esri/widgets/Search",
  "esri/widgets/Locate",
  "esri/widgets/BasemapToggle",
  "esri/widgets/ScaleBar"
], function (Map, MapView, Search, Locate, BasemapToggle, ScaleBar) {

  const map = new Map({
    basemap: "dark-gray-vector"
  });

  const view = new MapView({
    container: "viewDiv",
    map: map,
    center: [-98.5795, 39.8283], // Center of the US
    zoom: 5
  });

  // Search widget — top right
  const search = new Search({ view: view });
  view.ui.add(search, "top-right");

  // Locate widget — find user's location
  const locate = new Locate({ view: view });
  view.ui.add(locate, "top-left");

  // Basemap toggle — switch between dark and satellite
  const basemapToggle = new BasemapToggle({
    view: view,
    nextBasemap: "satellite"
  });
  view.ui.add(basemapToggle, "bottom-right");

  // Scale bar
  const scaleBar = new ScaleBar({
    view: view,
    unit: "dual"
  });
  view.ui.add(scaleBar, "bottom-left");
});
