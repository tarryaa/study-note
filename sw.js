// Service Worker：オフラインでも起動できるようにアプリ本体をキャッシュ
// ★ ファイルを更新して GitHub に上げたら、VERSION の数字を上げてください（iPad 側に「更新」が出ます）
const VERSION = 'v1.6.1';
const CACHE = 'benkyo-note-' + VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/util.js',
  './js/icons.js',
  './js/db.js',
  './js/settings.js',
  './js/store.js',
  './js/ink.js',
  './js/scribble.js',
  './js/shapes.js',
  './js/render.js',
  './js/engine.js',
  './js/ui.js',
  './js/pickers.js',
  './js/exporter.js',
  './js/editor.js',
  './js/pdf-import.js',
  './js/library.js',
  './js/panels.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './js/vendor/pdfjs/cmaps/78-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/78-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/78-H.bcmap',
  './js/vendor/pdfjs/cmaps/78-RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/78-RKSJ-V.bcmap',
  './js/vendor/pdfjs/cmaps/78-V.bcmap',
  './js/vendor/pdfjs/cmaps/78ms-RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/78ms-RKSJ-V.bcmap',
  './js/vendor/pdfjs/cmaps/83pv-RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/90ms-RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/90ms-RKSJ-V.bcmap',
  './js/vendor/pdfjs/cmaps/90msp-RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/90msp-RKSJ-V.bcmap',
  './js/vendor/pdfjs/cmaps/90pv-RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/90pv-RKSJ-V.bcmap',
  './js/vendor/pdfjs/cmaps/Add-H.bcmap',
  './js/vendor/pdfjs/cmaps/Add-RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/Add-RKSJ-V.bcmap',
  './js/vendor/pdfjs/cmaps/Add-V.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-CNS1-0.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-CNS1-1.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-CNS1-2.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-CNS1-3.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-CNS1-4.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-CNS1-5.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-CNS1-6.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-GB1-0.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-GB1-1.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-GB1-2.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-GB1-3.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-GB1-4.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-GB1-5.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Japan1-0.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Japan1-1.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Japan1-2.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Japan1-3.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Japan1-4.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Japan1-5.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Japan1-6.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Korea1-0.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Korea1-1.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Korea1-2.bcmap',
  './js/vendor/pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap',
  './js/vendor/pdfjs/cmaps/B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/B5pc-H.bcmap',
  './js/vendor/pdfjs/cmaps/B5pc-V.bcmap',
  './js/vendor/pdfjs/cmaps/CNS-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/CNS-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/CNS1-H.bcmap',
  './js/vendor/pdfjs/cmaps/CNS1-V.bcmap',
  './js/vendor/pdfjs/cmaps/CNS2-H.bcmap',
  './js/vendor/pdfjs/cmaps/CNS2-V.bcmap',
  './js/vendor/pdfjs/cmaps/ETen-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/ETen-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/ETenms-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/ETenms-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/ETHK-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/ETHK-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/Ext-H.bcmap',
  './js/vendor/pdfjs/cmaps/Ext-RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/Ext-RKSJ-V.bcmap',
  './js/vendor/pdfjs/cmaps/Ext-V.bcmap',
  './js/vendor/pdfjs/cmaps/GB-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/GB-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/GB-H.bcmap',
  './js/vendor/pdfjs/cmaps/GB-V.bcmap',
  './js/vendor/pdfjs/cmaps/GBK-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/GBK-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/GBK2K-H.bcmap',
  './js/vendor/pdfjs/cmaps/GBK2K-V.bcmap',
  './js/vendor/pdfjs/cmaps/GBKp-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/GBKp-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/GBpc-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/GBpc-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/GBT-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/GBT-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/GBT-H.bcmap',
  './js/vendor/pdfjs/cmaps/GBT-V.bcmap',
  './js/vendor/pdfjs/cmaps/GBTpc-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/GBTpc-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/H.bcmap',
  './js/vendor/pdfjs/cmaps/Hankaku.bcmap',
  './js/vendor/pdfjs/cmaps/Hiragana.bcmap',
  './js/vendor/pdfjs/cmaps/HKdla-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/HKdla-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/HKdlb-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/HKdlb-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/HKgccs-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/HKgccs-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/HKm314-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/HKm314-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/HKm471-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/HKm471-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/HKscs-B5-H.bcmap',
  './js/vendor/pdfjs/cmaps/HKscs-B5-V.bcmap',
  './js/vendor/pdfjs/cmaps/Katakana.bcmap',
  './js/vendor/pdfjs/cmaps/KSC-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/KSC-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/KSC-H.bcmap',
  './js/vendor/pdfjs/cmaps/KSC-Johab-H.bcmap',
  './js/vendor/pdfjs/cmaps/KSC-Johab-V.bcmap',
  './js/vendor/pdfjs/cmaps/KSC-V.bcmap',
  './js/vendor/pdfjs/cmaps/KSCms-UHC-H.bcmap',
  './js/vendor/pdfjs/cmaps/KSCms-UHC-HW-H.bcmap',
  './js/vendor/pdfjs/cmaps/KSCms-UHC-HW-V.bcmap',
  './js/vendor/pdfjs/cmaps/KSCms-UHC-V.bcmap',
  './js/vendor/pdfjs/cmaps/KSCpc-EUC-H.bcmap',
  './js/vendor/pdfjs/cmaps/KSCpc-EUC-V.bcmap',
  './js/vendor/pdfjs/cmaps/LICENSE',
  './js/vendor/pdfjs/cmaps/NWP-H.bcmap',
  './js/vendor/pdfjs/cmaps/NWP-V.bcmap',
  './js/vendor/pdfjs/cmaps/RKSJ-H.bcmap',
  './js/vendor/pdfjs/cmaps/RKSJ-V.bcmap',
  './js/vendor/pdfjs/cmaps/Roman.bcmap',
  './js/vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniCNS-UCS2-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniCNS-UTF16-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniCNS-UTF16-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniCNS-UTF32-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniCNS-UTF32-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniCNS-UTF8-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniCNS-UTF8-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniGB-UCS2-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniGB-UTF16-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniGB-UTF16-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniGB-UTF32-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniGB-UTF32-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniGB-UTF8-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniGB-UTF8-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UCS2-HW-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UCS2-HW-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UCS2-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UTF16-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UTF16-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UTF32-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UTF32-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UTF8-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS-UTF8-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS2004-UTF16-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS2004-UTF16-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS2004-UTF32-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS2004-UTF32-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS2004-UTF8-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJIS2004-UTF8-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJISPro-UCS2-HW-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJISPro-UCS2-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJISPro-UTF8-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJISX0213-UTF32-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJISX0213-UTF32-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniJISX02132004-UTF32-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniJISX02132004-UTF32-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniKS-UCS2-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniKS-UCS2-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniKS-UTF16-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniKS-UTF16-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniKS-UTF32-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniKS-UTF32-V.bcmap',
  './js/vendor/pdfjs/cmaps/UniKS-UTF8-H.bcmap',
  './js/vendor/pdfjs/cmaps/UniKS-UTF8-V.bcmap',
  './js/vendor/pdfjs/cmaps/V.bcmap',
  './js/vendor/pdfjs/cmaps/WP-Symbol.bcmap',
  './js/vendor/pdfjs/standard_fonts/FoxitDingbats.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitSerif.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb',
  './js/vendor/pdfjs/standard_fonts/FoxitSymbol.pfb',
  './js/vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf',
  './js/vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf',
  './js/vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf',
  './js/vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
  './js/vendor/pdfjs/standard_fonts/LICENSE_FOXIT',
  './js/vendor/pdfjs/standard_fonts/LICENSE_LIBERATION',
  './js/vendor/pdfjs/wasm/jbig2_nowasm_fallback.js',
  './js/vendor/pdfjs/wasm/jbig2.wasm',
  './js/vendor/pdfjs/wasm/LICENSE_JBIG2',
  './js/vendor/pdfjs/wasm/LICENSE_OPENJPEG',
  './js/vendor/pdfjs/wasm/LICENSE_PDFJS_JBIG2',
  './js/vendor/pdfjs/wasm/LICENSE_PDFJS_OPENJPEG',
  './js/vendor/pdfjs/wasm/LICENSE_PDFJS_QCMS',
  './js/vendor/pdfjs/wasm/LICENSE_QCMS',
  './js/vendor/pdfjs/wasm/openjpeg_nowasm_fallback.js',
  './js/vendor/pdfjs/wasm/openjpeg.wasm',
  './js/vendor/pdfjs/wasm/qcms_bg.wasm',
  './js/vendor/pdfjs/wasm/quickjs-eval.js',
  './js/vendor/pdfjs/wasm/quickjs-eval.wasm',
  './js/vendor/pdfjs/pdf.min.mjs',
  './js/vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('benkyo-note-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        try {
          return await fetch(req);
        } catch (_) {
          if (shell) return shell;
          throw _;
        }
      }
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'basic') cache.put(req, res.clone());
        return res;
      } catch (err) {
        return Response.error();
      }
    })()
  );
});
