import { startDrag as tauriStartDrag } from '@crabnebula/tauri-plugin-drag';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ElectronAPI,
  IncomingMediaPayload,
  ShortcutConfig,
} from '../types/clip';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export async function initDesktopBridge(): Promise<void> {
  if (typeof window === 'undefined') return;
  if (window.electronAPI?.isElectron || !window.__TAURI_INTERNALS__) {
    return;
  }

  let platform = 'darwin';
  try {
    platform = await invoke<string>('app_get_platform');
  } catch {
    // Fallback to darwin
  }

  let initialClipsJson: string | null | undefined;
  try {
    initialClipsJson = await invoke<string | null>('clips_load');
  } catch {
    initialClipsJson = undefined;
  }

  const createListener = <T,>(eventName: string) => {
    return (callback: (payload: T) => void) => {
      let unlisten: (() => void) | null = null;
      let cancelled = false;
      void listen<T>(eventName, (event) => {
        if (!cancelled) callback(event.payload);
      }).then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
      return () => {
        cancelled = true;
        if (unlisten) unlisten();
      };
    };
  };

  const tauriAPI: ElectronAPI = {
    isElectron: true,
    platform,
    readClipboard: () => invoke<string>('clipboard_read'),
    importNow: () => invoke<void>('clipboard_import_now'),
    writeClipboard: (text: string) => invoke<void>('clipboard_write', { text }),
    writeImage: (payload) =>
      invoke<boolean>('clipboard_write_image', {
        localPath: payload.localPath ?? null,
        dataUrl: payload.dataUrl ?? null,
      }),
    writeFile: (localPath: string) =>
      invoke<boolean>('clipboard_write_file', { localPath }),
    saveMedia: (payload) =>
      invoke<{
        localPath: string;
        sizeBytes: number;
        width?: number;
        height?: number;
        dataUrl?: string;
      }>('media_save', {
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        bytes: payload.bytes,
      }),
    deleteMedia: (localPath: string) =>
      invoke<boolean>('media_delete', { localPath }),
    showInFinder: (localPath: string) =>
      invoke<boolean>('media_show_in_finder', { localPath }),
    openFile: (localPath: string) =>
      invoke<boolean>('media_open_file', { localPath }),
    getAutoLaunch: () => invoke<boolean>('app_get_auto_launch'),
    setAutoLaunch: (enabled: boolean) =>
      invoke<boolean>('app_set_auto_launch', { enabled }),
    loadClips: () => invoke<string | null>('clips_load'),
    saveClips: (clipsJson: string) =>
      invoke<void>('clips_save', { clipsJson }),
    initialClipsJson,
    hideDrawer: () => invoke<void>('drawer_hide'),
    getShortcuts: () => invoke<ShortcutConfig>('app_get_shortcuts'),
    setShortcuts: (config) =>
      invoke<ShortcutConfig>('app_set_shortcuts', {
        toggleShortcut: config.toggleShortcut,
        drawerShortcut: config.drawerShortcut,
      }),
    startDrag: (payload) => tauriStartDrag(payload),
    onClipboardChange: createListener<string>('clipboard:changed'),
    onMediaClipboardChange: createListener<IncomingMediaPayload>(
      'clipboard:media-changed',
    ),
    onShortcutTrigger: createListener<string>('shortcut:trigger'),
    onDrawerOpen: createListener<void>('drawer:open'),
    onDrawerClose: createListener<void>('drawer:close'),
    onClipsUpdated: createListener<void>('clips:updated'),
    onOpenShortcutSettings: createListener<void>('shortcuts:open-settings'),
    onShortcutsUpdated: createListener<ShortcutConfig>('shortcuts:updated'),
  };

  window.electronAPI = tauriAPI;
}
