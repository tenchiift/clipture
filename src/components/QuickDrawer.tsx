import {
  Check,
  File as FileIcon,
  KeyRound,
  Pin,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import appIcon from '../assets/icon.png';
import { getMiniDragIcon, MINI_DRAG_ICON_DATA_URL } from '../lib/drag-icon';
import { maskNonApiSecretText } from '../lib/privacy-guard';
import type { ClipItem } from '../types/clip';

const CUSTOM_CATEGORIES_KEY = 'ai-clipper:custom-categories:v1';

interface StoredCustomCategory {
  id: string;
  label: string;
  baseType?: string;
}

function loadCustomCategories(): StoredCustomCategory[] {
  try {
    const raw = localStorage.getItem(CUSTOM_CATEGORIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredCustomCategory[]) : [];
  } catch {
    return [];
  }
}

function parseClips(raw: string | null | undefined): ClipItem[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ClipItem[]) : [];
  } catch {
    return [];
  }
}

function formatRelativeTime(iso: string): string {
  const diffSec = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
  if (diffSec < 60) return 'now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
}

export function QuickDrawer() {
  const [clips, setClips] = useState<ClipItem[]>(() =>
    parseClips(window.electronAPI?.initialClipsJson),
  );
  const [customCategories, setCustomCategories] = useState<
    StoredCustomCategory[]
  >(() => loadCustomCategories());
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [drawerShortcutLabel, setDrawerShortcutLabel] = useState(
    window.electronAPI?.platform === 'win32' ? 'Ctrl+Alt+V' : '⌥⌘V',
  );

  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const isClosingRef = useRef(false);

  const refreshClips = useCallback(async () => {
    setCustomCategories(loadCustomCategories());
    if (!window.electronAPI?.loadClips) return;
    try {
      const raw = await window.electronAPI.loadClips();
      if (raw) setClips(parseClips(raw));
    } catch {
      // Ignore read errors
    }
  }, []);

  const slideOutAndHide = useCallback(() => {
    if (isClosingRef.current) return;
    isClosingRef.current = true;
    setIsClosing(true);
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
    }
    closeTimerRef.current = window.setTimeout(() => {
      isClosingRef.current = false;
      void window.electronAPI?.hideDrawer?.();
    }, 180);
  }, []);

  useEffect(() => {
    searchRef.current?.focus();

    const unsubOpen = window.electronAPI?.onDrawerOpen?.(() => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      isClosingRef.current = false;
      setQuery('');
      setSelectedIndex(0);
      setCopiedId(null);
      setIsClosing(false);
      setCustomCategories(loadCustomCategories());
      const panel = panelRef.current;
      if (panel) {
        panel.classList.remove('drawer-morph-in', 'drawer-morph-out');
        void panel.offsetWidth;
        panel.classList.add('drawer-morph-in');
      }
      searchRef.current?.focus();
    });

    const unsubClose = window.electronAPI?.onDrawerClose?.(() => {
      slideOutAndHide();
    });

    const unsubUpdated = window.electronAPI?.onClipsUpdated?.(() => {
      void refreshClips();
    });

    const formatBadge = (raw: string) =>
      raw
        .replace(/CmdOrCtrl/gi, window.electronAPI?.platform === 'win32' ? 'Ctrl' : '⌘')
        .replace(/Super|Cmd|Command/gi, '⌘')
        .replace(/Alt|Option/gi, window.electronAPI?.platform === 'win32' ? 'Alt' : '⌥')
        .replace(/Shift/gi, '⇧')
        .replace(/\+/g, '');

    void window.electronAPI?.getShortcuts?.().then((cfg) => {
      if (cfg?.drawerShortcut) setDrawerShortcutLabel(formatBadge(cfg.drawerShortcut));
    });
    const unsubShortcuts = window.electronAPI?.onShortcutsUpdated?.((cfg) => {
      if (cfg?.drawerShortcut) setDrawerShortcutLabel(formatBadge(cfg.drawerShortcut));
    });

    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
      unsubOpen?.();
      unsubClose?.();
      unsubUpdated?.();
      unsubShortcuts?.();
    };
  }, [refreshClips, slideOutAndHide]);

  const isSecret = useCallback(
    (clip: ClipItem) => {
      if (clip.isSensitive || clip.category === 'secret') return true;
      const custom = customCategories.find((c) => c.id === clip.category);
      return custom?.baseType === 'secret';
    },
    [customCategories],
  );

  const getCategoryLabel = useCallback(
    (cat: string) => {
      const custom = customCategories.find((c) => c.id === cat);
      return custom ? custom.label : cat;
    },
    [customCategories],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = clips
      .filter((clip) => {
        if (!q) return true;
        const secret = isSecret(clip);
        const hay = secret
          ? `${clip.title ?? ''} ${clip.category} ${clip.tags.join(' ')}`
          : `${clip.title ?? ''} ${clip.content} ${clip.category} ${clip.tags.join(' ')}`;
        return hay.toLowerCase().includes(q);
      })
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    return q ? list : list.slice(0, 50);
  }, [clips, query, isSecret]);

  const handlePickClip = useCallback(
    async (clip: ClipItem) => {
      if (window.electronAPI) {
        if (clip.kind === 'image') {
          await window.electronAPI.writeImage({
            localPath: clip.media?.localPath,
            dataUrl: clip.media?.dataUrl,
          });
        } else if (clip.kind === 'file' && clip.media?.localPath) {
          await window.electronAPI.writeFile(clip.media.localPath);
        } else {
          await window.electronAPI.writeClipboard(clip.content);
        }
      }
      setCopiedId(clip.id);
      window.setTimeout(() => {
        slideOutAndHide();
      }, 140);
    },
    [slideOutAndHide],
  );

  const handleDragStart = useCallback(
    (e: DragEvent<HTMLElement>, clip: ClipItem) => {
      e.stopPropagation();
      const custom = customCategories.find((c) => c.id === clip.category);
      const baseType = custom?.baseType ?? clip.category;
      const isUrl =
        baseType === 'url' || /^https?:\/\//i.test(clip.content.trim());

      if (window.electronAPI?.isElectron && window.electronAPI.startDrag) {
        e.preventDefault();
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
        if (isUrl) {
          e.dataTransfer.setData('text/uri-list', clip.content.trim());
        }
        return;
      }
      if (clip.media?.localPath) {
        const fileUrl = `file://${encodeURI(clip.media.localPath)}`;
        e.dataTransfer.setData('text/uri-list', fileUrl);
        e.dataTransfer.setData('text/plain', clip.media.localPath);
        if (
          clip.kind === 'image' &&
          clip.media.dataUrl &&
          /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(
            clip.media.dataUrl,
          )
        ) {
          const safeAlt = clip.media.fileName
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
          e.dataTransfer.setData(
            'text/html',
            `<img src="${clip.media.dataUrl}" alt="${safeAlt}" />`,
          );
        }
      }
    },
    [customCategories],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        slideOutAndHide();
        return;
      }
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = filtered[selectedIndex] ?? filtered[0];
        if (target) void handlePickClip(target);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filtered, selectedIndex, handlePickClip, slideOutAndHide]);



  return (
    <div className="h-screen w-screen overflow-hidden bg-transparent p-2">
      <div
        ref={panelRef}
        className={`flex h-full w-full origin-top-left flex-col border-2 border-[#2C3038] bg-[#F5F3EE] text-[#1E293B] shadow-[4px_4px_0_#2C3038] ${
          isClosing ? 'drawer-morph-out' : 'drawer-morph-in'
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b-2 border-[#2C3038] bg-[#EAE6DC] px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <img
              src={appIcon}
              alt="Clipture"
              className="h-5 w-5 object-contain"
            />
            <span className="text-[11px] font-bold uppercase tracking-tight">
              Quick Clips
            </span>
            <kbd className="border-2 border-[#2C3038] bg-[#F3E8B8] px-1.5 py-0.5 text-[10px] font-bold">
              {drawerShortcutLabel}
            </kbd>
          </div>
          <button
            type="button"
            onClick={slideOutAndHide}
            aria-label="Close quick drawer"
            className="nb-press bg-[#FCFBF8] p-1 text-[#1E293B] shadow-[2px_2px_0_#2C3038] hover:bg-[#F4C7C3]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>

        {/* Search */}
        <div className="border-b-2 border-[#2C3038] bg-[#F5F3EE] p-2.5">
          <div className="relative flex items-center">
            <Search
              className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-[#475569]"
              aria-hidden="true"
            />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              placeholder="Search clips to copy..."
              className="w-full border-2 border-[#2C3038] bg-[#FCFBF8] py-1.5 pl-8 pr-2.5 text-xs font-medium text-[#1E293B] shadow-[2px_2px_0_#2C3038] placeholder:text-[#64748B]"
            />
          </div>
        </div>

        {/* Clips List */}
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {filtered.length === 0 ? (
            <div className="flex h-full items-center justify-center border-2 border-dashed border-[#2C3038] bg-[#FCFBF8] p-4 text-center text-xs font-bold uppercase text-[#475569]">
              No matching clips
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {filtered.map((clip, idx) => {
                const active = idx === selectedIndex;
                const secret = isSecret(clip);
                const isCopied = copiedId === clip.id;
                const masked = clip.isSensitive
                  ? clip.maskedPreview
                  : maskNonApiSecretText(clip.content);
                const textPreview = (secret ? masked : clip.content)
                  .replace(/\s+/g, ' ')
                  .trim();

                return (
                  <li key={clip.id} className="shrink-0">
                    <div
                      role="button"
                      tabIndex={0}
                      draggable
                      onDragStart={(e) => handleDragStart(e, clip)}
                      onClick={() => void handlePickClip(clip)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          void handlePickClip(clip);
                        }
                      }}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      className={`nb-press flex h-[76px] w-full cursor-grab select-none flex-col justify-between overflow-hidden p-2.5 text-left font-normal active:cursor-grabbing ${
                        isCopied
                          ? 'bg-[#CBE4D3] shadow-[3px_3px_0_#2C3038]'
                          : active
                            ? 'bg-[#F3E8B8] shadow-[3px_3px_0_#2C3038]'
                            : 'bg-[#FCFBF8] hover:bg-[#EAE6DC]/70'
                      }`}
                    >
                      <div className="flex w-full shrink-0 items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="shrink-0 border border-[#2C3038] bg-[#EAE6DC] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#1E293B]">
                            {getCategoryLabel(clip.category)}
                          </span>
                          {clip.title && (
                            <span className="truncate text-[11px] font-bold text-[#1E293B]">
                              {clip.title}
                            </span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-1 text-[10px] font-bold text-[#475569]">
                          {isCopied ? (
                            <span className="inline-flex items-center gap-0.5 text-[#1E293B]">
                              <Check className="h-3 w-3" aria-hidden="true" />
                              Copied
                            </span>
                          ) : (
                            <>
                              {clip.pinned && (
                                <Pin className="h-2.5 w-2.5" aria-hidden="true" />
                              )}
                              <span>{formatRelativeTime(clip.createdAt)}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {secret && clip.kind !== 'text' ? (
                        <div className="flex items-center gap-1.5 font-mono text-[11px] font-bold text-[#1E293B]">
                          <KeyRound className="h-3 w-3 shrink-0" aria-hidden="true" />
                          <span className="truncate">•••••••••••• · Hidden Secret</span>
                        </div>
                      ) : clip.kind === 'image' && clip.media?.dataUrl ? (
                        <div className="flex min-w-0 items-center gap-2">
                          <img
                            src={clip.media.dataUrl}
                            alt={clip.media.fileName}
                            draggable={false}
                            className="h-8 w-10 shrink-0 border border-[#2C3038] object-cover"
                          />
                          <span className="truncate text-[11px] font-bold text-[#1E293B]">
                            {clip.media.fileName}
                          </span>
                        </div>
                      ) : clip.kind === 'file' && clip.media ? (
                        <div className="flex min-w-0 items-center gap-2">
                          <FileIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                          <span className="truncate text-[11px] font-bold text-[#1E293B]">
                            {clip.media.fileName}
                          </span>
                        </div>
                      ) : (
                        <p className="line-clamp-2 w-full break-all font-mono text-[11px] leading-snug text-[#1E293B]">
                          {textPreview}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t-2 border-[#2C3038] bg-[#EAE6DC] px-3 py-1.5 text-[10px] font-bold text-[#475569]">
          <span>↑↓ Select · ↵ Copy &amp; Close</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
