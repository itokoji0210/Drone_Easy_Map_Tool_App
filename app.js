const TOKYO_STATION = [35.681236, 139.767125];
const SOURCE_TEXT = "出典：国土地理院地図を加工して作成";
const DID_SOURCE_TEXT = "人口集中地区（令和2年 総務省統計局）";
const AIRPORT_SOURCE_TEXT = "空港等の周辺空域（航空局）";
const DEFAULT_TITLE = document.title;

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true
}).setView(TOKYO_STATION, 16);

map.createPane("restrictionPane");
map.getPane("restrictionPane").style.zIndex = 350;

const tileLayer = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", {
  maxZoom: 18,
  minZoom: 5,
  crossOrigin: "anonymous",
  attribution: SOURCE_TEXT
}).addTo(map);

const didLayer = L.tileLayer("https://maps.gsi.go.jp/xyz/did2020/{z}/{x}/{y}.png", {
  maxZoom: 18,
  minZoom: 8,
  crossOrigin: "anonymous",
  opacity: 0.58,
  attribution: DID_SOURCE_TEXT
}).addTo(map);

const airportLayer = L.geoJSON(null, {
  pane: "restrictionPane",
  style: {
    color: "#16803a",
    weight: 2,
    opacity: 0.9,
    fillColor: "#5ec269",
    fillOpacity: 0.28
  }
}).addTo(map);

const airportTileCache = new Map();
let airportRequestId = 0;

const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

L.drawLocal.draw.toolbar.buttons.polygon = "飛行範囲を描く";
L.drawLocal.draw.toolbar.actions.title = "描画をキャンセル";
L.drawLocal.draw.toolbar.actions.text = "キャンセル";
L.drawLocal.draw.toolbar.finish.title = "描画を完了";
L.drawLocal.draw.toolbar.finish.text = "完了";
L.drawLocal.draw.toolbar.undo.title = "最後の点を取り消す";
L.drawLocal.draw.toolbar.undo.text = "1点戻す";
L.drawLocal.draw.handlers.polygon.tooltip.start = "地図をタップして飛行範囲を描き始めます。";
L.drawLocal.draw.handlers.polygon.tooltip.cont = "次の点をタップします。";
L.drawLocal.draw.handlers.polygon.tooltip.end = "最初の点をタップして範囲を閉じます。";
L.drawLocal.edit.toolbar.buttons.edit = "飛行範囲を編集";
L.drawLocal.edit.toolbar.buttons.editDisabled = "編集できる飛行範囲がありません";
L.drawLocal.edit.toolbar.buttons.remove = "飛行範囲を削除";
L.drawLocal.edit.toolbar.buttons.removeDisabled = "削除できる飛行範囲がありません";
L.drawLocal.edit.toolbar.actions.save.title = "変更を保存";
L.drawLocal.edit.toolbar.actions.save.text = "保存";
L.drawLocal.edit.toolbar.actions.cancel.title = "編集をキャンセル";
L.drawLocal.edit.toolbar.actions.cancel.text = "キャンセル";
L.drawLocal.edit.toolbar.actions.clearAll.title = "すべて削除";
L.drawLocal.edit.toolbar.actions.clearAll.text = "すべて削除";
L.drawLocal.edit.handlers.edit.tooltip.text = "点をドラッグして飛行範囲を編集します。";
L.drawLocal.edit.handlers.edit.tooltip.subtext = "キャンセルで変更を戻します。";
L.drawLocal.edit.handlers.remove.tooltip.text = "削除する飛行範囲をタップします。";

let takeoffMarker = null;
let takeoffMode = false;
let statusTimer = null;
let isPrinting = false;
let labelsVisible = true;
let printViewState = null;
let previousDocumentTitle = DEFAULT_TITLE;

const takeoffIcon = L.divIcon({
  className: "takeoff-marker",
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -14]
});

const polygonOptions = {
  allowIntersection: false,
  showArea: true,
  shapeOptions: {
    color: "#145fb3",
    weight: 5,
    opacity: 0.95,
    fillColor: "#2f80d0",
    fillOpacity: 0.28
  }
};

const drawControl = new L.Control.Draw({
  position: "topleft",
  draw: {
    polyline: false,
    rectangle: false,
    circle: false,
    marker: false,
    circlemarker: false,
    polygon: polygonOptions
  },
  edit: {
    featureGroup: drawnItems,
    edit: true,
    remove: true
  }
});

map.addControl(drawControl);

const polygonDrawer = new L.Draw.Polygon(map, polygonOptions);
const elements = {
  locate: document.getElementById("locate-btn"),
  takeoff: document.getElementById("takeoff-btn"),
  draw: document.getElementById("draw-btn"),
  print: document.getElementById("print-btn"),
  clear: document.getElementById("clear-btn"),
  didLayer: document.getElementById("did-layer-toggle"),
  airportLayer: document.getElementById("airport-layer-toggle"),
  labels: document.getElementById("label-toggle"),
  status: document.getElementById("status-message"),
  createdAt: document.getElementById("created-at"),
  printCreatedAt: document.getElementById("print-created-at-title"),
  printFields: {
    coverageName: document.getElementById("print-coverage-name"),
    shootingDate: document.getElementById("print-shooting-date"),
    place: document.getElementById("print-place"),
    pilot: document.getElementById("print-pilot"),
    assistant: document.getElementById("print-assistant"),
    notes: document.getElementById("print-notes")
  },
  inputs: [
    document.getElementById("coverage-name"),
    document.getElementById("shooting-date"),
    document.getElementById("place"),
    document.getElementById("pilot"),
    document.getElementById("assistant"),
    document.getElementById("notes")
  ]
};

function formatDateForFilename(value) {
  if (value) {
    return value.replaceAll("-", "");
  }

  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("");
}

function formatDateForPrint(value) {
  if (!value) return "";
  return value.replaceAll("-", "/");
}

function sanitizeFilenamePart(value) {
  return value.trim().replace(/[\\/:*?"<>|]/g, "");
}

function buildPdfTitle() {
  const shootingDate = elements.inputs[1].value;
  const coverageName = sanitizeFilenamePart(elements.inputs[0].value || "ドローン飛行範囲図");
  const pilot = sanitizeFilenamePart(elements.inputs[3].value || "操縦者未入力");
  return `${formatDateForFilename(shootingDate)}${coverageName}（${pilot}）`;
}

function refreshPrintInfo() {
  elements.printFields.coverageName.textContent = elements.inputs[0].value || "未入力";
  elements.printFields.shootingDate.textContent = formatDateForPrint(elements.inputs[1].value) || "未入力";
  elements.printFields.place.textContent = elements.inputs[2].value || "未入力";
  elements.printFields.pilot.textContent = elements.inputs[3].value || "未入力";
  elements.printFields.assistant.textContent = elements.inputs[4].value || "未入力";
  elements.printFields.notes.textContent = elements.inputs[5].value || "なし";
}

function setPdfDocumentTitle() {
  previousDocumentTitle = document.title;
  document.title = buildPdfTitle();
}

function restoreDocumentTitle() {
  document.title = previousDocumentTitle || DEFAULT_TITLE;
}

function setTileOverlay(layer, enabled) {
  if (enabled) {
    if (!map.hasLayer(layer)) {
      map.addLayer(layer);
    }
    return;
  }

  if (map.hasLayer(layer)) {
    map.removeLayer(layer);
  }
}

function setLabelsVisible(enabled) {
  labelsVisible = enabled;
  document.body.classList.toggle("map-labels-hidden", !enabled);
}

function bindTakeoffLabel(marker) {
  marker.bindTooltip("離陸地点", {
    permanent: true,
    direction: "right",
    offset: [16, 0],
    className: "map-label takeoff-label"
  });
}

function bindFlightAreaLabel(layer) {
  layer.bindTooltip("飛行範囲", {
    permanent: true,
    direction: "center",
    className: "map-label flight-label"
  });
}

function latToTileY(lat, zoom) {
  const rad = (lat * Math.PI) / 180;
  const scale = 2 ** zoom;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale);
}

function lngToTileX(lng, zoom) {
  return Math.floor(((lng + 180) / 360) * (2 ** zoom));
}

async function loadAirportRestrictions() {
  airportRequestId += 1;
  const requestId = airportRequestId;

  if (!map.hasLayer(airportLayer) || map.getZoom() < 8) {
    airportLayer.clearLayers();
    return;
  }

  const zoom = 8;
  const bounds = map.getBounds();
  const northWest = bounds.getNorthWest();
  const southEast = bounds.getSouthEast();
  const minX = lngToTileX(northWest.lng, zoom);
  const maxX = lngToTileX(southEast.lng, zoom);
  const minY = latToTileY(northWest.lat, zoom);
  const maxY = latToTileY(southEast.lat, zoom);
  const requests = [];

  airportLayer.clearLayers();

  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      const key = `${zoom}/${x}/${y}`;
      if (!airportTileCache.has(key)) {
        const url = `https://maps.gsi.go.jp/xyz/kokuarea/${key}.geojson`;
        airportTileCache.set(
          key,
          fetch(url)
            .then((response) => (response.ok ? response.json() : null))
            .catch(() => null)
        );
      }

      requests.push(airportTileCache.get(key));
    }
  }

  const features = await Promise.all(requests);
  if (requestId !== airportRequestId || !map.hasLayer(airportLayer)) {
    return;
  }

  airportLayer.clearLayers();
  features.filter(Boolean).forEach((geojson) => airportLayer.addData(geojson));
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function refreshCreatedAt() {
  const text = `作成日時：${formatDateTime(new Date())}`;
  elements.createdAt.textContent = text;
  elements.printCreatedAt.textContent = text;
}

function showStatus(message) {
  window.clearTimeout(statusTimer);
  elements.status.textContent = message;
  elements.status.classList.add("visible");
  statusTimer = window.setTimeout(() => {
    elements.status.classList.remove("visible");
  }, 4500);
}

function redrawMapForCurrentLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        map.invalidateSize({ pan: false });
        resolve();
      });
    });
  });
}

function waitForVisibleTiles(timeout = 5000) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    function isReady() {
      const tiles = Array.from(document.querySelectorAll(".leaflet-tile"));
      const visibleTiles = tiles.filter((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      return visibleTiles.length > 0 && visibleTiles.every((tile) => (
        tile.classList.contains("leaflet-tile-error")
          || (tile.complete && tile.naturalWidth > 0 && !tile.classList.contains("leaflet-tile-loading"))
      ));
    }

    function check() {
      if (isReady() || Date.now() - startedAt >= timeout) {
        resolve();
        return;
      }

      window.setTimeout(check, 100);
    }

    check();
  });
}

async function preparePrintLayout() {
  isPrinting = true;
  printViewState = {
    center: map.getCenter(),
    zoom: map.getZoom()
  };
  refreshCreatedAt();
  refreshPrintInfo();
  setPdfDocumentTitle();
  setTakeoffMode(false);
  polygonDrawer.disable();
  document.body.classList.add("print-preparing");
  await redrawMapForCurrentLayout();
  if (takeoffMarker) {
    map.setView(takeoffMarker.getLatLng(), map.getZoom(), { animate: false });
    await redrawMapForCurrentLayout();
  }
  await loadAirportRestrictions();
  await waitForVisibleTiles();
  await redrawMapForCurrentLayout();
  await waitForVisibleTiles();
}

async function restoreScreenLayout() {
  isPrinting = false;
  document.body.classList.remove("print-preparing");
  restoreDocumentTitle();
  if (printViewState) {
    map.setView(printViewState.center, printViewState.zoom, { animate: false });
    printViewState = null;
  }
  await redrawMapForCurrentLayout();
  await loadAirportRestrictions();
}

async function downloadPdf() {
  if (!window.html2canvas || !window.jspdf?.jsPDF) {
    showStatus("PDF生成ライブラリを読み込めませんでした。通信状態を確認して再度お試しください。");
    return;
  }

  elements.print.disabled = true;
  elements.print.textContent = "作成中";
  showStatus("PDFを作成しています。地図タイルの読み込みを待っています。");

  try {
    await preparePrintLayout();

    const target = document.querySelector(".map-section");
    const canvas = await window.html2canvas(target, {
      backgroundColor: "#ffffff",
      scale: Math.min(window.devicePixelRatio || 1, 2),
      useCORS: true,
      allowTaint: false,
      logging: false,
      windowWidth: target.scrollWidth,
      windowHeight: target.scrollHeight
    });

    const pdf = new window.jspdf.jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: "a4",
      compress: true
    });
    const pageWidth = 210;
    const pageHeight = 297;
    const margin = 10;
    const maxWidth = pageWidth - margin * 2;
    const maxHeight = pageHeight - margin * 2;
    const imageWidth = maxWidth;
    const imageHeight = (canvas.height * imageWidth) / canvas.width;
    const fittedHeight = Math.min(imageHeight, maxHeight);
    const fittedWidth = imageHeight > maxHeight
      ? (canvas.width * fittedHeight) / canvas.height
      : imageWidth;
    const x = margin + (maxWidth - fittedWidth) / 2;

    pdf.addImage(
      canvas.toDataURL("image/jpeg", 0.95),
      "JPEG",
      x,
      margin,
      fittedWidth,
      fittedHeight,
      undefined,
      "FAST"
    );
    pdf.save(`${buildPdfTitle()}.pdf`);
    showStatus("PDFをダウンロードしました。");
  } catch (error) {
    console.error(error);
    showStatus("PDFの作成に失敗しました。地図を少し動かしてから再度お試しください。");
  } finally {
    await restoreScreenLayout();
    elements.print.disabled = false;
    elements.print.textContent = "PDF保存";
  }
}

function setTakeoffMode(enabled) {
  takeoffMode = enabled;
  elements.takeoff.classList.toggle("active", enabled);
  map.getContainer().style.cursor = enabled ? "crosshair" : "";
}

function placeTakeoffMarker(latlng) {
  if (takeoffMarker) {
    map.removeLayer(takeoffMarker);
  }
  takeoffMarker = L.marker(latlng, { icon: takeoffIcon })
    .addTo(map)
    .bindPopup("離陸地点");
  bindTakeoffLabel(takeoffMarker);
}

elements.locate.addEventListener("click", () => {
  if (!navigator.geolocation) {
    showStatus("このブラウザでは現在地を取得できません。");
    return;
  }

  showStatus("現在地を取得しています。");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const latlng = [position.coords.latitude, position.coords.longitude];
      map.setView(latlng, 17);
      showStatus("現在地へ移動しました。");
    },
    () => {
      showStatus("現在地を取得できませんでした。端末の位置情報設定とブラウザの許可を確認してください。");
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000
    }
  );
});

elements.takeoff.addEventListener("click", () => {
  polygonDrawer.disable();
  setTakeoffMode(true);
  showStatus("地図をタップして離陸場所を指定してください。");
});

elements.draw.addEventListener("click", () => {
  setTakeoffMode(false);
  polygonDrawer.enable();
  showStatus("地図上を順番にタップして飛行範囲を囲んでください。最後は開始点をタップします。");
});

elements.print.addEventListener("click", async () => {
  await downloadPdf();
});

elements.clear.addEventListener("click", () => {
  const ok = window.confirm("離陸場所、飛行範囲、入力欄をすべて消去します。よろしいですか？");
  if (!ok) return;

  if (takeoffMarker) {
    map.removeLayer(takeoffMarker);
    takeoffMarker = null;
  }
  drawnItems.clearLayers();
  elements.inputs.forEach((input) => {
    input.value = "";
  });
  setTakeoffMode(false);
  polygonDrawer.disable();
  refreshCreatedAt();
  showStatus("すべて消去しました。");
});

elements.didLayer.addEventListener("change", () => {
  setTileOverlay(didLayer, elements.didLayer.checked);
});

elements.airportLayer.addEventListener("change", () => {
  setTileOverlay(airportLayer, elements.airportLayer.checked);
  loadAirportRestrictions();
});

elements.labels.addEventListener("change", () => {
  setLabelsVisible(elements.labels.checked);
});

map.on("moveend zoomend", loadAirportRestrictions);

map.on("click", (event) => {
  if (!takeoffMode) return;
  placeTakeoffMarker(event.latlng);
  setTakeoffMode(false);
  showStatus("離陸場所を指定しました。");
});

map.on(L.Draw.Event.CREATED, (event) => {
  const layer = event.layer;
  bindFlightAreaLabel(layer);
  drawnItems.addLayer(layer);
  showStatus("飛行範囲を追加しました。編集・削除は地図左上の編集ボタンから行えます。");
});

window.addEventListener("beforeprint", () => {
  if (!isPrinting) {
    isPrinting = true;
    printViewState = {
      center: map.getCenter(),
      zoom: map.getZoom()
    };
    refreshCreatedAt();
    refreshPrintInfo();
    setPdfDocumentTitle();
    setTakeoffMode(false);
    polygonDrawer.disable();
    document.body.classList.add("print-preparing");
    map.invalidateSize({ pan: false });
    if (takeoffMarker) {
      map.setView(takeoffMarker.getLatLng(), map.getZoom(), { animate: false });
    }
  }
});

window.addEventListener("afterprint", () => {
  restoreScreenLayout();
});

refreshCreatedAt();
setLabelsVisible(labelsVisible);
loadAirportRestrictions();
