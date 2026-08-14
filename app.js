import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const { PDFDocument } = PDFLib;

const state = {
  pdf: null,
  doc: null, // pdf-lib doc (loaded lazily for split/compress)
  fileBuffer: null,
  fileName: "document.pdf",
  baseName: "document",
  numPages: 0,
  page: 1,
  zoom: 1, // multiplier (1 = 100%)
  renderTask: null,
  thumbRenders: [],
  splitOutputs: [], // { blob, name, size }
  compressBlob: null,
  ocrBusy: false,
};

const $ = (id) => document.getElementById(id);

const els = {
  dropzone: $("dropzone"),
  workspace: $("workspace"),
  fileInput: $("file-input"),
  btnUpload: $("btn-upload"),
  fileChip: $("file-chip"),
  fileChipName: $("file-chip-name"),
  fileChipMeta: $("file-chip-meta"),

  canvas: $("pdf-canvas"),
  canvasScroll: $("canvas-scroll"),
  canvasEmpty: $("canvas-empty"),
  pageInput: $("page-input"),
  pageCount: $("page-count"),
  btnPrev: $("btn-prev"),
  btnNext: $("btn-next"),
  zoomSlider: $("zoom-slider"),
  zoomLabel: $("zoom-label"),
  btnZoomIn: $("btn-zoom-in"),
  btnZoomOut: $("btn-zoom-out"),
  btnFit: $("btn-fit"),
  thumbs: $("thumbs"),

  toast: $("toast"),
};

/* ---------------- Helpers ---------------- */
function toast(msg, kind = "") {
  els.toast.textContent = msg;
  els.toast.className = "toast " + kind;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (els.toast.hidden = true), 3000);
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (bytes >= 1024 && i < u.length - 1) {
    bytes /= 1024;
    i++;
  }
  return bytes.toFixed(i === 0 ? 0 : 1) + " " + u[i];
}

function setProgress(barEl, pct) {
  barEl.style.width = Math.min(100, Math.max(0, pct)) + "%";
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function readFile(file) {
  return file.arrayBuffer();
}

async function ensureDoc() {
  if (state.doc) return state.doc;
  if (!state.fileBuffer) throw new Error("No file loaded.");
  state.doc = await PDFDocument.load(state.fileBuffer, { ignoreEncryption: true });
  return state.doc;
}

/* ---------------- File loading ---------------- */
async function loadFile(file) {
  if (!file || file.type !== "application/pdf") {
    if (file) toast("Please choose a PDF file.", "error");
    return;
  }

  state.fileName = file.name;
  state.baseName = file.name.replace(/\.pdf$/i, "");
  const buf = await readFile(file);

  try {
    // pdf.js transfers its input buffer to a worker (detaching it),
    // so hand it a copy and keep `buf` intact for pdf-lib.
    const task = pdfjsLib.getDocument({ data: buf.slice(0) });
    state.pdf = await task.promise;
    state.numPages = state.pdf.numPages;
    state.page = 1;
    state.zoom = 1;
  } catch (err) {
    console.error(err);
    toast("Could not open this PDF.", "error");
    return;
  }

  // Keep buffer + reset the pdf-lib doc (loaded lazily on demand)
  state.fileBuffer = buf;
  state.doc = null;

  // UI
  els.fileChip.hidden = false;
  els.fileChipName.textContent = state.fileName;
  els.fileChipMeta.textContent = `${state.numPages} pages · ${fmtSize(file.size)}`;
  els.dropzone.hidden = true;
  els.workspace.hidden = false;

  els.pageInput.value = 1;
  els.pageInput.max = state.numPages;
  els.pageCount.textContent = state.numPages;
  els.zoomSlider.value = 100;
  els.zoomLabel.textContent = "100%";

  // Reset side panels
  $("text-output").value = "";
  $("text-meta").hidden = true;
  $("btn-copy-text").hidden = true;
  $("btn-download-text").hidden = true;
  $("ocr-output").value = "";
  $("btn-copy-ocr").hidden = true;
  $("btn-download-ocr").hidden = true;
  $("split-results").innerHTML = "";
  $("btn-download-zip").hidden = true;
  $("compress-result").hidden = true;

  await renderThumbs();
  await renderPage();
}

/* ---------------- Rendering ---------------- */
async function renderPage() {
  if (!state.pdf) return;
  const page = await state.pdf.getPage(state.page);
  const dpr = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: state.zoom * dpr });
  const canvas = els.canvas;
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = viewport.width / dpr + "px";
  canvas.style.height = viewport.height / dpr + "px";
  els.canvasEmpty.hidden = true;

  if (state.renderTask) state.renderTask.cancel();
  const ctx = canvas.getContext("2d");
  state.renderTask = page.render({ canvasContext: ctx, viewport });
  try {
    await state.renderTask.promise;
  } catch (e) {
    /* cancelled */
  }
  updateThumbActive();
}

async function renderThumbs() {
  els.thumbs.innerHTML = "";
  state.thumbRenders = [];
  const count = Math.min(state.numPages, 100);
  for (let i = 1; i <= count; i++) {
    const page = await state.pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = 140 / base.width;
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    wrap.dataset.page = i;
    const label = document.createElement("span");
    label.className = "thumb-label";
    label.textContent = i;
    wrap.appendChild(canvas);
    wrap.appendChild(label);
    wrap.addEventListener("click", () => goToPage(i));
    els.thumbs.appendChild(wrap);
    page.render({ canvasContext: canvas.getContext("2d"), viewport: vp });
  }
  updateThumbActive();
}

function updateThumbActive() {
  document.querySelectorAll(".thumb").forEach((t) => {
    t.classList.toggle("active", Number(t.dataset.page) === state.page);
  });
}

async function goToPage(n) {
  if (!state.pdf) return;
  n = Math.max(1, Math.min(state.numPages, n));
  if (n === state.page) return;
  state.page = n;
  els.pageInput.value = n;
  await renderPage();
}

function setZoom(pct) {
  pct = Math.max(25, Math.min(400, pct));
  state.zoom = pct / 100;
  els.zoomSlider.value = pct;
  els.zoomLabel.textContent = pct + "%";
  renderPage();
}

async function fitWidth() {
  if (!state.pdf) return;
  const page = await state.pdf.getPage(state.page);
  const vp1 = page.getViewport({ scale: 1 });
  const avail = els.canvasScroll.clientWidth - 60;
  const pct = Math.round((avail / vp1.width) * 100);
  setZoom(pct);
}

/* ---------------- Viewer controls ---------------- */
els.btnPrev.addEventListener("click", () => goToPage(state.page - 1));
els.btnNext.addEventListener("click", () => goToPage(state.page + 1));
els.pageInput.addEventListener("change", () => goToPage(Number(els.pageInput.value)));
els.btnZoomIn.addEventListener("click", () => setZoom(Math.round(state.zoom * 100) + 15));
els.btnZoomOut.addEventListener("click", () => setZoom(Math.round(state.zoom * 100) - 15));
els.btnFit.addEventListener("click", fitWidth);
els.zoomSlider.addEventListener("input", () => setZoom(Number(els.zoomSlider.value)));

window.addEventListener("keydown", (e) => {
  if (!state.pdf) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") return;
  if (e.key === "ArrowLeft") goToPage(state.page - 1);
  else if (e.key === "ArrowRight") goToPage(state.page + 1);
});

els.canvasScroll.addEventListener("wheel", (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 15 : -15;
  setZoom(Math.round(state.zoom * 100) + delta);
}, { passive: false });

/* ---------------- Tabs ---------------- */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    document.querySelector(`.panel[data-panel="${target}"]`).classList.add("active");
  });
});

/* ---------------- File upload ---------------- */
els.btnUpload.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => loadFile(els.fileInput.files[0]));

["dragenter", "dragover"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("dragging");
  })
);
["dragleave", "drop"].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("dragging");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  loadFile(file);
});

// Also allow drag & drop onto the whole window
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});

/* ---------------- Extract text ---------------- */
$("btn-extract").addEventListener("click", async () => {
  if (!state.pdf) return;
  const btn = $("btn-extract");
  const progress = $("text-progress");
  btn.disabled = true;
  progress.hidden = false;
  setProgress(progress.querySelector(".progress-bar"), 5);

  let full = "";
  for (let i = 1; i <= state.numPages; i++) {
    const page = await state.pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => it.str).join(" ");
    full += (i > 1 ? "\n\n" : "") + `--- Page ${i} ---\n` + text.trim();
    setProgress(progress.querySelector(".progress-bar"), (i / state.numPages) * 100);
  }

  $("text-output").value = full;
  $("text-meta").textContent = `${state.numPages} pages · ${full.length.toLocaleString()} characters`;
  $("text-meta").hidden = false;
  $("btn-copy-text").hidden = false;
  $("btn-download-text").hidden = false;
  progress.hidden = true;
  btn.disabled = false;
  toast(full.trim() ? "Text extracted." : "No embedded text found — try OCR instead.", full.trim() ? "ok" : "error");
});

$("btn-copy-text").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("text-output").value);
  toast("Copied to clipboard.", "ok");
});

$("btn-download-text").addEventListener("click", () => {
  const blob = new Blob([$("text-output").value], { type: "text/plain" });
  downloadBlob(blob, state.baseName + "-text.txt");
});

/* ---------------- OCR ---------------- */
async function renderPageToCanvas(pageNum, scale) {
  const page = await state.pdf.getPage(pageNum);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width;
  canvas.height = vp.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return canvas;
}

$("btn-ocr").addEventListener("click", async () => {
  if (!state.pdf || state.ocrBusy) return;
  state.ocrBusy = true;
  const btn = $("btn-ocr");
  const lang = $("ocr-lang").value;
  const progress = $("ocr-progress");
  const bar = $("ocr-progress-bar");
  const status = $("ocr-status");
  btn.disabled = true;
  progress.hidden = false;
  status.hidden = false;

  let worker;
  try {
    status.textContent = "Loading OCR engine…";
    worker = await Tesseract.createWorker(lang, 1, { logger: () => {} });
    let full = "";
    for (let i = 1; i <= state.numPages; i++) {
      status.textContent = `Recognizing page ${i} of ${state.numPages}…`;
      const canvas = await renderPageToCanvas(i, 2.5);
      const { data } = await worker.recognize(canvas);
      full += (i > 1 ? "\n\n" : "") + `--- Page ${i} ---\n` + (data.text || "").trim();
      setProgress(bar, (i / state.numPages) * 100);
    }
    $("ocr-output").value = full;
    $("btn-copy-ocr").hidden = false;
    $("btn-download-ocr").hidden = false;
    toast("OCR complete.", "ok");
  } catch (err) {
    console.error(err);
    toast("OCR failed. Check your connection (language data is downloaded on first use).", "error");
  } finally {
    if (worker) await worker.terminate();
    btn.disabled = false;
    progress.hidden = true;
    status.hidden = true;
    state.ocrBusy = false;
  }
});

$("btn-copy-ocr").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("ocr-output").value);
  toast("Copied to clipboard.", "ok");
});

$("btn-download-ocr").addEventListener("click", () => {
  const blob = new Blob([$("ocr-output").value], { type: "text/plain" });
  downloadBlob(blob, state.baseName + "-ocr.txt");
});

/* ---------------- Split ---------------- */
const splitModeAll = document.querySelector('input[name="split-mode"][value="all"]');
const splitModeRanges = document.querySelector('input[name="split-mode"][value="ranges"]');
splitModeAll.addEventListener("change", () => ($("ranges-field").hidden = true));
splitModeRanges.addEventListener("change", () => ($("ranges-field").hidden = false));

function parseRanges(str) {
  const indices = [];
  const parts = str.split(",").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((n) => Number(n.trim()));
      if (isNaN(a) || isNaN(b)) throw new Error("Invalid range: " + part);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) indices.push(i);
    } else {
      const n = Number(part);
      if (isNaN(n)) throw new Error("Invalid page: " + part);
      indices.push(n);
    }
  }
  return indices.filter((n) => n >= 1 && n <= state.numPages);
}

function splitIntoRanges(indices) {
  const ranges = [];
  let start = indices[0], prev = indices[0];
  for (let i = 1; i <= indices.length; i++) {
    if (i === indices.length || indices[i] !== prev + 1) {
      ranges.push([start, prev]);
      start = indices[i];
    }
    prev = indices[i];
  }
  return ranges;
}

$("btn-split").addEventListener("click", async () => {
  if (!state.pdf) return;
  const btn = $("btn-split");
  const progress = $("split-progress");
  const bar = progress.querySelector(".progress-bar");
  const results = $("split-results");
  btn.disabled = true;
  progress.hidden = false;
  results.innerHTML = "";
  $("btn-download-zip").hidden = true;
  state.splitOutputs = [];

  let doc;
  try {
    doc = await ensureDoc();
  } catch (err) {
    console.error("pdf-lib failed to open document:", err);
    toast("Could not prepare this PDF for splitting: " + (err?.message || "unsupported PDF"), "error");
    btn.disabled = false;
    progress.hidden = true;
    return;
  }

  let ranges;
  const mode = document.querySelector('input[name="split-mode"]:checked').value;
  if (mode === "all") {
    ranges = Array.from({ length: state.numPages }, (_, i) => [i + 1, i + 1]);
  } else {
    try {
      const indices = parseRanges($("ranges-input").value);
      if (!indices.length) throw new Error("No valid pages.");
      ranges = splitIntoRanges(indices);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      progress.hidden = true;
      return;
    }
  }

  try {
    for (let r = 0; r < ranges.length; r++) {
      const [from, to] = ranges[r];
      const out = await PDFDocument.create();
      const idx = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
      const pages = await out.copyPages(doc, idx);
      pages.forEach((p) => out.addPage(p));
      const bytes = await out.save({ useObjectStreams: true });
      const blob = new Blob([bytes], { type: "application/pdf" });
      const name = ranges.length === 1 && from === to
        ? `${state.baseName}-page-${from}.pdf`
        : `${state.baseName}-pages-${from}-${to}.pdf`;
      state.splitOutputs.push({ blob, name, size: blob.size });
      setProgress(bar, ((r + 1) / ranges.length) * 100);
    }

    renderSplitResults();
    $("btn-download-zip").hidden = false;
    toast(`Split into ${ranges.length} file(s).`, "ok");
  } catch (err) {
    console.error(err);
    toast("Split failed.", "error");
  } finally {
    btn.disabled = false;
    progress.hidden = true;
  }
});

function renderSplitResults() {
  const results = $("split-results");
  results.innerHTML = "";
  state.splitOutputs.forEach((out, i) => {
    const item = document.createElement("div");
    item.className = "split-item";
    const name = document.createElement("span");
    name.className = "split-name";
    name.textContent = out.name;
    const size = document.createElement("span");
    size.className = "split-size";
    size.textContent = fmtSize(out.size);
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "Save";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      downloadBlob(out.blob, out.name);
    });
    item.appendChild(name);
    item.appendChild(size);
    item.appendChild(link);
    results.appendChild(item);
  });
}

$("btn-download-zip").addEventListener("click", async () => {
  const zip = new JSZip();
  state.splitOutputs.forEach((out) => zip.file(out.name, out.blob));
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, state.baseName + "-split.zip");
  toast("ZIP downloaded.", "ok");
});

/* ---------------- Compress ---------------- */
const compressLossless = document.querySelector('input[name="compress-mode"][value="lossless"]');
const compressRaster = document.querySelector('input[name="compress-mode"][value="rasterize"]');
compressLossless.addEventListener("change", () => ($("quality-field").hidden = true));
compressRaster.addEventListener("change", () => ($("quality-field").hidden = false));
$("quality-slider").addEventListener("input", () => ($("quality-label").textContent = $("quality-slider").value + "%"));

$("btn-compress").addEventListener("click", async () => {
  if (!state.pdf) return;
  const btn = $("btn-compress");
  const progress = $("compress-progress");
  const bar = progress.querySelector(".progress-bar");
  btn.disabled = true;
  progress.hidden = false;
  $("compress-result").hidden = true;
  setProgress(bar, 5);

  const originalSize = (await state.pdf.getData()).byteLength;
  const mode = document.querySelector('input[name="compress-mode"]:checked').value;

  let doc;
  if (mode === "lossless") {
    try {
      doc = await ensureDoc();
    } catch (err) {
      console.error("pdf-lib failed to open document:", err);
      toast("Could not prepare this PDF for compression: " + (err?.message || "unsupported PDF"), "error");
      btn.disabled = false;
      progress.hidden = true;
      return;
    }
  }

  try {
    let bytes;
    if (mode === "lossless") {
      const out = await PDFDocument.create();
      const pages = await out.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      bytes = await out.save({ useObjectStreams: true });
      setProgress(bar, 100);
    } else {
      const quality = Number($("quality-slider").value) / 100;
      const out = await PDFDocument.create();
      for (let i = 1; i <= state.numPages; i++) {
        const page = await state.pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const renderScale = Math.max(1, 150 / vp.width); // ~150 DPI
        const canvas = await renderPageToCanvas(i, renderScale);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const img = await out.embedJpg(dataUrl);
        const p = out.addPage([vp.width, vp.height]);
        p.drawImage(img, { x: 0, y: 0, width: vp.width, height: vp.height });
        setProgress(bar, (i / state.numPages) * 100);
      }
      bytes = await out.save({ useObjectStreams: true });
    }

    const blob = new Blob([bytes], { type: "application/pdf" });
    state.compressBlob = blob;

    const pct = Math.round((1 - blob.size / originalSize) * 100);
    $("size-before").textContent = fmtSize(originalSize);
    $("size-after").textContent = fmtSize(blob.size);
    $("size-saved").textContent = pct + "% (" + fmtSize(originalSize - blob.size) + ")";
    $("compress-result").hidden = false;
    toast(pct > 0 ? `Shrunk by ${pct}%.` : "File is already well-compressed.", pct > 0 ? "ok" : "");
  } catch (err) {
    console.error(err);
    toast("Compression failed.", "error");
  } finally {
    btn.disabled = false;
    progress.hidden = true;
  }
});

$("btn-download-compressed").addEventListener("click", () => {
  if (state.compressBlob) downloadBlob(state.compressBlob, state.baseName + "-compressed.pdf");
});
