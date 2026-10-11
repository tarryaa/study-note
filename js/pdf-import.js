// PDF.js is vendored and loaded on demand so it cannot block the app's startup.
const cmapUrl = new URL('./vendor/pdfjs/cmaps/', import.meta.url).href;
const fontUrl = new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href;
const wasmUrl = new URL('./vendor/pdfjs/wasm/', import.meta.url).href;
let pdfjsPromise;

function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('./vendor/pdfjs/pdf.min.mjs').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
      return pdfjs;
    }).catch((error) => {
      pdfjsPromise = null;
      throw error;
    });
  }
  return pdfjsPromise;
}

export function isPdfFile(file) {
  return !!file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
}

function toBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PDF page conversion failed')), 'image/png'));
}

// Render each page at up to 300 dpi (or 10 megapixels) before placing it in a note.
export async function renderPdfPages(file, { firstOnly = false } = {}) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data, cMapUrl, cMapPacked: true, standardFontDataUrl: fontUrl, wasmUrl, useSystemFonts: true });
  const doc = await task.promise;
  const pages = [];
  try {
    for (let n = 1, last = firstOnly ? 1 : doc.numPages; n <= last; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(300 / 72, 3508 / Math.max(base.width, base.height), Math.sqrt(10_000_000 / (base.width * base.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
      pages.push({ blob: await toBlob(canvas), w: canvas.width, h: canvas.height, pageNumber: n });
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
