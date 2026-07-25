import './LensScanArt.css';

/**
 * 镜片扫描动画:镜片在一叠 diff 代码行上来回扫,镜片下的行才「看清」。
 * 语汇取自应用图标,凡是「agent 正在通读改动」的等待画面都用这一份(启动浮层 / 审核屏扫描空态)。
 *
 * 只画动画本身,外框(背景 / 边线 / 圆角)交给宿主,因为它在浮层里是面板头、在右栏里是一张卡。
 */

/** 动画里的代码行:宽度与 diff 属性只为画面节奏,不代表真实改动 */
const ROWS: { w: number; kind?: 'add' | 'del' }[] = [
  { w: 72 },
  { w: 54, kind: 'add' },
  { w: 88 },
  { w: 46, kind: 'del' },
  { w: 66, kind: 'add' },
];

export const LENS_ART_ROWS = ROWS.length;

export function LensScanArt({
  /** 点亮的行数 = 已完成的阶段数,让画面带一点真实进度 */
  lit = 0,
  /** 失败态:扫描停住、镜片居中转红环 —— 一眼看出不是还在跑 */
  failed = false,
  className,
}: {
  lit?: number;
  failed?: boolean;
  className?: string;
}) {
  const shown = failed ? 0 : Math.min(ROWS.length, lit);
  return (
    <div className={`lens-art${failed ? ' failed' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <div className="lens-rows">
        {ROWS.map((r, i) => (
          <span
            key={i}
            className={`lens-row${r.kind ? ` ${r.kind}` : ''}${i < shown ? ' lit' : ''}`}
            style={{ width: `${r.w}%` }}
          />
        ))}
      </div>
      <div className="lens-sweep">
        <div className="lens-rows">
          {ROWS.map((r, i) => (
            <span key={i} className={`lens-row${r.kind ? ` ${r.kind}` : ''}`} style={{ width: `${r.w}%` }} />
          ))}
        </div>
      </div>
      <div className="lens-track">
        <span className="lens-glass" />
      </div>
    </div>
  );
}
