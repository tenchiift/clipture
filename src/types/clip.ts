export type BuiltinClipCategory =
  | 'code'
  | 'url'
  | 'error'
  | 'secret'
  | 'note'
  | 'image'
  | 'file';

export type ClipCategory = BuiltinClipCategory | (string & {});

export type ClipKind = 'text' | 'image' | 'file';

export type QuickActionId =
  | 'explain-error'
  | 'summarize'
  | 'translate'
  | 'calendar-event'
  | 'format-code'
  | 'open-url';

export interface QuickAction {
  id: QuickActionId;
  label: string;
  description: string;
}

export interface PrivacyScanResult {
  isSensitive: boolean;
  reason: string | null;
  maskedPreview: string;
  riskLevel: 'none' | 'medium' | 'high';
}

export interface MediaMeta {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  localPath?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
}

export interface IncomingMediaPayload {
  kind: 'image' | 'file';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  localPath?: string;
  dataUrl?: string;
  width?: number;
  height?: number;
}

export interface ClipItem {
  id: string;
  kind: ClipKind;
  content: string;
  title?: string;
  category: ClipCategory;
  tags: string[];
  isSensitive: boolean;
  privacyReason: string | null;
  maskedPreview: string;
  aiBlocked: boolean;
  createdAt: string;
  pinned?: boolean;
  media?: MediaMeta;
}

export interface ShortcutConfig {
  toggleShortcut: string;
  drawerShortcut: string;
}

export interface ElectronAPI {
  isElectron: boolean;
  platform: string;
  readClipboard: () => Promise<string>;
  importNow: () => Promise<void>;
  writeClipboard: (text: string) => Promise<void>;
  writeImage: (payload: {
    localPath?: string;
    dataUrl?: string;
  }) => Promise<boolean>;
  writeFile: (localPath: string) => Promise<boolean>;
  saveMedia: (payload: {
    fileName: string;
    mimeType: string;
    bytes: number[];
  }) => Promise<{
    localPath: string;
    sizeBytes: number;
    width?: number;
    height?: number;
    dataUrl?: string;
  }>;
  deleteMedia: (localPath: string) => Promise<boolean>;
  showInFinder: (localPath: string) => Promise<boolean>;
  openFile: (localPath: string) => Promise<boolean>;
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<boolean>;
  loadClips?: () => Promise<string | null>;
  saveClips?: (clipsJson: string) => Promise<void>;
  initialClipsJson?: string | null;
  hideDrawer?: () => Promise<void>;
  getShortcuts?: () => Promise<ShortcutConfig>;
  setShortcuts?: (config: ShortcutConfig) => Promise<ShortcutConfig>;
  startDrag?: (payload: {
    item:
      | string[]
      | {
          data: string | Record<string, string>;
          types: string[];
        };
    icon: string;
    mode?: 'copy' | 'move';
  }) => Promise<void>;
  onClipboardChange: (callback: (text: string) => void) => () => void;
  onMediaClipboardChange: (
    callback: (media: IncomingMediaPayload) => void,
  ) => () => void;
  onShortcutTrigger?: (callback: (key: string) => void) => () => void;
  onDrawerOpen?: (callback: () => void) => () => void;
  onDrawerClose?: (callback: () => void) => () => void;
  onClipsUpdated?: (callback: () => void) => () => void;
  onOpenShortcutSettings?: (callback: () => void) => () => void;
  onShortcutsUpdated?: (callback: (cfg: ShortcutConfig) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
