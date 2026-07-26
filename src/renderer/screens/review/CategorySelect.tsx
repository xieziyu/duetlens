import { useEffect, useMemo, useState } from 'react';
import { FINDING_CATEGORIES } from '@shared/domain';

/**
 * finding 的 category 选择器:输入即筛选,但**只认列表里的值** ——
 * category 是分组与筛选的维度,放开自由填写等于让每条 finding 各起一个分类,分组随即失效。
 * 值仍是可空的:填不出来就别逼着填。
 *
 * agent 偶尔会造出列表外的词(prompt 是软约束),编辑既有 finding 时把它当成额外一项保留,
 * 不在这里静默改写别人的数据。
 */
export function CategorySelect({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const options = useMemo(() => {
    const all: string[] = [...FINDING_CATEGORIES];
    if (value && !all.includes(value)) all.unshift(value);
    const q = query.trim().toLowerCase();
    return q ? all.filter((c) => c.toLowerCase().includes(q)) : all;
  }, [query, value]);

  // 候选变短后旧高亮会越界,落在空处按 Enter 就什么都没选中
  useEffect(() => {
    setActive((i) => (i < options.length ? i : 0));
  }, [options.length]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const pick = (c: string | null) => {
    onChange(c);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      // 展开时 Esc 只关下拉;冒到 composer 上会连整张卡一起取消
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => {
        const n = options.length;
        if (n === 0) return 0;
        return (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      });
      return;
    }
    if (e.key === 'Enter') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      // 无匹配时 Enter 什么都不选:清空是「✕」的活,不能让一句打错的筛选把原值抹掉
      const picked = options[active];
      if (picked !== undefined) pick(picked);
    }
  };

  return (
    <div className="catsel" onKeyDown={onKeyDown}>
      <input
        className="fe-cat"
        // 收起时显示已选值,展开时输入框就是筛选框 —— 两者共用一栏,免得再占一格宽度
        value={open ? query : (value ?? '')}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-label="category"
        placeholder="category(可选)"
        onFocus={() => setOpen(true)}
        onBlur={close}
        onChange={(e) => {
          setOpen(true);
          setQuery(e.target.value);
        }}
      />
      {value && !open && (
        // 清空是"选了又想不选"的唯一出口:输入框里删字并不等于取消选择
        <button
          type="button"
          className="cs-clear"
          title="清空 category"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pick(null)}
        >
          ✕
        </button>
      )}
      {open && (
        // mousedown 会先于 click 触发 blur 关掉菜单,按下时就得拦住
        <div className="cs-menu" role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {options.length === 0 ? (
            <div className="cs-empty">无匹配分类</div>
          ) : (
            options.map((c, i) => (
              <button
                type="button"
                key={c}
                role="option"
                aria-selected={c === value}
                className={`cs-opt${i === active ? ' active' : ''}${c === value ? ' on' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(c)}
              >
                {c}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
