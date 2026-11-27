import { useCallback, useEffect, useRef, useState } from 'react';
import type { IncomingMediaPayload } from '../types/clip';

const MAX_CAPTURE_BYTES = 50 * 1024 * 1024;

interface UseClipboardAdapterOptions {
  onNewTextClip: (text: string) => void;
  onNewMediaClip: (media: IncomingMediaPayload) => void;
  focusAutoImport: boolean;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function useClipboardAdapter({
  onNewTextClip,
  onNewMediaClip,
  focusAutoImport,
}: UseClipboardAdapterOptions) {
  const isElectron =
    typeof window !== 'undefined' && Boolean(window.electronAPI?.isElectron);
  const lastSeenRef = useRef<string>('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const showStatus = useCallback((msg: string, ms = 1800) => {
    setStatusMessage(msg);
    window.setTimeout(() => setStatusMessage(null), ms);
  }, []);

  const emitIfNewText = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || text === lastSeenRef.current) return;
      if (new Blob([raw]).size >= MAX_CAPTURE_BYTES) {
        showStatus('Skipped clip ≥ 50 MB');
        return;
      }
      lastSeenRef.current = text;
      onNewTextClip(raw);
    },
    [onNewTextClip, showStatus],
  );

  const ingestFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList);
      if (files.length === 0) return;

      let savedCount = 0;
      let skippedCount = 0;

      for (const file of files) {
        if (file.size >= MAX_CAPTURE_BYTES) {
          skippedCount += 1;
          continue;
        }
        const mimeType = file.type || 'application/octet-stream';
        const isImage = mimeType.startsWith('image/');
        const fileName =
          file.name || (isImage ? `pasted-image-${Date.now()}.png` : `file-${Date.now()}`);

        if (isElectron && window.electronAPI) {
          const buffer = await file.arrayBuffer();
          const saved = await window.electronAPI.saveMedia({
            fileName,
            mimeType,
            bytes: Array.from(new Uint8Array(buffer)),
          });

          onNewMediaClip({
            kind: isImage ? 'image' : 'file',
            fileName,
            mimeType,
            sizeBytes: saved.sizeBytes,
            localPath: saved.localPath,
            dataUrl: saved.dataUrl,
            width: saved.width,
            height: saved.height,
          });
        } else {
          const dataUrl = isImage ? await readFileAsDataUrl(file) : undefined;
          onNewMediaClip({
            kind: isImage ? 'image' : 'file',
            fileName,
            mimeType,
            sizeBytes: file.size,
            dataUrl,
          });
        }
        savedCount += 1;
      }

      if (skippedCount > 0 && savedCount === 0) {
        showStatus(`Skipped ${skippedCount} file${skippedCount === 1 ? '' : 's'} ≥ 50 MB`, 2400);
      } else if (skippedCount > 0) {
        showStatus(`Saved ${savedCount} locally (skipped ${skippedCount} ≥ 50 MB)`, 2400);
      } else if (savedCount > 0) {
        showStatus(
          savedCount === 1
            ? `Saved ${files[0].name || 'item'} locally`
            : `Saved ${savedCount} items locally`,
        );
      }
    },
    [isElectron, onNewMediaClip, showStatus],
  );

  // 1. Electron mode: native background OS clipboard watchers (text + images/files)
  useEffect(() => {
    if (!isElectron || !window.electronAPI) return;
    const unsubText = window.electronAPI.onClipboardChange((text) => {
      emitIfNewText(text);
    });
    const unsubMedia = window.electronAPI.onMediaClipboardChange((media) => {
      onNewMediaClip(media);
    });
    return () => {
      unsubText();
      unsubMedia();
    };
  }, [isElectron, emitIfNewText, onNewMediaClip]);

  // 2. Global Cmd+V / Ctrl+V paste listener (handles files, images, and text)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        void ingestFiles(files);
        return;
      }

      if (isTyping) return;

      const pasted = e.clipboardData?.getData('text/plain');
      if (pasted) {
        emitIfNewText(pasted);
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [emitIfNewText, ingestFiles]);

  // 3. Web fallback: window focus auto-import
  useEffect(() => {
    if (isElectron || !focusAutoImport) return;

    const handleFocus = async () => {
      if (!navigator.clipboard?.readText) return;
      try {
        const text = await navigator.clipboard.readText();
        emitIfNewText(text);
      } catch {
        // Ignore if browser permission not granted
      }
    };

    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [isElectron, focusAutoImport, emitIfNewText]);

  const copyToClipboard = useCallback(
    async (text: string) => {
      lastSeenRef.current = text.trim();
      if (isElectron && window.electronAPI) {
        await window.electronAPI.writeClipboard(text);
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      showStatus('Copied to clipboard');
    },
    [isElectron, showStatus],
  );

  const copyImageToClipboard = useCallback(
    async (localPath?: string, dataUrl?: string) => {
      if (isElectron && window.electronAPI) {
        const ok = await window.electronAPI.writeImage({ localPath, dataUrl });
        showStatus(ok ? 'Image copied to clipboard' : 'Could not copy image');
        return;
      }

      if (dataUrl && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        try {
          const res = await fetch(dataUrl);
          const blob = await res.blob();
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob }),
          ]);
          showStatus('Image copied to clipboard');
          return;
        } catch {
          // Fallback message below
        }
      }
      showStatus('Image copy works best in Desktop mode');
    },
    [isElectron, showStatus],
  );

  const copyFileToClipboard = useCallback(
    async (localPath?: string) => {
      if (isElectron && window.electronAPI && localPath) {
        const ok = await window.electronAPI.writeFile(localPath);
        showStatus(ok ? 'File copied to clipboard' : 'File not found on disk');
        return;
      }
      showStatus('File copy requires Desktop mode');
    },
    [isElectron, showStatus],
  );

  const importFromClipboardNow = useCallback(async () => {
    try {
      if (isElectron && window.electronAPI) {
        await window.electronAPI.importNow();
        return;
      }
      const text = await navigator.clipboard.readText();
      if (text?.trim()) {
        emitIfNewText(text);
      }
    } catch {
      showStatus('Press Cmd+V / Ctrl+V to paste a clip', 2200);
    }
  }, [isElectron, emitIfNewText, showStatus]);

  return {
    isElectron,
    ingestFiles,
    copyToClipboard,
    copyImageToClipboard,
    copyFileToClipboard,
    importFromClipboardNow,
    statusMessage,
  };
}
