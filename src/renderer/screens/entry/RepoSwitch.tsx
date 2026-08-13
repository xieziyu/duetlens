import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { clipBounds } from './BranchPicker';
import { baseName, parentDir } from './paths';

/** 菜单里最多列几个仓库(含当前这个)。 */
const LIMIT = 6;
/** 单行高度、浮层与触发器的间距 + 列表内边距、离裁切边留白、列表高度下限(不够就让它自己滚)。 */
const ROW_H = 30;
const CHROME = 16;
const EDGE_INSET = 10;
const ROWS_FLOOR = 60;

/**
 * 换仓库:最近审核过的目录直接摆进菜单,系统目录对话框退居末位一项 ——
 * 常用仓库就那么几个,不该每次都走一遍文件选择器。
 * 没有别的候选时(首次使用)退回单纯的按钮,不给一个只列着自己的菜单。
 */
export function RepoSwitch({
  current,
  recents,
  onPick,
  onBrowse,
}: {
  current: string;
  recents: string[];
  onPick: (dir: string) => void;
  onBrowse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ up: boolean; rowsMax: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const trigRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const rows = [current, ...recents.filter((p) => p !== current)].slice(0, LIMIT);
  const hasChoice = rows.length > 1;
  // 末位的「浏览其他目录…」也是一项:方向键会走到它上面
  const count = rows.length + 1;

  // 浮层落在会裁切的祖先(入口卡片 overflow:hidden)里,按可用空间定高、必要时上翻
  useLayoutEffect(() => {
    if (!open || !boxRef.current) {
      setPlace(null);
      return;
    }
    const trig = boxRef.current.getBoundingClientRect();
    const clip = clipBounds(boxRef.current);
    const want = rows.length * ROW_H;
    const room = (edge: number) => Math.floor(edge - CHROME - EDGE_INSET - ROW_H);
    const below = room(clip.bottom - trig.bottom);
    const above = room(trig.top - clip.top);
    const up = below < want && above > below;
    setPlace({ up, rowsMax: Math.min(want, Math.max(ROWS_FLOOR, up ? above : below)) });
  }, [open, rows.length]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  // 展开即把焦点交给菜单本身:菜单项是真按钮,高亮项就是焦点所在,
  // 于是读屏能报出方向键停在哪个仓库,Tab 出去也会经 onBlur 收起浮层(否则它会一直遮着下面的控件)。
  useEffect(() => {
    if (open) itemsRef.current[0]?.focus();
  }, [open]);

  if (!hasChoice) {
    return (
      <button type="button" className="pf-pick" onClick={onBrowse}>
        切换…
      </button>
    );
  }

  // 收起时把焦点还给触发器,除非焦点已经被用户挪走(点了别处 / Tab 出去)
  const close = (restore = true) => {
    setOpen(false);
    if (restore) trigRef.current?.focus();
  };

  const toggle = () => {
    if (open) close();
    else {
      setActive(0);
      setOpen(true);
    }
  };

  // 焦点即高亮,active 由菜单项的 onFocus 回填 —— 下一项也从当前焦点推,
  // 从 active 推的话,同一批里连按两下方向键读到的是上一帧的值,第二下会原地不动。
  const focusItem = (i: number) => itemsRef.current[i]?.focus();
  const step = (delta: number) => {
    const at = itemsRef.current.findIndex((el) => el === document.activeElement);
    focusItem((Math.max(at, 0) + delta + count) % count);
  };

  const browse = () => {
    close();
    onBrowse();
  };

  const pick = (dir: string) => {
    close();
    if (dir !== current) onPick(dir);
  };

  // Enter / Space 由菜单项自己(button 的原生行为)负责,这里只管开合与方向键
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (open) close();
      return;
    }
    if (!open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        toggle();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      step(e.key === 'ArrowDown' ? 1 : -1);
    }
  };

  // 焦点整个离开组件(Tab / 点走)就收起,不把浮层留在屏上
  const onBlur = (e: React.FocusEvent) => {
    if (!boxRef.current?.contains(e.relatedTarget)) setOpen(false);
  };

  return (
    <div className={open ? 'rswitch open' : 'rswitch'} ref={boxRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        type="button"
        className="pf-pick rs-trig"
        ref={trigRef}
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        切换<span className="chev" />
      </button>

      {open && (
        <div
          className={place?.up ? 'rs-menu up' : 'rs-menu'}
          role="menu"
          style={place ? ({ '--rs-rows-max': `${place.rowsMax}px` } as React.CSSProperties) : undefined}
        >
          <div className="rs-rows">
            {rows.map((p, i) => (
              <button
                key={p}
                type="button"
                role="menuitem"
                ref={(el) => {
                  itemsRef.current[i] = el;
                }}
                tabIndex={i === active ? 0 : -1}
                className={`rs-row${p === current ? ' sel' : ''}${i === active ? ' active' : ''}`}
                title={p}
                onFocus={() => setActive(i)}
                onMouseEnter={() => focusItem(i)}
                onClick={() => pick(p)}
              >
                <span className="rn mono">{baseName(p)}</span>
                <span className="rd mono">{parentDir(p)}</span>
                <span className="tick">{p === current ? '✓' : ''}</span>
              </button>
            ))}
          </div>
          <button
            type="button"
            role="menuitem"
            ref={(el) => {
              itemsRef.current[rows.length] = el;
            }}
            tabIndex={active === rows.length ? 0 : -1}
            className={active === rows.length ? 'rs-browse active' : 'rs-browse'}
            onFocus={() => setActive(rows.length)}
            onMouseEnter={() => focusItem(rows.length)}
            onClick={browse}
          >
            浏览其他目录…
          </button>
        </div>
      )}
    </div>
  );
}
