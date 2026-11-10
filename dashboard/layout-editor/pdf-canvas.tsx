import { useEffect, useRef, useState } from 'react';

type PdfJs = typeof import('pdfjs-dist');

let pdfjs: Promise<PdfJs> | undefined;

/** Loads pdf.js only when the editor is opened (it is a large module). */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  return pdfjs;
}

function bytesOf(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/**
 * Renders one page of the PDF (a data URL) at `scale` CSS pixels per 0.1 mm. A new PDF is drawn into a hidden
 * canvas first and swapped in when done, so the page does not flicker while the preview re-renders.
 */
export function PdfCanvas({
  pdf,
  page,
  scale,
  onError,
}: {
  pdf: string | null | undefined;
  page: number;
  scale: number;
  onError?: (e: unknown) => void;
}) {
  const canvases = [useRef<HTMLCanvasElement>(null), useRef<HTMLCanvasElement>(null)];
  const [visible, setVisible] = useState(0);
  const visibleRef = useRef(0);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    const target = canvases[1 - visibleRef.current].current;
    if (!target) return;
    (async () => {
      const lib = await loadPdfJs();
      const task = lib.getDocument({ data: bytesOf(pdf) });
      const doc = await task.promise;
      try {
        const p = await doc.getPage(Math.min(page, doc.numPages));
        // pt → 0.1 mm is 254/72; `scale` is px per 0.1 mm
        const viewport = p.getViewport({ scale: (scale * 254) / 72 });
        const ratio = window.devicePixelRatio || 1;
        const offscreen = document.createElement('canvas');
        offscreen.width = Math.floor(viewport.width * ratio);
        offscreen.height = Math.floor(viewport.height * ratio);
        await p.render({ canvas: offscreen, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined }).promise;
        if (cancelled) return;
        target.width = offscreen.width;
        target.height = offscreen.height;
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        target.getContext('2d')!.drawImage(offscreen, 0, 0);
        visibleRef.current = 1 - visibleRef.current;
        setVisible(visibleRef.current);
      } finally {
        void task.destroy();
      }
    })().catch((e) => onError?.(e));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf, page, scale]);

  return (
    <>
      {canvases.map((ref, i) => (
        <canvas
          key={i}
          ref={ref}
          className="absolute left-0 top-0"
          style={{ visibility: visible === i ? 'visible' : 'hidden' }}
          aria-hidden
        />
      ))}
    </>
  );
}
