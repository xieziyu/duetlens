import { SourceIcon } from 'duetlens';

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  color: 'var(--text-dim)',
  fontSize: 13,
  padding: '6px 0',
};

/** 三种来源各一枚;图标本体 13px,与 tab 条、review 顶栏共用同一份视觉词汇。 */
export const AllSources = () => (
  <div style={{ display: 'flex', flexDirection: 'column' }}>
    <div style={row}>
      <SourceIcon source="github-pr" />
      <span className="mono">github-pr</span>
    </div>
    <div style={row}>
      <SourceIcon source="local-branch" />
      <span className="mono">local-branch</span>
    </div>
    <div style={row}>
      <SourceIcon source="gitbutler-vbranch" />
      <span className="mono">gitbutler-vbranch</span>
    </div>
  </div>
);

/** source 缺省时落到非 github 的那一档(分支图形)。 */
export const Fallback = () => (
  <div style={row}>
    <SourceIcon />
    <span className="mono">source 未给</span>
  </div>
);
