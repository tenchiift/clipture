import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  ClipboardPaste,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  File as FileIcon,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Monitor,
  Moon,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Tag,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';
import appIcon from './assets/icon.png';
import { useClipboardAdapter } from './hooks/useClipboardAdapter';
import { getMiniDragIcon, MINI_DRAG_ICON_DATA_URL } from './lib/drag-icon';
import { classifyLocally } from './lib/local-classifier';
import { maskNonApiSecretText, scanWithPrivacyGuard } from './lib/privacy-guard';
import {
  CODE_TOKEN_CLASSES,
  tokenizeCodeLine,
} from './lib/syntax-highlight';
import type {
  BuiltinClipCategory,
  ClipCategory,
  ClipItem,
  IncomingMediaPayload,
} from './types/clip';

const STORAGE_KEY = 'ai-clipper:clips:v1';
const SOUND_STORAGE_KEY = 'ai-clipper:sound:v1';
const CUSTOM_CATEGORIES_KEY = 'ai-clipper:custom-categories:v1';
const HIDDEN_BUILTINS_KEY = 'ai-clipper:hidden-builtins:v1';
const CATEGORY_ORDER_KEY = 'ai-clipper:category-order:v1';
const SKIP_DELETE_CONFIRM_KEY = 'ai-clipper:skip-delete-confirm:v1';
const CODE_THEME_KEY = 'ai-clipper:code-theme:v1';
const MAX_BACKUP_FILE_BYTES = 5 * 1024 * 1024;

interface CustomCategory {
  id: string;
  label: string;
  badgeClass: string;
  baseType?: BuiltinClipCategory;
}

const CUSTOM_BADGE_PALETTE = [
  'bg-[#CBDDF0] text-[#1E293B] border-2 border-[#2C3038]',
  'bg-[#CBE4D3] text-[#1E293B] border-2 border-[#2C3038]',
  'bg-[#F3E8B8] text-[#1E293B] border-2 border-[#2C3038]',
  'bg-[#F4C7C3] text-[#1E293B] border-2 border-[#2C3038]',
  'bg-[#EAE6DC] text-[#1E293B] border-2 border-[#2C3038]',
];

const BUILTIN_CATEGORIES: BuiltinClipCategory[] = [
  'image',
  'file',
  'code',
  'error',
  'url',
  'secret',
  'note',
];

function playClipSound() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.exponentialRampToValueAtTime(990, now + 0.055);

    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.095);
    osc.onended = () => {
      void ctx.close();
    };
  } catch {
    // Ignore audio errors if blocked by browser autoplay policy
  }
}

const CATEGORY_META: Record<
  BuiltinClipCategory,
  { label: string; badgeClass: string }
> = {
  code: {
    label: 'Code',
    badgeClass: 'bg-[#CBDDF0] text-[#1E293B] border-2 border-[#2C3038]',
  },
  url: {
    label: 'URL',
    badgeClass: 'bg-[#CBE4D3] text-[#1E293B] border-2 border-[#2C3038]',
  },
  error: {
    label: 'Error Log',
    badgeClass: 'bg-[#F3E8B8] text-[#1E293B] border-2 border-[#2C3038]',
  },
  secret: {
    label: 'Secret',
    badgeClass: 'bg-[#F4C7C3] text-[#1E293B] border-2 border-[#2C3038]',
  },
  image: {
    label: 'Image',
    badgeClass: 'bg-[#F3E8B8] text-[#1E293B] border-2 border-[#2C3038]',
  },
  file: {
    label: 'File',
    badgeClass: 'bg-[#FCFBF8] text-[#1E293B] border-2 border-[#2C3038]',
  },
  note: {
    label: 'Note',
    badgeClass: 'bg-[#EAE6DC] text-[#1E293B] border-2 border-[#2C3038]',
  },
};

function getCategoryBaseType(
  category: ClipCategory,
  customCategories: CustomCategory[],
): BuiltinClipCategory {
  if (category in CATEGORY_META) {
    return category as BuiltinClipCategory;
  }
  const custom = customCategories.find((c) => c.id === category);
  return custom?.baseType ?? 'note';
}

function isClipSecret(
  clip: ClipItem,
  customCategories: CustomCategory[],
): boolean {
  return (
    clip.isSensitive ||
    getCategoryBaseType(clip.category, customCategories) === 'secret'
  );
}

function getClipMaskedDisplay(clip: ClipItem): string {
  if (clip.isSensitive) return clip.maskedPreview;
  return maskNonApiSecretText(clip.content);
}

function handleClipDragStart(
  e: DragEvent<HTMLElement>,
  clip: ClipItem,
  customCategories: CustomCategory[],
) {
  e.stopPropagation();

  if (window.electronAPI?.isElectron && window.electronAPI.startDrag) {
    e.preventDefault();
    const baseType = getCategoryBaseType(clip.category, customCategories);
    const isUrl =
      baseType === 'url' || /^https?:\/\//i.test(clip.content.trim());

    if (clip.kind === 'text') {
      const data: Record<string, string> = {
        'public.utf8-plain-text': clip.content,
      };
      const types = ['public.utf8-plain-text'];
      if (isUrl) {
        data['public.url'] = clip.content.trim();
        types.unshift('public.url');
      }
      void window.electronAPI.startDrag({
        item: { data, types },
        icon: MINI_DRAG_ICON_DATA_URL,
        mode: 'copy',
      });
      return;
    }

    if (clip.media?.localPath) {
      const icon =
        clip.kind === 'image'
          ? getMiniDragIcon(clip.id, e.currentTarget)
          : MINI_DRAG_ICON_DATA_URL;
      void window.electronAPI.startDrag({
        item: [clip.media.localPath],
        icon,
        mode: 'copy',
      });
      return;
    }
  }

  e.dataTransfer.effectAllowed = 'copy';
  if (clip.kind === 'text') {
    e.dataTransfer.setData('text/plain', clip.content);
    const baseType = getCategoryBaseType(clip.category, customCategories);
    if (baseType === 'url' || /^https?:\/\//i.test(clip.content.trim())) {
      e.dataTransfer.setData('text/uri-list', clip.content.trim());
    }
    return;
  }
  const safeImageDataUrl =
    clip.media?.dataUrl &&
    /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(
      clip.media.dataUrl,
    )
      ? clip.media.dataUrl
      : null;
  const safeAlt = (clip.media?.fileName ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  if (clip.media?.localPath) {
    const fileUrl = `file://${encodeURI(clip.media.localPath)}`;
    e.dataTransfer.setData('text/uri-list', fileUrl);
    e.dataTransfer.setData('text/plain', clip.media.localPath);
    if (clip.kind === 'image' && safeImageDataUrl) {
      e.dataTransfer.setData(
        'text/html',
        `<img src="${safeImageDataUrl}" alt="${safeAlt}" />`,
      );
    }
    e.dataTransfer.setData(
      'DownloadURL',
      `${clip.media.mimeType}:${clip.media.fileName}:${safeImageDataUrl ?? fileUrl}`,
    );
  } else if (clip.media?.dataUrl) {
    if (clip.kind === 'image' && safeImageDataUrl) {
      e.dataTransfer.setData(
        'text/html',
        `<img src="${safeImageDataUrl}" alt="${safeAlt}" />`,
      );
    }
    e.dataTransfer.setData(
      'DownloadURL',
      `${clip.media.mimeType}:${clip.media.fileName}:${safeImageDataUrl ?? ''}`,
    );
    e.dataTransfer.setData('text/plain', clip.media.fileName);
  }
}

function getCategoryMeta(
  category: ClipCategory,
  customCategories: CustomCategory[],
): { label: string; badgeClass: string } {
  if (category in CATEGORY_META) {
    return CATEGORY_META[category as BuiltinClipCategory];
  }
  const custom = customCategories.find((c) => c.id === category);
  if (custom) {
    const badgeClass = custom.baseType
      ? CATEGORY_META[custom.baseType].badgeClass
      : custom.badgeClass;
    return { label: custom.label, badgeClass };
  }
  return {
    label: category,
    badgeClass: 'bg-[#EAE6DC] text-[#1E293B] border-2 border-[#2C3038]',
  };
}

function CategoryIcon({
  category,
  customCategories = [],
}: {
  category: ClipCategory;
  customCategories?: CustomCategory[];
}) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  const resolved =
    category in CATEGORY_META
      ? category
      : customCategories.find((c) => c.id === category)?.baseType;
  switch (resolved) {
    case 'code':
      return <Code2 className={cls} aria-hidden="true" />;
    case 'url':
      return <Globe className={cls} aria-hidden="true" />;
    case 'error':
      return <AlertTriangle className={cls} aria-hidden="true" />;
    case 'secret':
      return <KeyRound className={cls} aria-hidden="true" />;
    case 'image':
      return <ImageIcon className={cls} aria-hidden="true" />;
    case 'file':
      return <FileIcon className={cls} aria-hidden="true" />;
    case 'note':
      return <FileText className={cls} aria-hidden="true" />;
    default:
      return <Tag className={cls} aria-hidden="true" />;
  }
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function createInitialSampleClips(): ClipItem[] {
  const samples = [
    `TypeError: Cannot read properties of undefined (reading 'embedding')\n    at searchClips (src/lib/search.ts:42:18)`,
    `const useDebounce = <T,>(value: T, delay = 250) => {\n  const [debounced, setDebounced] = useState(value);\n  return debounced;\n};`,
    `https://supabase.com/docs/guides/ai/vector-columns`,
    `OPENAI_API_KEY=sk-proj-9f8d7a6s5d4f3g2h1j0k9l8m7n6b5v4c`,
  ];

  return samples.map((content, idx) => {
    const privacy = scanWithPrivacyGuard(content);
    const { category, tags } = classifyLocally(content, privacy.isSensitive);
    return {
      id: `sample-${idx}`,
      kind: 'text',
      content,
      category,
      tags,
      isSensitive: privacy.isSensitive,
      privacyReason: privacy.reason,
      maskedPreview: privacy.maskedPreview,
      aiBlocked: privacy.isSensitive,
      createdAt: new Date(Date.now() - idx * 1000 * 60 * 12).toISOString(),
    };
  });
}

function normalizeStoredClips(raw: string): ClipItem[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return (parsed as ClipItem[]).map((c) => ({
      ...c,
      kind: c.kind ?? 'text',
      category: (c.category as string) === 'address' ? 'note' : c.category,
    }));
  } catch {
    return null;
  }
}

export function App() {
  const [clips, setClips] = useState<ClipItem[]>(() => {
    if (window.electronAPI?.isElectron) {
      const diskRaw = window.electronAPI.initialClipsJson;
      if (diskRaw) {
        const parsed = normalizeStoredClips(diskRaw);
        if (parsed) return parsed;
      }
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = normalizeStoredClips(saved);
        if (parsed) return parsed;
      }
    } catch {
      // Ignore storage errors
    }
    return createInitialSampleClips();
  });

  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<ClipCategory | 'all'>(
    'all',
  );
  const [selectedId, setSelectedId] = useState<string | null>(
    () => clips[0]?.id ?? null,
  );
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [focusAutoImport, setFocusAutoImport] = useState(true);
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionToast, setActionToast] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [moveClipId, setMoveClipId] = useState<string | null>(null);
  const [customCategories, setCustomCategories] = useState<CustomCategory[]>(() => {
    try {
      const saved = localStorage.getItem(CUSTOM_CATEGORIES_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as CustomCategory[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Ignore storage errors
    }
    return [];
  });
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryBaseType, setNewCategoryBaseType] =
    useState<BuiltinClipCategory>('note');
  const [backupPrompt, setBackupPrompt] = useState<{
    eligible: ClipItem[];
    skipped: ClipItem[];
  } | null>(null);
  const [isDeletingCategory, setIsDeletingCategory] = useState(false);
  const [deleteCategoryTarget, setDeleteCategoryTarget] = useState<{
    id: ClipCategory | 'all';
    label: string;
    isCustom: boolean;
  } | null>(null);
  const [hiddenBuiltins, setHiddenBuiltins] = useState<BuiltinClipCategory[]>(
    () => {
      try {
        const saved = localStorage.getItem(HIDDEN_BUILTINS_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as BuiltinClipCategory[];
          if (Array.isArray(parsed)) return parsed;
        }
      } catch {
        // Ignore storage errors
      }
      return [];
    },
  );
  const newCategoryInputRef = useRef<HTMLInputElement>(null);
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SKIP_DELETE_CONFIRM_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [deleteClipTarget, setDeleteClipTarget] = useState<ClipItem | null>(
    null,
  );
  const [dontRemindDelete, setDontRemindDelete] = useState(false);
  const [shortcutModalOpen, setShortcutModalOpen] = useState(false);
  const [shortcutConfig, setShortcutConfig] = useState({
    toggleShortcut: 'CmdOrCtrl+Shift+V',
    drawerShortcut: 'CmdOrCtrl+Alt+V',
  });
  const [shortcutDraft, setShortcutDraft] = useState({
    toggleShortcut: 'CmdOrCtrl+Shift+V',
    drawerShortcut: 'CmdOrCtrl+Alt+V',
  });
  const [recordingShortcutField, setRecordingShortcutField] = useState<
    'toggleShortcut' | 'drawerShortcut' | null
  >(null);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const [codeTheme, setCodeTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem(CODE_THEME_KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(CODE_THEME_KEY, codeTheme);
    } catch {
      // Ignore storage errors
    }
  }, [codeTheme]);

  useEffect(() => {
    try {
      localStorage.setItem(SKIP_DELETE_CONFIRM_KEY, String(skipDeleteConfirm));
    } catch {
      // Ignore storage errors
    }
  }, [skipDeleteConfirm]);

  useEffect(() => {
    if (editingTitleId) {
      window.setTimeout(() => titleInputRef.current?.focus(), 0);
    }
  }, [editingTitleId]);

  useEffect(() => {
    try {
      localStorage.setItem(HIDDEN_BUILTINS_KEY, JSON.stringify(hiddenBuiltins));
    } catch {
      // Ignore storage errors
    }
  }, [hiddenBuiltins]);

  const visibleBuiltinCategories = useMemo(
    () => BUILTIN_CATEGORIES.filter((id) => !hiddenBuiltins.includes(id)),
    [hiddenBuiltins],
  );
  const [categoryOrder, setCategoryOrder] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(CATEGORY_ORDER_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as string[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Ignore storage errors
    }
    return [...BUILTIN_CATEGORIES];
  });
  const [draggedCategory, setDraggedCategory] = useState<string | null>(null);
  const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(CATEGORY_ORDER_KEY, JSON.stringify(categoryOrder));
    } catch {
      // Ignore storage errors
    }
  }, [categoryOrder]);

  const orderedVisibleCategories = useMemo(() => {
    const activeSet = new Set<string>([
      ...visibleBuiltinCategories,
      ...customCategories.map((c) => c.id),
    ]);
    const ordered = categoryOrder.filter((id) => activeSet.has(id));
    for (const id of activeSet) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  }, [categoryOrder, visibleBuiltinCategories, customCategories]);

  useEffect(() => {
    try {
      localStorage.setItem(
        CUSTOM_CATEGORIES_KEY,
        JSON.stringify(customCategories),
      );
    } catch {
      // Ignore storage errors
    }
  }, [customCategories]);

  useEffect(() => {
    if (isCreatingCategory) {
      window.setTimeout(() => newCategoryInputRef.current?.focus(), 0);
    }
  }, [isCreatingCategory]);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SOUND_STORAGE_KEY) !== 'false';
    } catch {
      return true;
    }
  });
  const soundEnabledRef = useRef(soundEnabled);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    try {
      localStorage.setItem(SOUND_STORAGE_KEY, String(soundEnabled));
    } catch {
      // Ignore storage errors
    }
  }, [soundEnabled]);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);

  const showActionToast = useCallback((msg: string, ms = 2400) => {
    setActionToast(msg);
    window.setTimeout(() => setActionToast(null), ms);
  }, []);



  const handleNewTextClip = useCallback((rawText: string) => {
    const privacy = scanWithPrivacyGuard(rawText);
    const { category, tags } = classifyLocally(rawText, privacy.isSensitive);

    const newItem: ClipItem = {
      id: crypto.randomUUID(),
      kind: 'text',
      content: rawText,
      category,
      tags,
      isSensitive: privacy.isSensitive,
      privacyReason: privacy.reason,
      maskedPreview: privacy.maskedPreview,
      aiBlocked: privacy.isSensitive,
      createdAt: new Date().toISOString(),
    };

    setClips((prev) => {
      const deduped = prev.filter((item) => item.content !== rawText);
      return [newItem, ...deduped];
    });
    setSelectedId(newItem.id);
    if (soundEnabledRef.current) playClipSound();
  }, []);

  const handleNewMediaClip = useCallback((media: IncomingMediaPayload) => {
    const ext = media.fileName.includes('.')
      ? media.fileName.split('.').pop()?.toLowerCase()
      : undefined;

    const newItem: ClipItem = {
      id: crypto.randomUUID(),
      kind: media.kind,
      content: media.fileName,
      category: media.kind,
      tags: ext ? [media.kind, ext] : [media.kind],
      isSensitive: false,
      privacyReason: null,
      maskedPreview: media.fileName,
      aiBlocked: false,
      createdAt: new Date().toISOString(),
      media: {
        fileName: media.fileName,
        mimeType: media.mimeType,
        sizeBytes: media.sizeBytes,
        localPath: media.localPath,
        dataUrl: media.dataUrl,
        width: media.width,
        height: media.height,
      },
    };

    setClips((prev) => [newItem, ...prev]);
    setSelectedId(newItem.id);
    if (soundEnabledRef.current) playClipSound();
  }, []);

  const {
    isElectron,
    ingestFiles,
    copyToClipboard,
    copyImageToClipboard,
    copyFileToClipboard,
    importFromClipboardNow,
    statusMessage,
  } = useClipboardAdapter({
    onNewTextClip: handleNewTextClip,
    onNewMediaClip: handleNewMediaClip,
    focusAutoImport,
  });

  const hasPreloadedDisk =
    isElectron && window.electronAPI?.initialClipsJson !== undefined;
  const [isDiskReady, setIsDiskReady] = useState(
    !isElectron || hasPreloadedDisk,
  );
  const initialClipsRef = useRef(clips);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.loadClips) {
      setIsDiskReady(true);
      return;
    }
    if (window.electronAPI.initialClipsJson !== undefined) {
      if (
        window.electronAPI.initialClipsJson === null &&
        window.electronAPI.saveClips
      ) {
        void window.electronAPI.saveClips(
          JSON.stringify(initialClipsRef.current),
        );
      }
      setIsDiskReady(true);
      return;
    }
    let cancelled = false;
    void window.electronAPI
      .loadClips()
      .then((raw) => {
        if (cancelled) return;
        if (raw) {
          const parsed = normalizeStoredClips(raw);
          if (parsed) {
            setClips((current) => {
              const initialIds = new Set(
                initialClipsRef.current.map((c) => c.id),
              );
              const newlyAdded = current.filter((c) => !initialIds.has(c.id));
              if (newlyAdded.length === 0) return parsed;
              const diskIds = new Set(parsed.map((c) => c.id));
              return [
                ...newlyAdded.filter((c) => !diskIds.has(c.id)),
                ...parsed,
              ];
            });
            setSelectedId((prev) => {
              const initialIds = new Set(
                initialClipsRef.current.map((c) => c.id),
              );
              if (prev && !initialIds.has(prev)) return prev;
              return parsed[0]?.id ?? null;
            });
          }
        } else if (window.electronAPI?.saveClips) {
          void window.electronAPI.saveClips(
            JSON.stringify(initialClipsRef.current),
          );
        }
      })
      .catch(() => {
        // Fallback to in-memory/localStorage state if disk read fails
      })
      .finally(() => {
        if (!cancelled) setIsDiskReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isElectron]);

  useEffect(() => {
    if (isElectron && window.electronAPI?.saveClips) {
      if (!isDiskReady) return;
      void window.electronAPI.saveClips(JSON.stringify(clips));
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clips));
    } catch {
      // Ignore quota errors on large media; clips are persisted to clips.json on disk
    }
  }, [clips, isElectron, isDiskReady]);

  const isWindows = isElectron
    ? window.electronAPI?.platform === 'win32'
    : /^win/i.test(navigator.platform || '') ||
      /windows/i.test(navigator.userAgent || '');
  const modPrefix = isWindows ? 'Win+' : '⌘';

  useEffect(() => {
    if (!isElectron || !window.electronAPI) return;
    void window.electronAPI.getAutoLaunch().then(setAutoLaunch);
    void window.electronAPI.getShortcuts?.().then((cfg) => {
      if (cfg) {
        setShortcutConfig(cfg);
        setShortcutDraft(cfg);
      }
    });
    const unsubOpen = window.electronAPI.onOpenShortcutSettings?.(() => {
      void window.electronAPI?.getShortcuts?.().then((cfg) => {
        if (cfg) {
          setShortcutConfig(cfg);
          setShortcutDraft(cfg);
        }
      });
      setShortcutError(null);
      setRecordingShortcutField(null);
      setShortcutModalOpen(true);
    });
    const unsubUpdated = window.electronAPI.onShortcutsUpdated?.((cfg) => {
      setShortcutConfig(cfg);
      setShortcutDraft(cfg);
    });
    return () => {
      unsubOpen?.();
      unsubUpdated?.();
    };
  }, [isElectron]);

  const handleToggleAutoLaunch = useCallback(async () => {
    if (!window.electronAPI) return;
    const next = await window.electronAPI.setAutoLaunch(!autoLaunch);
    setAutoLaunch(next);
  }, [autoLaunch]);

  const filteredClips = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clips
      .filter((clip) => {
        if (activeCategory !== 'all' && clip.category !== activeCategory) {
          return false;
        }
        if (!q) return true;
        const secret = isClipSecret(clip, customCategories);
        const searchable = secret
          ? `${clip.title ?? ''} ${clip.category} ${clip.tags.join(' ')} ${clip.privacyReason ?? ''}`
          : `${clip.title ?? ''} ${clip.content} ${clip.category} ${clip.tags.join(' ')} ${clip.media?.mimeType ?? ''}`;
        return searchable.toLowerCase().includes(q);
      })
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  }, [clips, query, activeCategory, customCategories]);

  const selectedClip = useMemo(
    () =>
      filteredClips.find((c) => c.id === selectedId) ?? filteredClips[0] ?? null,
    [filteredClips, selectedId],
  );

  const handleCopyItem = useCallback(
    async (clip: ClipItem) => {
      if (clip.kind === 'image') {
        await copyImageToClipboard(clip.media?.localPath, clip.media?.dataUrl);
      } else if (clip.kind === 'file') {
        await copyFileToClipboard(clip.media?.localPath);
      } else {
        await copyToClipboard(clip.content);
      }
      setCopiedId(clip.id);
      window.setTimeout(() => setCopiedId(null), 1400);
    },
    [copyFileToClipboard, copyImageToClipboard, copyToClipboard],
  );

  const handleDeleteItem = useCallback(
    async (clip: ClipItem) => {
      if (isElectron && clip.media?.localPath && window.electronAPI) {
        await window.electronAPI.deleteMedia(clip.media.localPath);
      }
      setClips((prev) => prev.filter((c) => c.id !== clip.id));
      if (selectedId === clip.id) {
        setSelectedId(null);
      }
    },
    [isElectron, selectedId],
  );

  const requestDeleteClip = useCallback(
    (clip: ClipItem) => {
      if (skipDeleteConfirm) {
        void handleDeleteItem(clip);
        return;
      }
      setDontRemindDelete(false);
      setDeleteClipTarget(clip);
    },
    [skipDeleteConfirm, handleDeleteItem],
  );

  const handleTogglePin = useCallback((id: string) => {
    setClips((prev) =>
      prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)),
    );
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setIsCreatingCategory(true);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        if (selectedClip && !isCreatingCategory && !editingTitleId) {
          e.preventDefault();
          setMoveClipId((prev) =>
            prev === selectedClip.id ? null : selectedClip.id,
          );
        }
        return;
      }

      const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
      const isTypingInField =
        activeTag === 'INPUT' || activeTag === 'TEXTAREA';

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
        const hasSelection = Boolean(window.getSelection()?.toString());
        if (
          selectedClip &&
          !isTypingInField &&
          !hasSelection &&
          !isCreatingCategory &&
          !editingTitleId
        ) {
          e.preventDefault();
          void handleCopyItem(selectedClip);
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'x') {
        if (deleteClipTarget) {
          e.preventDefault();
          const target = deleteClipTarget;
          setDeleteClipTarget(null);
          void handleDeleteItem(target);
          return;
        }
        if (
          selectedClip &&
          !isTypingInField &&
          !isCreatingCategory &&
          !editingTitleId
        ) {
          e.preventDefault();
          requestDeleteClip(selectedClip);
        }
        return;
      }

      if (e.key === 'Escape') {
        if (deleteClipTarget) {
          setDeleteClipTarget(null);
          return;
        }
        if (editingTitleId) {
          setEditingTitleId(null);
          setTitleDraft('');
          return;
        }
        if (deleteCategoryTarget) {
          setDeleteCategoryTarget(null);
          return;
        }
        if (backupPrompt) {
          setBackupPrompt(null);
          return;
        }
        if (isDeletingCategory) {
          setIsDeletingCategory(false);
          return;
        }
        if (isCreatingCategory) {
          setIsCreatingCategory(false);
          setNewCategoryName('');
          return;
        }
        if (moveClipId) {
          setMoveClipId(null);
          return;
        }
        if (query) {
          setQuery('');
          return;
        }
      }

      if (isCreatingCategory || editingTitleId) return;

      if (filteredClips.length === 0) return;
      const currentIndex = filteredClips.findIndex(
        (c) => c.id === selectedClip?.id,
      );

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = filteredClips[(currentIndex + 1) % filteredClips.length];
        setSelectedId(next.id);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx =
          currentIndex <= 0 ? filteredClips.length - 1 : currentIndex - 1;
        setSelectedId(filteredClips[prevIdx].id);
      } else if (
        e.key === 'Enter' &&
        document.activeElement !== searchInputRef.current &&
        selectedClip
      ) {
        e.preventDefault();
        void handleCopyItem(selectedClip);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    filteredClips,
    selectedClip,
    query,
    moveClipId,
    isCreatingCategory,
    isDeletingCategory,
    editingTitleId,
    deleteCategoryTarget,
    deleteClipTarget,
    backupPrompt,
    handleCopyItem,
    handleDeleteItem,
    requestDeleteClip,
  ]);

  useEffect(() => {
    if (!isElectron || !window.electronAPI?.onShortcutTrigger) return;
    return window.electronAPI.onShortcutTrigger((key) => {
      if (key === 'k') {
        searchInputRef.current?.focus();
        return;
      }
      if (key === 't') {
        setIsCreatingCategory(true);
        return;
      }
      if (key === 'e') {
        if (selectedClip && !isCreatingCategory && !editingTitleId) {
          setMoveClipId((prev) =>
            prev === selectedClip.id ? null : selectedClip.id,
          );
        }
        return;
      }

      const activeEl = document.activeElement as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      const activeTag = activeEl?.tagName;
      const isTypingInField =
        activeTag === 'INPUT' || activeTag === 'TEXTAREA';

      if (key === 'c') {
        if (
          isTypingInField &&
          activeEl &&
          activeEl.selectionStart !== null &&
          activeEl.selectionEnd !== null &&
          activeEl.selectionEnd > activeEl.selectionStart
        ) {
          const selected = activeEl.value.slice(
            activeEl.selectionStart,
            activeEl.selectionEnd,
          );
          if (selected) {
            void window.electronAPI?.writeClipboard(selected);
          }
          return;
        }
        const pageSelection = window.getSelection()?.toString();
        if (pageSelection) {
          void window.electronAPI?.writeClipboard(pageSelection);
          return;
        }
        if (
          selectedClip &&
          !isTypingInField &&
          !isCreatingCategory &&
          !editingTitleId
        ) {
          void handleCopyItem(selectedClip);
        }
        return;
      }

      if (key === 'x') {
        if (deleteClipTarget) {
          const target = deleteClipTarget;
          setDeleteClipTarget(null);
          void handleDeleteItem(target);
          return;
        }
        if (isTypingInField) {
          document.execCommand('cut');
          return;
        }
        if (
          selectedClip &&
          !isCreatingCategory &&
          !editingTitleId
        ) {
          requestDeleteClip(selectedClip);
        }
      }
    });
  }, [
    isElectron,
    selectedClip,
    isCreatingCategory,
    editingTitleId,
    deleteClipTarget,
    handleCopyItem,
    handleDeleteItem,
    requestDeleteClip,
  ]);



  const handleRestoreBuiltinTemplate = useCallback(
    (id: BuiltinClipCategory) => {
      setHiddenBuiltins((prev) => prev.filter((item) => item !== id));
      setCategoryOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setIsCreatingCategory(false);
      setNewCategoryName('');
      showActionToast(`Restored "${CATEGORY_META[id].label}" clip type`);
    },
    [showActionToast],
  );

  const handleCreateCustomCategory = useCallback(
    (overrideName?: string, overrideBaseType?: BuiltinClipCategory) => {
      const trimmed = (overrideName ?? newCategoryName).trim();
      if (!trimmed) return;
      const baseType = overrideBaseType ?? newCategoryBaseType;

      const hiddenBuiltinMatch = hiddenBuiltins.find(
        (id) => CATEGORY_META[id].label.toLowerCase() === trimmed.toLowerCase(),
      );
      if (hiddenBuiltinMatch) {
        handleRestoreBuiltinTemplate(hiddenBuiltinMatch);
        return;
      }

      const existing = [
        ...visibleBuiltinCategories.map((id) => ({
          id,
          label: CATEGORY_META[id].label,
        })),
        ...customCategories,
      ].find((c) => c.label.toLowerCase() === trimmed.toLowerCase());

      if (existing) {
        showActionToast(`"${existing.label}" clip type already exists`);
        setIsCreatingCategory(false);
        setNewCategoryName('');
        return;
      }

      const slug =
        trimmed
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'custom';
      const id = `custom-${slug}-${Date.now().toString(36).slice(-4)}`;
      const badgeClass =
        CATEGORY_META[baseType]?.badgeClass ??
        CUSTOM_BADGE_PALETTE[
          customCategories.length % CUSTOM_BADGE_PALETTE.length
        ];

      setCustomCategories((prev) => [
        ...prev,
        { id, label: trimmed, badgeClass, baseType },
      ]);
      setCategoryOrder((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setIsCreatingCategory(false);
      setNewCategoryName('');
      showActionToast(
        `Created "${trimmed}" (${CATEGORY_META[baseType].label})`,
      );
    },
    [
      newCategoryName,
      newCategoryBaseType,
      hiddenBuiltins,
      visibleBuiltinCategories,
      customCategories,
      handleRestoreBuiltinTemplate,
      showActionToast,
    ],
  );

  const handleTypeTemplateClick = useCallback(
    (builtinId: BuiltinClipCategory) => {
      if (newCategoryName.trim()) {
        setNewCategoryBaseType(builtinId);
        return;
      }
      if (hiddenBuiltins.includes(builtinId)) {
        handleRestoreBuiltinTemplate(builtinId);
        return;
      }
      handleCreateCustomCategory(CATEGORY_META[builtinId].label, builtinId);
    },
    [
      newCategoryName,
      hiddenBuiltins,
      handleRestoreBuiltinTemplate,
      handleCreateCustomCategory,
    ],
  );

  const executeBackup = useCallback(
    (clipsToExport: ClipItem[], skippedCount = 0) => {
      const sanitizedClips = clipsToExport.map((c) =>
        isClipSecret(c, customCategories)
          ? {
              ...c,
              content: getClipMaskedDisplay(c),
            }
          : c,
      );
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        clips: sanitizedClips,
        customCategories,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const dateStamp = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `clipture-backup-${dateStamp}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      const textCount = clipsToExport.filter((c) => c.kind === 'text').length;
      const mediaCount = clipsToExport.length - textCount;
      showActionToast(
        skippedCount > 0
          ? `Backed up ${clipsToExport.length} clips (${textCount} text, ${mediaCount} media · skipped ${skippedCount} ≥ 5 MB)`
          : `Backed up ${clipsToExport.length} clips (${textCount} text, ${mediaCount} media)`,
      );
    },
    [customCategories, showActionToast],
  );

  const handleBackupClips = useCallback(() => {
    const eligible = clips.filter(
      (c) => !c.media || c.media.sizeBytes < MAX_BACKUP_FILE_BYTES,
    );
    const skipped = clips.filter(
      (c) => Boolean(c.media && c.media.sizeBytes >= MAX_BACKUP_FILE_BYTES),
    );

    if (skipped.length > 0) {
      setBackupPrompt({ eligible, skipped });
      return;
    }

    if (eligible.length === 0) {
      showActionToast('No clips to back up');
      return;
    }

    executeBackup(eligible);
  }, [clips, executeBackup, showActionToast]);

  const handleRestoreFile = useCallback(
    async (file: File) => {
      try {
        const maxRestoreBytes = 50 * 1024 * 1024;
        if (file.size > maxRestoreBytes) {
          showActionToast('Backup file exceeds 50 MB limit');
          return;
        }
        const raw = await file.text();
        const parsed = JSON.parse(raw) as unknown;
        const rawItems = Array.isArray(parsed)
          ? parsed
          : parsed &&
              typeof parsed === 'object' &&
              'clips' in parsed &&
              Array.isArray((parsed as { clips: unknown }).clips)
            ? (parsed as { clips: unknown[] }).clips
            : null;

        if (!rawItems) {
          showActionToast('Invalid backup file format');
          return;
        }

        const safeImageDataUrlRegex =
          /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i;
        const validItems = rawItems
          .filter((item): item is ClipItem => {
            if (!item || typeof item !== 'object') return false;
            const c = item as Partial<ClipItem>;
            return (
              typeof c.id === 'string' &&
              typeof c.content === 'string' &&
              typeof c.category === 'string' &&
              typeof c.createdAt === 'string'
            );
          })
          .map((c) => {
            const sanitizedMedia = c.media
              ? {
                  fileName: String(c.media.fileName || 'file'),
                  mimeType: String(c.media.mimeType || 'application/octet-stream'),
                  sizeBytes: Number(c.media.sizeBytes) || 0,
                  dataUrl:
                    typeof c.media.dataUrl === 'string' &&
                    safeImageDataUrlRegex.test(c.media.dataUrl)
                      ? c.media.dataUrl
                      : undefined,
                  width:
                    typeof c.media.width === 'number' ? c.media.width : undefined,
                  height:
                    typeof c.media.height === 'number'
                      ? c.media.height
                      : undefined,
                }
              : undefined;
            return {
              ...c,
              kind: c.kind ?? 'text',
              tags: Array.isArray(c.tags) ? c.tags.filter((t) => typeof t === 'string') : [],
              isSensitive: Boolean(c.isSensitive),
              privacyReason: c.privacyReason ?? null,
              maskedPreview: c.maskedPreview ?? c.content,
              aiBlocked: Boolean(c.aiBlocked ?? c.isSensitive),
              media: sanitizedMedia,
            };
          });

        if (validItems.length === 0) {
          showActionToast('No valid clips found in backup');
          return;
        }

        if (
          parsed &&
          typeof parsed === 'object' &&
          'customCategories' in parsed &&
          Array.isArray(
            (parsed as { customCategories: unknown }).customCategories,
          )
        ) {
          const allowedBadges = new Set([
            ...CUSTOM_BADGE_PALETTE,
            ...Object.values(CATEGORY_META).map((m) => m.badgeClass),
          ]);
          const importedCats = (
            parsed as { customCategories: CustomCategory[] }
          ).customCategories
            .filter(
              (c) =>
                c &&
                typeof c.id === 'string' &&
                typeof c.label === 'string' &&
                typeof c.badgeClass === 'string',
            )
            .map((c) => ({
              ...c,
              badgeClass: allowedBadges.has(c.badgeClass)
                ? c.badgeClass
                : CUSTOM_BADGE_PALETTE[0],
            }));
          if (importedCats.length > 0) {
            setCustomCategories((prev) => {
              const existingIds = new Set(prev.map((c) => c.id));
              const newCats = importedCats.filter(
                (c) => !existingIds.has(c.id),
              );
              return newCats.length > 0 ? [...prev, ...newCats] : prev;
            });
            setCategoryOrder((prev) => {
              const merged = [...prev];
              for (const c of importedCats) {
                if (!merged.includes(c.id)) merged.push(c.id);
              }
              return merged;
            });
          }
        }

        let addedCount = 0;
        let totalCount = 0;
        setClips((prev) => {
          const existingIds = new Set(prev.map((c) => c.id));
          const newOnes = validItems.filter((c) => !existingIds.has(c.id));
          addedCount = newOnes.length;
          const merged = [...newOnes, ...prev].sort(
            (a, b) =>
              new Date(b.createdAt).getTime() -
              new Date(a.createdAt).getTime(),
          );
          totalCount = merged.length;
          return merged;
        });

        setSelectedId((prev) => prev ?? validItems[0].id);
        showActionToast(
          addedCount > 0
            ? `Restored ${addedCount} clip${addedCount === 1 ? '' : 's'} (${totalCount} total)`
            : `All ${validItems.length} clips already present`,
        );
      } catch {
        showActionToast('Could not read backup JSON');
      }
    },
    [showActionToast],
  );

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      void ingestFiles(e.dataTransfer.files);
    }
  };



  const isRevealed = selectedClip ? Boolean(revealedIds[selectedClip.id]) : false;

  return (
    <div
      className="relative flex h-screen flex-col bg-[#F5F3EE] text-[#1E293B]"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setIsDragging(false);
      }}
      onDrop={handleDrop}
    >
      {/* Backup 5 MB Limit Prompt */}
      {backupPrompt && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="backup-limit-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E293B]/45 p-4"
        >
          <div className="w-full max-w-md border-2 border-[#2C3038] bg-[#FCFBF8] p-5 shadow-[6px_6px_0_#2C3038]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 border-2 border-[#2C3038] bg-[#F3E8B8] px-2 py-0.5 text-[11px] font-bold uppercase text-[#1E293B]">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                5 MB File Limit
              </span>
              <button
                type="button"
                onClick={() => setBackupPrompt(null)}
                aria-label="Close backup prompt"
                className="nb-press bg-[#EAE6DC] p-1 text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <h2
              id="backup-limit-title"
              className="text-base font-bold uppercase tracking-tight text-[#1E293B]"
            >
              Large files excluded from backup
            </h2>
            <p className="mt-1.5 text-xs font-medium text-[#475569]">
              Only files under 5 MB can be backed up. {backupPrompt.skipped.length}{' '}
              file{backupPrompt.skipped.length === 1 ? '' : 's'} will be skipped:
            </p>

            <ul className="mt-3 max-h-36 space-y-1.5 overflow-y-auto border-2 border-[#2C3038] bg-[#F5F3EE] p-2.5">
              {backupPrompt.skipped.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center justify-between gap-2 text-xs font-bold text-[#1E293B]"
                >
                  <span className="truncate">
                    {item.media?.fileName ?? item.content}
                  </span>
                  <span className="shrink-0 border border-[#2C3038] bg-[#F4C7C3] px-1.5 py-0.5 text-[10px]">
                    {formatBytes(item.media?.sizeBytes ?? 0)}
                  </span>
                </li>
              ))}
            </ul>

            <p className="mt-3 text-xs font-bold text-[#1E293B]">
              {backupPrompt.eligible.length} clip
              {backupPrompt.eligible.length === 1 ? '' : 's'} under 5 MB ready
              to back up.
            </p>

            <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setBackupPrompt(null)}
                className="nb-press bg-[#FCFBF8] px-3 py-1.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#EAE6DC]"
              >
                Cancel
              </button>
              {backupPrompt.eligible.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const { eligible, skipped } = backupPrompt;
                    setBackupPrompt(null);
                    executeBackup(eligible, skipped.length);
                  }}
                  className="nb-press bg-[#CBE4D3] px-3 py-1.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#F3E8B8]"
                >
                  Only Under 5 MB ({backupPrompt.eligible.length})
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setBackupPrompt(null);
                  executeBackup(clips);
                }}
                className="nb-press nb-button-primary px-3 py-1.5 text-xs uppercase"
              >
                Back Up All Anyway ({clips.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Clip Type / Clips Confirmation */}
      {deleteCategoryTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-category-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E293B]/45 p-4"
        >
          <div className="w-full max-w-sm border-2 border-[#2C3038] bg-[#FCFBF8] p-5 shadow-[6px_6px_0_#2C3038]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 border-2 border-[#2C3038] bg-[#F4C7C3] px-2 py-0.5 text-[11px] font-bold uppercase text-[#1E293B]">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {deleteCategoryTarget.isCustom
                  ? 'Delete Clip Type & Clips'
                  : 'Delete Clips'}
              </span>
              <button
                type="button"
                onClick={() => setDeleteCategoryTarget(null)}
                aria-label="Close delete confirmation"
                className="nb-press bg-[#EAE6DC] p-1 text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            {(() => {
              const matchingClips =
                deleteCategoryTarget.id === 'all'
                  ? clips
                  : clips.filter((c) => c.category === deleteCategoryTarget.id);
              const count = matchingClips.length;

              return (
                <>
                  <h2
                    id="delete-category-title"
                    className="text-base font-bold uppercase tracking-tight text-[#1E293B]"
                  >
                    {deleteCategoryTarget.id === 'all'
                      ? `Delete all ${count} clip${count === 1 ? '' : 's'}?`
                      : deleteCategoryTarget.isCustom
                        ? `Delete "${deleteCategoryTarget.label}"?`
                        : `Delete all "${deleteCategoryTarget.label}" clips?`}
                  </h2>
                  <p className="mt-1.5 text-xs font-medium text-[#475569]">
                    {deleteCategoryTarget.id === 'all'
                      ? count > 0
                        ? `All ${count} clip${count === 1 ? '' : 's'} will be permanently deleted.`
                        : 'There are no clips to delete.'
                      : count > 0
                        ? `${count} clip${count === 1 ? '' : 's'} inside "${deleteCategoryTarget.label}" will be permanently deleted and the clip type will be removed${deleteCategoryTarget.isCustom ? '.' : ' (restore anytime from + templates).'}`
                        : `No clips are in "${deleteCategoryTarget.label}". Removing this clip type${deleteCategoryTarget.isCustom ? '.' : ' (restore anytime from + templates).'}`}
                  </p>

                  <div className="mt-4 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setDeleteCategoryTarget(null)}
                      className="nb-press bg-[#FCFBF8] px-3 py-1.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#EAE6DC]"
                    >
                      Cancel
                    </button>
                    {(count > 0 || deleteCategoryTarget.id !== 'all') && (
                      <button
                        type="button"
                        onClick={() => {
                          const target = deleteCategoryTarget;
                          if (isElectron && window.electronAPI) {
                            for (const c of matchingClips) {
                              if (c.media?.localPath) {
                                void window.electronAPI.deleteMedia(
                                  c.media.localPath,
                                );
                              }
                            }
                          }
                          const deletedIds = new Set(
                            matchingClips.map((c) => c.id),
                          );
                          setClips((prev) =>
                            target.id === 'all'
                              ? []
                              : prev.filter((c) => c.category !== target.id),
                          );
                          if (target.isCustom) {
                            setCustomCategories((prev) =>
                              prev.filter((c) => c.id !== target.id),
                            );
                          } else if (target.id !== 'all') {
                            setHiddenBuiltins((prev) =>
                              prev.includes(target.id as BuiltinClipCategory)
                                ? prev
                                : [...prev, target.id as BuiltinClipCategory],
                            );
                          }
                          if (activeCategory === target.id) {
                            setActiveCategory('all');
                          }
                          if (selectedId && deletedIds.has(selectedId)) {
                            setSelectedId(null);
                          }
                          setDeleteCategoryTarget(null);
                          setIsDeletingCategory(false);
                          showActionToast(
                            target.id === 'all'
                              ? `Deleted all ${count} clip${count === 1 ? '' : 's'}`
                              : `Deleted "${target.label}" (${count} clip${count === 1 ? '' : 's'})`,
                          );
                        }}
                        className="nb-press bg-[#F4C7C3] px-3 py-1.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#efaba5]"
                      >
                        {deleteCategoryTarget.id === 'all'
                          ? `Delete ${count} Clip${count === 1 ? '' : 's'}`
                          : count > 0
                            ? `Delete Type & ${count} Clip${count === 1 ? '' : 's'}`
                            : 'Delete Type'}
                      </button>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* Custom Shortcuts Modal */}
      {shortcutModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="custom-shortcuts-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E293B]/45 p-4"
        >
          <div className="w-full max-w-md border-2 border-[#2C3038] bg-[#FCFBF8] p-5 shadow-[6px_6px_0_#2C3038]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 border-2 border-[#2C3038] bg-[#CBDDF0] px-2 py-0.5 text-[11px] font-bold uppercase text-[#1E293B]">
                <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                Custom Shortcuts
              </span>
              <button
                type="button"
                onClick={() => {
                  setRecordingShortcutField(null);
                  setShortcutModalOpen(false);
                }}
                aria-label="Close custom shortcuts"
                className="nb-press bg-[#EAE6DC] p-1 text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <h2
              id="custom-shortcuts-title"
              className="text-base font-bold uppercase tracking-tight text-[#1E293B]"
            >
              Customize Global Commands
            </h2>
            <p className="mt-1 text-xs font-medium text-[#475569]">
              Click Record and press a modifier + key combination (e.g.{' '}
              {isWindows ? 'Ctrl+Alt+V' : '⌥⌘V'}).
            </p>

            <div className="mt-4 space-y-3">
              {(
                [
                  {
                    key: 'toggleShortcut' as const,
                    label: 'Show / Hide Clipture',
                  },
                  {
                    key: 'drawerShortcut' as const,
                    label: 'Quick Cursor Popup',
                  },
                ] as const
              ).map(({ key, label }) => {
                const isRecording = recordingShortcutField === key;
                return (
                  <div
                    key={key}
                    className="border-2 border-[#2C3038] bg-[#F5F3EE] p-3"
                  >
                    <div className="mb-1.5 text-xs font-bold uppercase text-[#1E293B]">
                      {label}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly={isRecording}
                        value={
                          isRecording
                            ? 'Press modifier + key...'
                            : shortcutDraft[key]
                        }
                        onChange={(e) =>
                          setShortcutDraft((prev) => ({
                            ...prev,
                            [key]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) => {
                          if (!isRecording) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (
                            e.key === 'Meta' ||
                            e.key === 'Shift' ||
                            e.key === 'Alt' ||
                            e.key === 'Control'
                          ) {
                            return;
                          }
                          if (
                            !e.metaKey &&
                            !e.ctrlKey &&
                            !e.altKey &&
                            !e.shiftKey
                          ) {
                            setShortcutError(
                              'Include at least one modifier (Cmd/Ctrl/Alt/Shift)',
                            );
                            return;
                          }
                          const parts: string[] = [];
                          if (e.metaKey) parts.push('Super');
                          if (e.ctrlKey) parts.push('Control');
                          if (e.altKey) parts.push('Alt');
                          if (e.shiftKey) parts.push('Shift');
                          let keyName: string;
                          if (e.code === 'Space') keyName = 'Space';
                          else if (e.code.startsWith('Key'))
                            keyName = e.code.slice(3);
                          else if (e.code.startsWith('Digit'))
                            keyName = e.code.slice(5);
                          else if (/^F([1-9]|1[0-2])$/.test(e.code))
                            keyName = e.code;
                          else if (e.key.length === 1)
                            keyName = e.key.toUpperCase();
                          else keyName = e.code;
                          parts.push(keyName);
                          setShortcutError(null);
                          setShortcutDraft((prev) => ({
                            ...prev,
                            [key]: parts.join('+'),
                          }));
                          setRecordingShortcutField(null);
                        }}
                        className={`min-w-0 flex-1 border-2 border-[#2C3038] px-2.5 py-1.5 font-mono text-xs font-bold text-[#1E293B] ${
                          isRecording ? 'bg-[#F3E8B8]' : 'bg-[#FCFBF8]'
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          setShortcutError(null);
                          setRecordingShortcutField(isRecording ? null : key);
                        }}
                        className={`nb-press shrink-0 px-2.5 py-1.5 text-xs uppercase shadow-[2px_2px_0_#2C3038] ${
                          isRecording
                            ? 'bg-[#F4C7C3] text-[#1E293B]'
                            : 'bg-[#F3E8B8] text-[#1E293B]'
                        }`}
                      >
                        {isRecording ? 'Cancel' : 'Record'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {shortcutError && (
              <p className="mt-3 border-2 border-[#2C3038] bg-[#F4C7C3] px-2.5 py-1.5 text-xs font-bold text-[#1E293B]">
                {shortcutError}
              </p>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => {
                  setShortcutError(null);
                  setRecordingShortcutField(null);
                  setShortcutDraft({
                    toggleShortcut: 'CmdOrCtrl+Shift+V',
                    drawerShortcut: 'CmdOrCtrl+Alt+V',
                  });
                }}
                className="nb-press bg-[#EAE6DC] px-3 py-1.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#F3E8B8]"
              >
                Reset Defaults
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setRecordingShortcutField(null);
                    setShortcutModalOpen(false);
                  }}
                  className="nb-press bg-[#FCFBF8] px-3 py-1.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#EAE6DC]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.electronAPI?.setShortcuts) return;
                    try {
                      const saved = await window.electronAPI.setShortcuts(
                        shortcutDraft,
                      );
                      setShortcutConfig(saved);
                      setShortcutModalOpen(false);
                      setRecordingShortcutField(null);
                      showActionToast('Saved custom shortcuts');
                    } catch (err) {
                      setShortcutError(
                        typeof err === 'string'
                          ? err
                          : err instanceof Error
                            ? err.message
                            : 'Could not save shortcuts',
                      );
                    }
                  }}
                  className="nb-press nb-button-primary px-3 py-1.5 text-xs uppercase"
                >
                  Save Shortcuts
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Selected Clip Confirmation */}
      {deleteClipTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-clip-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1E293B]/45 p-4"
        >
          <div className="w-full max-w-sm border-2 border-[#2C3038] bg-[#FCFBF8] p-5 shadow-[6px_6px_0_#2C3038]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 border-2 border-[#2C3038] bg-[#F4C7C3] px-2 py-0.5 text-[11px] font-bold uppercase text-[#1E293B]">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                Delete Clip
              </span>
              <button
                type="button"
                onClick={() => setDeleteClipTarget(null)}
                aria-label="Close delete clip confirmation"
                className="nb-press bg-[#EAE6DC] p-1 text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>

            <h2
              id="delete-clip-title"
              className="text-base font-bold uppercase tracking-tight text-[#1E293B]"
            >
              Delete this clip?
            </h2>
            <p className="mt-1.5 truncate border-2 border-[#2C3038] bg-[#F5F3EE] px-2.5 py-1.5 font-mono text-xs font-medium text-[#1E293B]">
              {deleteClipTarget.title ||
                deleteClipTarget.media?.fileName ||
                deleteClipTarget.maskedPreview}
            </p>

            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs font-bold text-[#1E293B]">
              <input
                type="checkbox"
                checked={dontRemindDelete}
                onChange={(e) => setDontRemindDelete(e.target.checked)}
                className="h-4 w-4 accent-[#1E293B]"
              />
              Don&apos;t remind me again
            </label>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteClipTarget(null)}
                className="nb-press bg-[#FCFBF8] px-3 py-1.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#EAE6DC]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = deleteClipTarget;
                  if (dontRemindDelete) {
                    setSkipDeleteConfirm(true);
                  }
                  setDeleteClipTarget(null);
                  void handleDeleteItem(target);
                }}
                className="nb-press bg-[#F4C7C3] px-3 py-1.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#efaba5]"
              >
                Delete Clip
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Drag & Drop Overlay */}
      {isDragging && (
        <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#F5F3EE]/90">
          <div className="border-2 border-[#2C3038] bg-[#F3E8B8] px-10 py-8 text-center shadow-[6px_6px_0_#2C3038]">
            <Upload
              className="mx-auto mb-3 h-9 w-9 text-[#1E293B]"
              aria-hidden="true"
            />
            <h2 className="text-base font-bold uppercase tracking-tight text-[#1E293B]">
              Drop images or files to save locally
            </h2>
            <p className="mt-1 text-xs font-medium text-[#475569]">
              Stored privately on your device. Nothing leaves your Mac.
            </p>
          </div>
        </div>
      )}

      {/* Hidden file picker */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            void ingestFiles(e.target.files);
            e.target.value = '';
          }
        }}
      />

      {/* Hidden backup picker */}
      <input
        ref={backupInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            void handleRestoreFile(file);
            e.target.value = '';
          }
        }}
      />

      {/* Top Bar */}
      <header className="titlebar-drag flex flex-wrap items-center justify-between gap-2 border-b-2 border-[#2C3038] bg-[#EAE6DC] px-4 py-2.5 pl-20">
        <div className="titlebar-no-drag flex flex-wrap items-center gap-2">
          <img
            src={appIcon}
            alt="Clipture"
            className="h-9 w-9 shrink-0 object-contain"
          />
          <h1 className="text-base font-bold uppercase tracking-tight text-[#1E293B]">
            Clipture
          </h1>
          <span className="inline-flex items-center gap-1 border-2 border-[#2C3038] bg-[#CBE4D3] px-2 py-0.5 text-[11px] font-bold uppercase text-[#1E293B]">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Local-Only · Privacy Guard
          </span>
          <button
            type="button"
            onClick={handleBackupClips}
            title="Export clips (files under 5 MB) to a local JSON backup"
            className="nb-press inline-flex items-center gap-1 bg-[#FCFBF8] px-2 py-0.5 text-[11px] uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#F3E8B8]"
          >
            <Download className="h-3 w-3" aria-hidden="true" />
            Backup
          </button>
          <button
            type="button"
            onClick={() => backupInputRef.current?.click()}
            title="Restore clips from a local JSON backup"
            className="nb-press inline-flex items-center gap-1 bg-[#FCFBF8] px-2 py-0.5 text-[11px] uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#CBDDF0]"
          >
            <RotateCcw className="h-3 w-3" aria-hidden="true" />
            Restore
          </button>
          <button
            type="button"
            disabled={clips.length === 0}
            onClick={() =>
              setDeleteCategoryTarget({
                id: 'all',
                label: 'All',
                isCustom: false,
              })
            }
            title="Clear all saved clips"
            className="nb-press inline-flex items-center gap-1 bg-[#F4C7C3] px-2 py-0.5 text-[11px] uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#efaba5] disabled:opacity-45 disabled:shadow-none"
          >
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Clear All
          </button>
        </div>

        <div className="titlebar-no-drag flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 border-2 border-[#2C3038] bg-[#FCFBF8] px-2.5 py-1 text-[11px] font-bold text-[#1E293B]">
            <Monitor className="h-3.5 w-3.5 text-[#1E293B]" aria-hidden="true" />
            {isElectron
              ? 'Desktop Auto-Capture'
              : `Web Mode (${isWindows ? 'Win+V' : 'Cmd+V'})`}
          </span>

          {isElectron ? (
            <button
              type="button"
              onClick={() => void handleToggleAutoLaunch()}
              aria-pressed={autoLaunch}
              className={`nb-press px-2.5 py-1 text-[11px] shadow-[2px_2px_0_#2C3038] ${
                autoLaunch
                  ? 'bg-[#CBE4D3] text-[#1E293B]'
                  : 'bg-[#FCFBF8] text-[#1E293B]'
              }`}
            >
              Auto-Start: {autoLaunch ? 'On' : 'Off'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setFocusAutoImport((v) => !v)}
              aria-pressed={focusAutoImport}
              className={`nb-press px-2.5 py-1 text-[11px] shadow-[2px_2px_0_#2C3038] ${
                focusAutoImport
                  ? 'bg-[#CBDDF0] text-[#1E293B]'
                  : 'bg-[#FCFBF8] text-[#1E293B]'
              }`}
            >
              Focus Sync: {focusAutoImport ? 'On' : 'Off'}
            </button>
          )}

          <button
            type="button"
            onClick={() => {
              const next = !soundEnabled;
              setSoundEnabled(next);
              if (next) playClipSound();
            }}
            aria-pressed={soundEnabled}
            title={
              soundEnabled
                ? 'Clip sound: On (click to mute)'
                : 'Clip sound: Off (click to enable)'
            }
            className={`nb-press inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] uppercase shadow-[2px_2px_0_#2C3038] ${
              soundEnabled
                ? 'bg-[#F3E8B8] text-[#1E293B]'
                : 'bg-[#FCFBF8] text-[#475569]'
            }`}
          >
            {soundEnabled ? (
              <Volume2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            SOUND
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="nb-press inline-flex items-center gap-1.5 bg-[#FCFBF8] px-3 py-1 text-xs text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#F3E8B8]"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            Add File
          </button>

          <button
            type="button"
            onClick={() => void importFromClipboardNow()}
            className="nb-press nb-button-primary inline-flex items-center gap-1.5 px-3 py-1 text-xs"
          >
            <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" />
            Import Clip
          </button>
        </div>
      </header>

      {/* Search & Filter Bar */}
      <div className="border-b-2 border-[#2C3038] bg-[#F5F3EE] px-4 py-3">
        <div className="relative flex items-center">
          <Search
            className="pointer-events-none absolute left-3.5 h-4 w-4 text-[#475569]"
            aria-hidden="true"
          />
          <input
            ref={searchInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search clips, filenames, or tags. Paste images, files, or text with ${isWindows ? 'Win+V' : 'Cmd+V'}.`}
            aria-label="Search clips, filenames, and tags"
            className="w-full border-2 border-[#2C3038] bg-[#FCFBF8] py-2 pl-10 pr-16 text-sm font-medium text-[#1E293B] shadow-[3px_3px_0_#2C3038] placeholder:text-[#64748B]"
          />
          <kbd className="pointer-events-none absolute right-3 border-2 border-[#2C3038] bg-[#EAE6DC] px-1.5 py-0.5 text-[11px] font-bold text-[#1E293B]">
            {modPrefix}K
          </kbd>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {(['all', ...orderedVisibleCategories] as const).map(
            (cat) => {
              const active = activeCategory === cat;
              const isMoveMode = Boolean(
                moveClipId && selectedClip?.id === moveClipId,
              );
              const isTargetable = isMoveMode && cat !== 'all';
              const customCat = customCategories.find((c) => c.id === cat);
              const isDeletable = isDeletingCategory;
              const isReorderable =
                cat !== 'all' && !isMoveMode && !isDeletingCategory;
              const catIdx = orderedVisibleCategories.indexOf(cat);
              const fromIdx = draggedCategory
                ? orderedVisibleCategories.indexOf(draggedCategory)
                : -1;
              const showGapBefore =
                cat !== 'all' &&
                Boolean(draggedCategory) &&
                dropInsertIndex === catIdx &&
                dropInsertIndex !== fromIdx &&
                dropInsertIndex !== fromIdx + 1;
              const displayLabel =
                cat === 'all'
                  ? 'All'
                  : getCategoryMeta(cat, customCategories).label;
              const buttonText =
                cat === 'all' ? `All (${clips.length})` : displayLabel;

              const commitDrop = () => {
                if (!draggedCategory || dropInsertIndex === null) return;
                const from = orderedVisibleCategories.indexOf(draggedCategory);
                if (from !== -1) {
                  const next = [...orderedVisibleCategories];
                  next.splice(from, 1);
                  const adjusted =
                    from < dropInsertIndex
                      ? dropInsertIndex - 1
                      : dropInsertIndex;
                  next.splice(adjusted, 0, draggedCategory);
                  setCategoryOrder(next);
                }
                setDraggedCategory(null);
                setDropInsertIndex(null);
              };

              return (
                <div key={cat} className="contents">
                  {showGapBefore && (
                    <span
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        commitDrop();
                      }}
                      className="inline-flex h-7 w-14 items-center justify-center border-2 border-dashed border-[#2C3038] bg-[#F3E8B8]/70 text-[10px] font-bold uppercase text-[#475569] transition-all duration-150"
                    >
                      Drop
                    </span>
                  )}
                  <button
                    type="button"
                    draggable={isReorderable}
                    onDragStart={(e) => {
                      if (!isReorderable) return;
                      e.stopPropagation();
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', cat);
                      setDraggedCategory(cat);
                    }}
                    onDragOver={(e) => {
                      if (!isReorderable || !draggedCategory || draggedCategory === cat) {
                        return;
                      }
                      e.preventDefault();
                      e.stopPropagation();
                      e.dataTransfer.dropEffect = 'move';
                      const rect = e.currentTarget.getBoundingClientRect();
                      const isRightHalf = e.clientX >= rect.left + rect.width / 2;
                      const nextIdx = isRightHalf ? catIdx + 1 : catIdx;
                      if (dropInsertIndex !== nextIdx) {
                        setDropInsertIndex(nextIdx);
                      }
                    }}
                    onDrop={(e) => {
                      if (!isReorderable || !draggedCategory) return;
                      e.preventDefault();
                      e.stopPropagation();
                      commitDrop();
                    }}
                    onDragEnd={() => {
                      setDraggedCategory(null);
                      setDropInsertIndex(null);
                    }}
                    disabled={isMoveMode && cat === 'all'}
                    onClick={() => {
                      if (isDeletingCategory) {
                        setDeleteCategoryTarget({
                          id: cat,
                          label: displayLabel,
                          isCustom: Boolean(customCat),
                        });
                        return;
                      }
                      if (isTargetable && moveClipId) {
                        setClips((prev) =>
                          prev.map((c) =>
                            c.id === moveClipId ? { ...c, category: cat } : c,
                          ),
                        );
                        if (activeCategory !== 'all') {
                          setActiveCategory(cat);
                        }
                        setMoveClipId(null);
                        showActionToast(`Moved to ${displayLabel}`);
                        return;
                      }
                      setActiveCategory(cat);
                    }}
                    aria-pressed={active}
                    className={`nb-press px-2.5 py-1 text-xs uppercase transition-transform duration-150 ${
                      draggedCategory === cat
                        ? 'opacity-35 cursor-grabbing'
                        : isDeletable
                          ? 'bg-[#F4C7C3] text-[#1E293B] ring-2 ring-[#2C3038] ring-offset-1 shadow-[3px_3px_0_#2C3038] hover:bg-[#efaba5]'
                          : isTargetable
                            ? 'bg-[#F3E8B8] text-[#1E293B] ring-2 ring-[#1E293B] ring-offset-1 shadow-[3px_3px_0_#2C3038] hover:bg-[#CBE4D3]'
                            : isMoveMode && cat === 'all'
                              ? 'bg-[#EAE6DC] text-[#64748B] opacity-50 shadow-none'
                              : active
                                ? 'bg-[#1E293B] text-[#FCFBF8] shadow-[2px_2px_0_#64748B]'
                                : 'bg-[#FCFBF8] text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#F3E8B8]'
                    } ${isReorderable ? 'cursor-grab' : ''}`}
                  >
                    {buttonText}
                  </button>
                </div>
              );
            },
          )}

          {draggedCategory &&
            dropInsertIndex === orderedVisibleCategories.length &&
            dropInsertIndex !==
              orderedVisibleCategories.indexOf(draggedCategory) + 1 && (
              <span
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const from = orderedVisibleCategories.indexOf(draggedCategory);
                  if (from !== -1) {
                    const next = [...orderedVisibleCategories];
                    next.splice(from, 1);
                    next.push(draggedCategory);
                    setCategoryOrder(next);
                  }
                  setDraggedCategory(null);
                  setDropInsertIndex(null);
                }}
                className="inline-flex h-7 w-14 items-center justify-center border-2 border-dashed border-[#2C3038] bg-[#F3E8B8]/70 text-[10px] font-bold uppercase text-[#475569] transition-all duration-150"
              >
                Drop
              </span>
            )}

          {isCreatingCategory ? (
            <form
              className="inline-flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                handleCreateCustomCategory();
              }}
            >
              <input
                ref={newCategoryInputRef}
                type="text"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="Type name..."
                maxLength={24}
                aria-label="New custom clip type name"
                className="w-28 border-2 border-[#2C3038] bg-[#FCFBF8] px-2 py-0.5 text-xs font-bold text-[#1E293B] shadow-[2px_2px_0_#2C3038] placeholder:text-[#64748B]"
              />
              <button
                type="submit"
                className="nb-press bg-[#CBE4D3] px-2 py-0.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsCreatingCategory(false);
                  setNewCategoryName('');
                }}
                aria-label="Cancel new clip type"
                className="nb-press bg-[#F4C7C3] p-1 text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </form>
          ) : (
            <div className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setIsDeletingCategory(false);
                  setIsCreatingCategory(true);
                }}
                title={`Create custom clip type (${modPrefix}T)`}
                aria-label="Create custom clip type"
                className="nb-press inline-flex items-center gap-1 bg-[#F3E8B8] px-2 py-1 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#CBE4D3]"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoveClipId(null);
                  setIsDeletingCategory((v) => !v);
                }}
                aria-pressed={isDeletingCategory}
                title={
                  isDeletingCategory
                    ? 'Cancel delete mode (Esc)'
                    : 'Delete clips by clip type'
                }
                aria-label="Delete clips by clip type"
                className={`nb-press inline-flex items-center gap-1 px-2 py-1 text-xs uppercase shadow-[2px_2px_0_#2C3038] ${
                  isDeletingCategory
                    ? 'bg-[#F4C7C3] text-[#1E293B]'
                    : 'bg-[#FCFBF8] text-[#1E293B] hover:bg-[#F4C7C3]'
                }`}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}

          {isDeletingCategory && (
            <span className="ml-1 inline-flex items-center gap-1.5 border-2 border-[#2C3038] bg-[#F4C7C3] px-2 py-0.5 text-[11px] font-bold uppercase text-[#1E293B]">
              Pick a clip type to delete
            </span>
          )}

          {moveClipId && selectedClip?.id === moveClipId && (
            <span className="ml-1 inline-flex items-center gap-1.5 border-2 border-[#2C3038] bg-[#CBDDF0] px-2 py-0.5 text-[11px] font-bold uppercase text-[#1E293B]">
              Pick a clip type to move
            </span>
          )}
        </div>

        {isCreatingCategory && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-2 border-[#2C3038] bg-[#EAE6DC] px-2.5 py-2">
            <span className="mr-1 text-[11px] font-bold uppercase text-[#475569]">
              TYPES:
            </span>
            {BUILTIN_CATEGORIES.map((builtinId) => {
              const meta = CATEGORY_META[builtinId];
              const isSelectedType = newCategoryBaseType === builtinId;
              return (
                <button
                  key={builtinId}
                  type="button"
                  onClick={() => handleTypeTemplateClick(builtinId)}
                  title={
                    newCategoryName.trim()
                      ? `Use ${meta.label} as the type for "${newCategoryName.trim()}"`
                      : `Create/restore "${meta.label}" clip folder`
                  }
                  className={`nb-press inline-flex items-center gap-1 px-2 py-0.5 text-[11px] uppercase shadow-[2px_2px_0_#2C3038] ${
                    isSelectedType
                      ? 'bg-[#1E293B] text-[#FCFBF8]'
                      : 'bg-[#FCFBF8] text-[#1E293B] hover:bg-[#F3E8B8]'
                  }`}
                >
                  <CategoryIcon category={builtinId} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Main Split Pane */}
      <main className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-12">
        {/* Left List */}
        <section
          aria-label="Clip history"
          className="overflow-y-auto border-b-2 border-[#2C3038] bg-[#F5F3EE] p-3 md:col-span-5 md:border-b-0 md:border-r-2"
        >
          {filteredClips.length === 0 ? (
            <div className="flex h-full min-h-[180px] flex-col items-center justify-center border-2 border-dashed border-[#2C3038] bg-[#FCFBF8] px-6 text-center text-[#1E293B]">
              <ClipboardPaste
                className="mb-2 h-8 w-8 text-[#475569]"
                aria-hidden="true"
              />
              <p className="text-sm font-bold uppercase">No clips found</p>
              <p className="mt-1 text-xs text-[#475569]">
                Copy text, screenshots, or files, or drag and drop files here.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {filteredClips.map((clip) => {
                const isSelected = selectedClip?.id === clip.id;
                const meta = getCategoryMeta(clip.category, customCategories);
                const secret = isClipSecret(clip, customCategories);
                const rawPreview = secret
                  ? getClipMaskedDisplay(clip)
                  : clip.content;
                const compactPreview = rawPreview.replace(/\s+/g, ' ').trim();
                const preview =
                  compactPreview.length > 140
                    ? `${compactPreview.slice(0, 140)}…`
                    : compactPreview;

                return (
                  <li key={clip.id} className="overflow-hidden">
                    <div
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(e) =>
                        handleClipDragStart(e, clip, customCategories)
                      }
                      onClick={() => setSelectedId(clip.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedId(clip.id);
                        }
                      }}
                      aria-current={isSelected ? 'true' : undefined}
                      className={`nb-press w-full cursor-grab select-none overflow-hidden p-3 text-left font-normal active:cursor-grabbing ${
                        isSelected
                          ? 'bg-[#F3E8B8] shadow-[4px_4px_0_#2C3038]'
                          : 'bg-[#FCFBF8] hover:bg-[#EAE6DC]/60'
                      }`}
                    >
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className={`inline-flex shrink-0 items-center gap-1 px-2 py-0.5 text-[10px] font-bold uppercase ${meta.badgeClass}`}
                          >
                            <CategoryIcon
                              category={clip.category}
                              customCategories={customCategories}
                            />
                            {meta.label}
                          </span>
                          {clip.title && (
                            <span className="truncate text-xs font-bold text-[#1E293B]">
                              {clip.title}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#475569]">
                          {clip.pinned && (
                            <span
                              className="inline-flex items-center border-2 border-[#2C3038] bg-[#F3E8B8] p-0.5"
                              title="Pinned"
                            >
                              <Pin
                                className="h-3 w-3 text-[#1E293B]"
                                aria-label="Pinned"
                              />
                            </span>
                          )}
                          <span>{formatRelativeTime(clip.createdAt)}</span>
                        </div>
                      </div>

                      {secret && clip.kind !== 'text' ? (
                        <p className="truncate font-mono text-xs font-bold text-[#1E293B]">
                          •••••••••••• · Hidden Secret{' '}
                          {clip.kind === 'image' ? 'Image' : 'File'}
                        </p>
                      ) : clip.kind === 'image' && clip.media?.dataUrl ? (
                        <div className="flex items-center gap-3">
                          <img
                            src={clip.media.dataUrl}
                            alt={clip.media.fileName}
                            width={56}
                            height={44}
                            draggable={false}
                            className="h-11 w-14 shrink-0 border-2 border-[#2C3038] object-cover"
                          />
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold text-[#1E293B]">
                              {clip.media.fileName}
                            </p>
                            <p className="text-[11px] font-medium text-[#475569]">
                              {clip.media.width && clip.media.height
                                ? `${clip.media.width}×${clip.media.height} · `
                                : ''}
                              {formatBytes(clip.media.sizeBytes)}
                            </p>
                          </div>
                        </div>
                      ) : clip.kind === 'file' && clip.media ? (
                        <div className="flex items-center gap-3">
                          <div className="flex h-10 w-10 shrink-0 items-center justify-center border-2 border-[#2C3038] bg-[#CBDDF0] text-[#1E293B]">
                            <FileIcon className="h-4 w-4" aria-hidden="true" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-bold text-[#1E293B]">
                              {clip.media.fileName}
                            </p>
                            <p className="text-[11px] font-medium text-[#475569]">
                              {formatBytes(clip.media.sizeBytes)}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <p className="line-clamp-2 max-h-[40px] overflow-hidden break-words font-mono text-xs leading-relaxed text-[#1E293B]">
                          {preview}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Right Inspector */}
        <section
          aria-label="Clip inspector"
          className="flex min-h-0 flex-col bg-[#F5F3EE] p-4 md:col-span-7"
        >
          {selectedClip ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  {editingTitleId === selectedClip.id ? (
                    <form
                      className="flex min-w-[160px] flex-1 items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const trimmed = titleDraft.trim();
                        setClips((prev) =>
                          prev.map((c) =>
                            c.id === selectedClip.id
                              ? { ...c, title: trimmed || undefined }
                              : c,
                          ),
                        );
                        setEditingTitleId(null);
                        setTitleDraft('');
                      }}
                    >
                      <input
                        ref={titleInputRef}
                        type="text"
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        placeholder="Add title / remark..."
                        maxLength={60}
                        aria-label="Clip title or remark"
                        className="min-w-0 flex-1 border-2 border-[#2C3038] bg-[#FCFBF8] px-2 py-0.5 text-xs font-bold text-[#1E293B] shadow-[2px_2px_0_#2C3038] placeholder:text-[#64748B]"
                      />
                      <button
                        type="submit"
                        className="nb-press shrink-0 bg-[#CBE4D3] px-2 py-0.5 text-xs uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingTitleId(null);
                          setTitleDraft('');
                        }}
                        aria-label="Cancel title edit"
                        className="nb-press shrink-0 bg-[#F4C7C3] p-1 text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingTitleId(selectedClip.id);
                        setTitleDraft(selectedClip.title ?? '');
                      }}
                      title="Add or edit title / remark for this clip"
                      className={`nb-press inline-flex min-w-[110px] max-w-full flex-1 items-center gap-1.5 bg-[#FCFBF8] px-2.5 py-1 text-left text-xs shadow-[2px_2px_0_#2C3038] hover:bg-[#EAE6DC]/60 ${
                        selectedClip.title ? 'text-[#1E293B]' : 'text-[#475569]'
                      }`}
                    >
                      <Pencil className="h-3 w-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">
                        {selectedClip.title || 'Add Title'}
                      </span>
                    </button>
                  )}
                  <span
                    className={`inline-flex shrink-0 items-center gap-1 px-2.5 py-1 text-xs font-bold uppercase ${getCategoryMeta(selectedClip.category, customCategories).badgeClass}`}
                  >
                    <CategoryIcon category={selectedClip.category} />
                    {getCategoryMeta(selectedClip.category, customCategories).label}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleTogglePin(selectedClip.id)}
                    aria-label={selectedClip.pinned ? 'Unpin clip' : 'Pin clip'}
                    aria-pressed={Boolean(selectedClip.pinned)}
                    title={selectedClip.pinned ? 'Unpin clip' : 'Pin clip'}
                    className={`nb-press p-1.5 shadow-[2px_2px_0_#2C3038] ${
                      selectedClip.pinned
                        ? 'bg-[#F3E8B8] text-[#1E293B]'
                        : 'bg-[#FCFBF8] text-[#1E293B] hover:bg-[#F3E8B8]'
                    }`}
                  >
                    <Pin className="h-4 w-4" aria-hidden="true" />
                  </button>

                  <button
                    type="button"
                    onClick={() => void handleCopyItem(selectedClip)}
                    className="nb-press inline-flex items-center gap-1.5 bg-[#CBE4D3] px-3 py-1.5 text-xs text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#F3E8B8]"
                  >
                    {copiedId === selectedClip.id ? (
                      <>
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                        {selectedClip.kind === 'image'
                          ? 'Copy Image'
                          : selectedClip.kind === 'file'
                            ? 'Copy File'
                            : 'Copy'}
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() =>
                      setMoveClipId((prev) =>
                        prev === selectedClip.id ? null : selectedClip.id,
                      )
                    }
                    aria-pressed={moveClipId === selectedClip.id}
                    title={
                      moveClipId === selectedClip.id
                        ? 'Cancel move (Esc)'
                        : `Move clip to another clip type (${modPrefix}E)`
                    }
                    className={`nb-press inline-flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase shadow-[2px_2px_0_#2C3038] ${
                      moveClipId === selectedClip.id
                        ? 'bg-[#1E293B] text-[#FCFBF8]'
                        : 'bg-[#CBDDF0] text-[#1E293B] hover:bg-[#F3E8B8]'
                    }`}
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    {moveClipId === selectedClip.id ? 'Cancel' : 'MOVE'}
                  </button>

                  <button
                    type="button"
                    onClick={() => requestDeleteClip(selectedClip)}
                    aria-label="Delete clip"
                    title={`Delete clip (${modPrefix}X)`}
                    className="nb-press bg-[#F4C7C3] p-1.5 text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>

              {/* Privacy Guard Banner */}
              {isClipSecret(selectedClip, customCategories) && (
                <div className="mb-3 flex items-center justify-between gap-3 border-2 border-[#2C3038] bg-[#F4C7C3] px-3.5 py-2.5 text-xs font-bold text-[#1E293B] shadow-[3px_3px_0_#2C3038]">
                  <div className="flex items-center gap-2">
                    <ShieldAlert
                      className="h-4 w-4 shrink-0 text-[#1E293B]"
                      aria-hidden="true"
                    />
                    <span>
                      <strong>Privacy Guard:</strong>{' '}
                      {selectedClip.privacyReason ?? 'Secret clip'} — masked
                      and blocked from external AI APIs.
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setRevealedIds((prev) => ({
                        ...prev,
                        [selectedClip.id]: !prev[selectedClip.id],
                      }))
                    }
                    className="nb-press inline-flex shrink-0 items-center gap-1 bg-[#FCFBF8] px-2.5 py-1 text-[11px] uppercase text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
                  >
                    {isRevealed ? (
                      <>
                        <EyeOff className="h-3 w-3" aria-hidden="true" /> Hide
                      </>
                    ) : (
                      <>
                        <Eye className="h-3 w-3" aria-hidden="true" /> Reveal
                      </>
                    )}
                  </button>
                </div>
              )}

              {/* Content Viewer: Image / File / Text */}
              {isClipSecret(selectedClip, customCategories) &&
              !isRevealed &&
              selectedClip.kind !== 'text' ? (
                <div className="nb-card flex min-h-0 flex-1 flex-col items-center justify-center p-6 text-center shadow-[4px_4px_0_#2C3038]">
                  <div className="mb-3 flex h-14 w-14 items-center justify-center border-2 border-[#2C3038] bg-[#F4C7C3] text-[#1E293B] shadow-[3px_3px_0_#2C3038]">
                    <KeyRound className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <p className="text-sm font-bold uppercase text-[#1E293B]">
                    Hidden Secret{' '}
                    {selectedClip.kind === 'image' ? 'Image' : 'File'}
                  </p>
                  <p className="mt-1 font-mono text-xs font-bold text-[#475569]">
                    ••••••••••••
                  </p>
                </div>
              ) : selectedClip.kind === 'image' && selectedClip.media ? (
                <div
                  draggable
                  onDragStart={(e) =>
                    handleClipDragStart(e, selectedClip, customCategories)
                  }
                  className="nb-card flex min-h-0 flex-1 cursor-grab flex-col items-center justify-center overflow-hidden p-4 shadow-[4px_4px_0_#2C3038] active:cursor-grabbing"
                >
                  <div className="flex min-h-0 w-full flex-1 items-center justify-center">
                    {selectedClip.media.dataUrl ? (
                      <img
                        src={selectedClip.media.dataUrl}
                        alt={selectedClip.media.fileName}
                        className="max-h-full max-w-full border-2 border-[#2C3038] object-contain"
                      />
                    ) : (
                      <p className="text-xs font-bold text-[#1E293B]">
                        Preview unavailable
                      </p>
                    )}
                  </div>
                  <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 border-2 border-[#2C3038] bg-[#F3E8B8] px-3 py-1 text-xs font-bold text-[#1E293B]">
                    <span>{selectedClip.media.fileName}</span>
                    <span>·</span>
                    <span>{formatBytes(selectedClip.media.sizeBytes)}</span>
                    {selectedClip.media.width && selectedClip.media.height && (
                      <>
                        <span>·</span>
                        <span>
                          {selectedClip.media.width}×{selectedClip.media.height}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ) : selectedClip.kind === 'file' && selectedClip.media ? (
                <div
                  draggable
                  onDragStart={(e) =>
                    handleClipDragStart(e, selectedClip, customCategories)
                  }
                  className="nb-card flex min-h-0 flex-1 cursor-grab flex-col items-center justify-center p-6 text-center shadow-[4px_4px_0_#2C3038] active:cursor-grabbing"
                >
                  <div className="mb-3 flex h-14 w-14 items-center justify-center border-2 border-[#2C3038] bg-[#CBDDF0] text-[#1E293B] shadow-[3px_3px_0_#2C3038]">
                    <FileIcon className="h-7 w-7" aria-hidden="true" />
                  </div>
                  <p className="text-sm font-bold text-[#1E293B]">
                    {selectedClip.media.fileName}
                  </p>
                  <p className="mt-1 text-xs font-bold text-[#475569]">
                    {selectedClip.media.mimeType} ·{' '}
                    {formatBytes(selectedClip.media.sizeBytes)}
                  </p>
                  {selectedClip.media.localPath && (
                    <p className="mt-3 max-w-md truncate border-2 border-[#2C3038] bg-[#F3E8B8] px-3 py-1 font-mono text-[11px] font-bold text-[#1E293B]">
                      {selectedClip.media.localPath}
                    </p>
                  )}
                </div>
              ) : getCategoryBaseType(
                  selectedClip.category,
                  customCategories,
                ) === 'code' ? (
                <div
                  className={`min-h-0 flex-1 overflow-auto border-2 border-[#2C3038] p-4 shadow-[4px_4px_0_#2C3038] ${
                    codeTheme === 'dark'
                      ? 'bg-[#161922] text-[#E2E8F0]'
                      : 'bg-[#FCFBF8] text-[#1E293B]'
                  }`}
                >
                  <pre
                    style={{ fontFamily: 'inherit' }}
                    className="m-0 text-xs font-bold leading-relaxed"
                  >
                    {(isClipSecret(selectedClip, customCategories) &&
                    !isRevealed
                      ? getClipMaskedDisplay(selectedClip)
                      : selectedClip.content
                    )
                      .split('\n')
                      .map((line, lineIdx) => (
                        <div key={lineIdx} className="flex">
                          <span
                            aria-hidden="true"
                            className={`mr-4 inline-block w-7 shrink-0 select-none text-right text-[11px] ${
                              codeTheme === 'dark'
                                ? 'text-[#475569]'
                                : 'text-[#94A3B8]'
                            }`}
                          >
                            {lineIdx + 1}
                          </span>
                          <code
                            style={{ fontFamily: 'inherit' }}
                            className="min-w-0 flex-1 whitespace-pre-wrap break-words"
                          >
                            {tokenizeCodeLine(line).map((tok, tokIdx) => (
                              <span
                                key={tokIdx}
                                className={CODE_TOKEN_CLASSES[codeTheme][tok.type]}
                              >
                                {tok.value}
                              </span>
                            ))}
                          </code>
                        </div>
                      ))}
                  </pre>
                </div>
              ) : (
                <pre
                  draggable
                  onDragStart={(e) =>
                    handleClipDragStart(e, selectedClip, customCategories)
                  }
                  className="nb-card min-h-0 flex-1 cursor-grab overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-[#1E293B] shadow-[4px_4px_0_#2C3038] active:cursor-grabbing"
                >
                  {isClipSecret(selectedClip, customCategories) && !isRevealed
                    ? getClipMaskedDisplay(selectedClip)
                    : selectedClip.content}
                </pre>
              )}

              {/* Media File Actions & Status Toast */}
              <div className="mt-4 flex min-h-[44px] flex-wrap items-center justify-between gap-2 border-t-2 border-[#2C3038] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  {selectedClip.kind === 'text' &&
                    getCategoryBaseType(
                      selectedClip.category,
                      customCategories,
                    ) === 'code' && (
                      <button
                        type="button"
                        onClick={() =>
                          setCodeTheme((prev) =>
                            prev === 'dark' ? 'light' : 'dark',
                          )
                        }
                        aria-pressed={codeTheme === 'dark'}
                        title={
                          codeTheme === 'dark'
                            ? 'Switch code view to White mode'
                            : 'Switch code view to Dark terminal mode'
                        }
                        className={`nb-press inline-flex items-center gap-1.5 px-3 py-1.5 text-xs uppercase shadow-[2px_2px_0_#2C3038] ${
                          codeTheme === 'dark'
                            ? 'bg-[#1E293B] text-[#FCFBF8] hover:bg-[#334155]'
                            : 'bg-[#FCFBF8] text-[#1E293B] hover:bg-[#F3E8B8]'
                        }`}
                      >
                        {codeTheme === 'dark' ? (
                          <>
                            <Moon className="h-3.5 w-3.5" aria-hidden="true" />
                            Dark Mode
                          </>
                        ) : (
                          <>
                            <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                            White Mode
                          </>
                        )}
                      </button>
                    )}
                  {(selectedClip.kind === 'image' ||
                    selectedClip.kind === 'file') && (
                    <>
                      {isElectron && selectedClip.media?.localPath && (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              void window.electronAPI?.showInFinder(
                                selectedClip.media!.localPath!,
                              )
                            }
                            className="nb-press inline-flex items-center gap-1.5 bg-[#F3E8B8] px-3 py-1.5 text-xs text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
                          >
                            <FolderOpen
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                            Show in Finder
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void window.electronAPI?.openFile(
                                selectedClip.media!.localPath!,
                              )
                            }
                            className="nb-press inline-flex items-center gap-1.5 bg-[#CBDDF0] px-3 py-1.5 text-xs text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
                          >
                            <ExternalLink
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                            Open File
                          </button>
                        </>
                      )}
                      {selectedClip.media?.dataUrl && (
                        <a
                          href={selectedClip.media.dataUrl}
                          download={selectedClip.media.fileName}
                          className="nb-press inline-flex items-center gap-1.5 bg-[#CBE4D3] px-3 py-1.5 text-xs text-[#1E293B] shadow-[2px_2px_0_#2C3038]"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          Download Copy
                        </a>
                      )}
                    </>
                  )}
                </div>
                {(statusMessage || actionToast) && (
                  <span
                    role="status"
                    className="border-2 border-[#2C3038] bg-[#CBE4D3] px-2 py-0.5 text-xs font-bold text-[#1E293B]"
                  >
                    {actionToast ?? statusMessage}
                  </span>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center border-2 border-dashed border-[#2C3038] bg-[#FCFBF8] text-sm font-bold uppercase text-[#1E293B]">
              Select a clip to inspect
            </div>
          )}
        </section>
      </main>

      {/* Footer Keyboard Hints */}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-[#2C3038] bg-[#EAE6DC] px-4 py-1.5 text-[11px] font-bold text-[#475569]">
        <div className="flex flex-wrap items-center gap-3">
          <span>↑↓ Navigate</span>
          <span>↵ / {modPrefix}C Copy</span>
          <span>{modPrefix}X Delete</span>
          <span>{modPrefix}K Search</span>
          <span>{modPrefix}V / Drop Files</span>
          <span>{modPrefix}E Move</span>
          <span>{modPrefix}T New Type</span>
          {isElectron && (
            <>
              <span>
                {shortcutConfig.toggleShortcut
                  .replace(/CmdOrCtrl/gi, isWindows ? 'Ctrl' : '⌘')
                  .replace(/Super|Cmd|Command/gi, '⌘')
                  .replace(/Alt|Option/gi, isWindows ? 'Alt' : '⌥')
                  .replace(/Shift/gi, isWindows ? 'Shift+' : '⇧')
                  .replace(/\+/g, isWindows ? '+' : '')}{' '}
                Toggle Window
              </span>
              <span>
                {shortcutConfig.drawerShortcut
                  .replace(/CmdOrCtrl/gi, isWindows ? 'Ctrl' : '⌘')
                  .replace(/Super|Cmd|Command/gi, '⌘')
                  .replace(/Alt|Option/gi, isWindows ? 'Alt' : '⌥')
                  .replace(/Shift/gi, isWindows ? 'Shift+' : '⇧')
                  .replace(/\+/g, isWindows ? '+' : '')}{' '}
                Quick Popup
              </span>
            </>
          )}
        </div>
        <span>100% Local-First · On-Device Storage</span>
      </footer>
    </div>
  );
}

export default App;
