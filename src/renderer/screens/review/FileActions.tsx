import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { DiffFile } from '@shared/diff';
import { EDITOR_LABELS, preferredEditor, type EditorId, type EditorInfo } from '@shared/editor';
import { imeComposing } from '../../keys';

type MenuKind = 'copy' | 'tree' | 'editor';
type MenuPoint = { x: number; y: number };
type MenuOptions = { point?: MenuPoint; line?: number };
type Menu = MenuOptions & { kind: MenuKind; path: string; trigger: HTMLElement };
type Feedback = { title: string; path: string; warning?: string };
type EditorTip = { anchor: HTMLButtonElement; label: string; reason?: string };
type EditorTipProps = Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'onPointerEnter' | 'onPointerLeave' | 'onFocus' | 'onBlur'>;

interface FileActions {
  editor: EditorInfo | undefined;
  editorLabel: string;
  editors: EditorInfo[];
  openReason: (path: string, editor?: EditorId | null) => string | undefined;
  open: (path: string, line?: number, editor?: EditorId) => Promise<void>;
  copy: (path: string, absolute?: boolean) => Promise<void>;
  showMenu: (kind: MenuKind, path: string, trigger: HTMLElement, options?: MenuOptions) => void;
  tipProps: (label: string, reason?: string) => EditorTipProps;
}

const FileActionsContext = createContext<FileActions | null>(null);
const FileMenuTriggerContext = createContext<HTMLElement | null>(null);
export const useFileActions = () => useContext(FileActionsContext);

const LINK_REPO = '需要关联本地仓库';
const TIP_DELAY_MS = 420;

function useEditorTip(enabled: boolean) {
  const [tip, setTip] = useState<EditorTip | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const target = useRef<HTMLButtonElement | null>(null);

  const hideTip = useCallback((anchor?: HTMLButtonElement) => {
    if (!target.current || (anchor && target.current !== anchor)) return;
    window.clearTimeout(timer.current);
    target.current = null;
    setTip(null);
  }, []);

  const tipProps = useCallback((label: string, reason?: string): EditorTipProps => {
    const show = (anchor: HTMLButtonElement, fromKeyboard: boolean) => {
      if (!enabled) return;
      hideTip();
      target.current = anchor;
      const reveal = () => {
        if (anchor.isConnected && anchor.getClientRects().length > 0) setTip({ anchor, label, reason });
      };
      if (fromKeyboard) reveal();
      else timer.current = window.setTimeout(reveal, TIP_DELAY_MS);
    };
    return {
      onPointerEnter: (e) => { if (e.pointerType !== 'touch') show(e.currentTarget, false); },
      onPointerLeave: (e) => hideTip(e.currentTarget),
      onFocus: (e) => { if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget, true); },
      onBlur: (e) => hideTip(e.currentTarget),
    };
  }, [enabled, hideTip]);

  useEffect(() => {
    if (!enabled) {
      hideTip();
      return;
    }
    const dismiss = () => hideTip();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hideTip(); };
    const viewport = window.visualViewport;
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('keydown', onKey);
    viewport?.addEventListener('resize', dismiss);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('keydown', onKey);
      viewport?.removeEventListener('resize', dismiss);
    };
  }, [enabled, hideTip]);

  return { tip, tipProps, hideTip };
}

function EditorActionTip({ tip }: { tip: EditorTip }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup || !tip.anchor.isConnected) return;
    const anchor = tip.anchor.getBoundingClientRect();
    const { width, height } = popup.getBoundingClientRect();
    const x = anchor.left + (anchor.width - width) / 2;
    const below = anchor.bottom + 5;
    const maxTop = window.innerHeight - height - 6;
    const y = below <= maxTop ? below : anchor.top - height - 5;
    popup.style.left = `${Math.max(6, Math.min(x, window.innerWidth - width - 6))}px`;
    popup.style.top = `${Math.max(6, Math.min(y, maxTop))}px`;
    popup.style.visibility = 'visible';
  }, [tip]);

  return createPortal(
    <div className="file-action-tip" ref={ref} role="tooltip">
      <span>{tip.label}</span>
      {tip.reason && <span className="file-action-tip-reason">{tip.reason}</span>}
    </div>,
    document.body,
  );
}

export function FileActionsProvider({
  reviewId, repoPath, files, defaultEditor, editors, editorsLoaded, active, children,
}: {
  reviewId: string;
  repoPath?: string | null;
  files: DiffFile[];
  defaultEditor: EditorId | null;
  editors: EditorInfo[];
  editorsLoaded: boolean;
  active: boolean;
  children: ReactNode;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const { tip, tipProps, hideTip } = useEditorTip(active && !menu);
  const deleted = useMemo(() => new Set(files.filter((f) => f.status === 'deleted').map((f) => f.path)), [files]);
  const editor = preferredEditor(defaultEditor, editors);
  const editorLabel = editor ? `在 ${EDITOR_LABELS[editor.id]} 中打开` : '在编辑器中打开';

  useEffect(() => {
    if (!active) {
      setMenu(null);
      setFeedback(null);
    }
  }, [active]);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), feedback.warning ? 5200 : 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const openReason = useCallback((path: string, editorId = defaultEditor) => {
    if (deleted.has(path)) return '此文件已在本次改动中删除';
    if (!repoPath) return LINK_REPO;
    if (!editorsLoaded) return '正在检测编辑器';
    if (!preferredEditor(editorId, editors)) {
      return editorId ? `未检测到 ${EDITOR_LABELS[editorId]}` : '未找到可用的编辑器';
    }
  }, [defaultEditor, deleted, editors, editorsLoaded, repoPath]);

  const open = useCallback(async (path: string, line?: number, editorId = defaultEditor) => {
    hideTip();
    const location = line === undefined ? path : `${path}:${line}`;
    const fail = (warning: string) => setFeedback({ title: '无法打开文件', path: location, warning });
    const reason = openReason(path, editorId);
    if (reason) return fail(reason);
    try {
      const result = await window.duetlens.review.openInEditor(reviewId, path, line, editorId);
      if (!result.ok) return fail(result.message);
      setFeedback({ title: editorId ? `在 ${EDITOR_LABELS[editorId]} 中打开` : editorLabel, path: location, warning: result.warning });
    } catch {
      fail('无法连接到编辑器');
    }
  }, [defaultEditor, editorLabel, hideTip, openReason, reviewId]);

  const copy = useCallback(async (path: string, absolute = false) => {
    const fail = (warning: string) => setFeedback({ title: '无法复制路径', path, warning });
    let copiedPath = path;
    if (absolute) {
      if (!repoPath) return fail(LINK_REPO);
      try {
        const result = await window.duetlens.review.resolveFilePath(reviewId, path);
        if (!result.ok) return fail(result.message);
        copiedPath = result.path;
      } catch {
        return fail('无法读取本地仓库路径');
      }
    }
    try {
      await navigator.clipboard.writeText(copiedPath);
      setFeedback({ title: absolute ? '已复制绝对路径' : '已复制相对路径', path: copiedPath });
    } catch {
      fail('请检查剪贴板权限');
    }
  }, [repoPath, reviewId]);

  const showMenu = useCallback<FileActions['showMenu']>((kind, path, trigger, options) => {
    hideTip();
    setMenu((current) => !options?.point && current?.trigger === trigger ? null : { kind, path, trigger, ...options });
  }, [hideTip]);

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenu(null);
    if (restoreFocus) menu?.trigger.focus({ preventScroll: true });
  }, [menu]);
  const actions = useMemo(() => ({ editor, editorLabel, editors, openReason, open, copy, showMenu, tipProps }),
    [editor, editorLabel, editors, openReason, open, copy, showMenu, tipProps]);

  return (
    <FileActionsContext.Provider value={actions}>
      <FileMenuTriggerContext.Provider value={menu?.trigger ?? null}>
        {children}
      </FileMenuTriggerContext.Provider>
      {active && !menu && tip && <EditorActionTip tip={tip} />}
      {active && menu && (
        <FileActionMenu
          menu={menu}
          absoluteReason={repoPath ? undefined : LINK_REPO}
          close={closeMenu}
        />
      )}
      {active && createPortal(
        <div className="file-action-status" role="status">
          {feedback && (
            <div className="file-action-toast">
              <strong>{feedback.title}</strong>
              <code>{feedback.path}</code>
              {feedback.warning && <span>{feedback.warning}</span>}
            </div>
          )}
        </div>,
        document.body,
      )}
    </FileActionsContext.Provider>
  );
}

export function OpenEditorButton({ path, line, filename }: { path: string; line?: number; filename?: string }) {
  const actions = useFileActions();
  if (!actions) return null;
  const reason = actions.openReason(path);
  const label = line === undefined ? actions.editorLabel : `${actions.editorLabel} · 第 ${line} 行`;
  const canChoose = !filename && actions.editors.some(({ id }) => id !== actions.editor?.id && !actions.openReason(path, id));
  const openButton = (
    <button
      type="button"
      className={filename ? 'fh-name fh-open-name' : 'file-action-icon editor-open'}
      title={filename ? [label, reason, path].filter(Boolean).join(' · ') : undefined}
      aria-label={filename ? `${filename} · ${label}` : label}
      aria-description={reason}
      aria-disabled={reason ? true : undefined}
      {...(!filename && actions.tipProps(label, reason))}
      onClick={(e) => {
        e.stopPropagation();
        void actions.open(path, line);
      }}
    >
      {filename || <EditorGlyph editor={actions.editor} />}
    </button>
  );
  if (!canChoose) return openButton;
  return (
    <span className="file-action-split editor-open-split" role="group" aria-label="在编辑器中打开">
      {openButton}
      <FileMenuTrigger kind="editor" path={path} line={line} />
    </span>
  );
}

export function FileCopySplit({ path }: { path: string }) {
  const actions = useFileActions();
  if (!actions) return null;
  return (
    <span className="file-action-split" role="group" aria-label="复制文件路径">
      <button
        type="button"
        className="file-action-icon"
        title="复制相对路径"
        aria-label="复制相对路径"
        onClick={() => void actions.copy(path)}
      >
        <CopyPathIcon />
      </button>
      <FileMenuTrigger kind="copy" path={path} />
    </span>
  );
}

export function FileMenuTrigger({ kind, path, line, name, triggerRef }: {
  kind: MenuKind;
  path: string;
  line?: number;
  name?: string;
  triggerRef?: RefObject<HTMLButtonElement>;
}) {
  const actions = useFileActions();
  const expanded = useContext(FileMenuTriggerContext);
  const innerRef = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? innerRef;
  if (!actions) return null;
  const tree = kind === 'tree';
  const label = kind === 'copy' ? '更多路径选项' : kind === 'editor' ? '选择编辑器' : '文件操作';
  return (
    <button
      ref={trigger}
      type="button"
      className={`file-action-icon ${tree ? 'file-more' : 'file-action-arrow'}`}
      aria-haspopup="menu"
      aria-expanded={expanded !== null && expanded === trigger.current}
      aria-label={tree ? `${name} 的文件操作` : label}
      title={kind === 'editor' ? undefined : label}
      {...(kind === 'editor' && actions.tipProps(label))}
      onClick={(e) => {
        e.stopPropagation();
        actions.showMenu(kind, path, e.currentTarget, { line });
      }}
    >
      {!tree ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="m4 6 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="13" cy="8" r="1.1" />
        </svg>
      )}
    </button>
  );
}

function FileActionMenu({ menu, absoluteReason, close }: {
  menu: Menu;
  absoluteReason?: string;
  close: (restoreFocus: boolean) => void;
}) {
  const actions = useFileActions()!;
  const popup = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = popup.current;
    if (!el) return;
    const anchor = menu.trigger.getBoundingClientRect();
    const { width, height } = el.getBoundingClientRect();
    const x = menu.point?.x ?? anchor.left;
    const y = menu.point?.y ?? anchor.bottom + 4;
    const above = (menu.point?.y ?? anchor.top) - height - 4;
    el.style.left = `${Math.max(6, Math.min(x, window.innerWidth - width - 6))}px`;
    el.style.top = `${Math.max(6, y + height <= window.innerHeight - 6 ? y : above)}px`;
    el.querySelector('button')?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    const dismissOutside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!popup.current?.contains(target) && !menu.trigger.contains(target)) close(false);
    };
    const dismissOnScroll = (e: Event) => {
      if (!popup.current?.contains(e.target as Node)) close(false);
    };
    const dismiss = () => close(false);
    window.addEventListener('pointerdown', dismissOutside, true);
    window.addEventListener('scroll', dismissOnScroll, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('pointerdown', dismissOutside, true);
      window.removeEventListener('scroll', dismissOnScroll, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [menu.trigger, close]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (imeComposing(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.stopPropagation();
      if (e.key === 'Escape') e.preventDefault();
      close(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const buttons = Array.from(e.currentTarget.querySelectorAll('button'));
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 :
      (i + buttons.length + (e.key === 'ArrowDown' ? 1 : -1)) % buttons.length;
    buttons[next]?.focus();
  };

  const choose = (action: () => Promise<void>) => () => {
    close(true);
    void action();
  };
  const { kind, path, line } = menu;
  const openReason = actions.openReason(path);
  return createPortal(
    <div
      className="file-action-menu" ref={popup} role="menu"
      aria-label={kind === 'editor' ? '选择编辑器' : '文件操作'}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {kind === 'editor' ? actions.editors.map((editor) => (
        <button
          key={editor.id} type="button" role="menuitem" tabIndex={-1}
          onClick={choose(() => actions.open(path, line, editor.id))}
        >
          <EditorGlyph editor={editor} iconOnly />
          <span>{EDITOR_LABELS[editor.id]}</span>
          {editor.id === actions.editor?.id && <small className="file-editor-default">默认</small>}
        </button>
      )) : (
        <>
          <button type="button" role="menuitem" tabIndex={-1} onClick={choose(() => actions.copy(path))}>
            <CopyPathIcon />
            <span>复制相对路径</span>
          </button>
          <button
            type="button" role="menuitem" tabIndex={-1} aria-disabled={absoluteReason ? true : undefined}
            onClick={choose(() => actions.copy(path, true))}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2M3 7v11a2 2 0 0 0 2 2h13a2 2 0 0 0 2-1.5l2-7.5H8l-2 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>复制绝对路径{absoluteReason && <small>{absoluteReason}</small>}</span>
          </button>
          {kind === 'tree' && (
            <>
              <div className="file-menu-divider" role="separator" />
              <button
                type="button" role="menuitem" tabIndex={-1} aria-disabled={openReason ? true : undefined}
                onClick={choose(() => actions.open(path))}
              >
                <EditorGlyph editor={actions.editor} />
                <span>{actions.editorLabel}{openReason && <small>{openReason}</small>}</span>
              </button>
            </>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}

function CopyPathIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" strokeLinecap="round" />
    </svg>
  );
}

function EditorGlyph({ editor, iconOnly }: { editor: EditorInfo | undefined; iconOnly?: boolean }) {
  return (
    <span className="editor-glyph" aria-hidden="true">
      {editor?.icon && <img className="editor-brand" alt="" src={editor.icon} draggable={false} />}
      {(!iconOnly || !editor?.icon) && <ExternalIcon />}
    </span>
  );
}

export const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.5 4.5H19.5V10.5" />
    <path d="M19.5 4.5 11 13" />
    <path d="M18 14.5v4a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h4" />
  </svg>
);
