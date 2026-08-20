import { useEffect, useState, type ReactNode } from 'react';
import type { SourceKind } from '@shared/domain';
import type { DiffStat } from '@shared/source-discovery';
import { BranchPicker, type BranchOption } from './BranchPicker';
import { Busy } from './Busy';

/**
 * 一个可选的 diff 基线。`ref` 是落库与传给 git 的原值,`scope` 说的是「选它会把谁算进来」——
 * 光看 ref 名判断不出这一点,而叠在一起的分支之间差的正是这个。
 */
export interface BaseOption {
  ref: string;
  /** 这条 ref 在结构里是什么(同 stack 下层分支 / workspace base / 仓库默认分支) */
  label: string;
  /** 覆盖范围的短语(「只审这一层」/「含 2 条分支」) */
  scope: string;
  /** 该 source 不指定 base 时天然就用的那条;选中它等价于不指定 */
  isDefault?: boolean;
}

/**
 * 「对比 base」一行:选择器 + 按所选 base 现算的改动面。
 *
 * 复用 {@link BranchPicker} 而不另做一个下拉 —— 两处是同一种「从候选里挑一条 ref」,
 * 浮层的定高/上翻/筛选/键盘那套逻辑没有第二份的理由。
 */
export function BaseRow({
  options,
  value,
  onChange,
  stat,
}: {
  options: BaseOption[];
  /** 空串 = 用该 source 的默认基线(落库也存空,见 Review.baseRef) */
  value: string;
  onChange: (ref: string) => void;
  stat: DiffStatState;
}) {
  const fallback = options.find((o) => o.isDefault) ?? options[0];
  const current = value || fallback?.ref || '';
  const picks: BranchOption[] = options.map((o) => ({
    name: o.ref,
    kind: 'git',
    tag: o.scope,
    meta: o.label,
    detail: '',
    badge: o.isDefault ? '默认' : undefined,
  }));

  return (
    <div className="picker-row base-row">
      <span className="lbl w">对比 base</span>
      <BranchPicker
        options={picks}
        value={current}
        // 选中默认那条就落空串:让「跟随该 source 的默认基线」与「钉死在这条 ref 上」可分,
        // 否则默认分支后来改了名,旧 review 会拿着一条不再存在的 ref 复审。
        onChange={(ref) => onChange(ref === fallback?.ref ? '' : ref)}
        emptyHint="没有可选的对比基线"
      />
      <DiffMetric stat={stat} />
    </div>
  );
}

function DiffMetric({ stat }: { stat: DiffStatState }) {
  // 失败必须与在途可分:两者都渲染成「计量中…」的话,一条算不出来的 base 会永远转下去,
  // 而用户看不出是这条 base 已经不可比(分支被删 / compare 限流),还是网慢。
  if (stat.state === 'error') {
    return (
      <span className="basemetric mono err" title={stat.message}>
        计量失败 · 这条 base 可能已不可比
      </span>
    );
  }
  if (stat.state === 'loading') return <Busy>计量中…</Busy>;
  return (
    <span className="basemetric mono">
      {stat.value.files} files · <span className="a">+{stat.value.additions}</span>{' '}
      <span className="d">−{stat.value.deletions}</span>
    </span>
  );
}

/**
 * base 候选还没摸出来(或摸失败)时,占住选择器自己那一格。
 *
 * **状态必须落在选择器将要出现的位置**,而不是上游结果块里的一枚小字 —— 这段等待要好几秒,
 * 而人的眼睛在「答案会出现的地方」;放到别处,再动的点也等于没有。
 * 高度与真实那行一致,摸出多个候选后原地换成选择器,不推屏。
 */
export function BaseProbeRow({ error, onRetry }: { error?: string; onRetry?: () => void }) {
  return (
    <div className="picker-row base-row">
      <span className="lbl w">对比 base</span>
      <div className={error ? 'baseprobe err' : 'baseprobe'}>
        {error ? (
          <>
            <span className="bpr-ic">!</span>
            <span className="bpr-txt" title={error}>
              base 候选探测失败 · 先按该 PR 自己的 base 审
            </span>
            {onRetry && (
              <button type="button" className="bpr-retry" onClick={onRetry}>
                重试
              </button>
            )}
          </>
        ) : (
          <Busy>正在探测 Stacked PR…</Busy>
        )}
      </div>
    </div>
  );
}

/**
 * base 设置区:选择器 + stack 链路条 + 调用方追加的后果提示。
 *
 * 三块是同一件事的三层展开(选谁 / 选出来是什么形状 / 选宽了要付什么代价),故合成一个块归组 ——
 * 各自挂 `.derived` 会画出三条平行虚线,读起来像三条不相干的信息。
 *
 * `tucked` 说的是这一区挂在谁下面:github 侧 base 是**某一个具体 PR 的属性**(换 PR 就得清),
 * 于是整区缩进到 PR 卡片那一层、只在容器上画一次连接线;本地侧 base 与「审核分支」是定宽标签
 * 对齐的并排两行,回到主层级,线仍由区内的 stack 条自己挂。
 */
export function BaseSection({
  tucked,
  collapsed,
  children,
}: {
  tucked?: boolean;
  /**
   * 收起(高度过渡到 0)。**只给探测占位用** —— 收起靠 `overflow: hidden`,
   * 真选择器那一区挂上就会把 BranchPicker 的浮层裁没。
   */
  collapsed?: boolean;
  children: ReactNode;
}) {
  const cls = ['base-block', tucked && 'tucked derived', collapsed !== undefined && 'probe', collapsed && 'gone']
    .filter(Boolean)
    .join(' ');
  return <div className={cls}>{children}</div>;
}

/**
 * stack 链路条:把「这次审的是哪一段」画出来。
 * `nodes` 自底向上排(nodes[0] = 栈底的 base,末位 = 被审那条),`baseIndex` 之上的点亮。
 *
 * 不换行、横向滚动 —— 深 stack 加长分支名会把连接线断在半空,一条断掉的线比不画更误导。
 */
export function StackLadder({ nodes, baseIndex }: { nodes: string[]; baseIndex: number }) {
  if (nodes.length < 2) return null;
  return (
    <div className="stackbar derived">
      <span className="sb-lbl mono">stack</span>
      {/* 只有链路本身滚动:层数是这条链的结论,跟着节点滚出可视区就得靠横向拖动才看得见 */}
      <div className="sb-scroll">
        {nodes.map((n, i) => (
          <span key={n} className="sb-part">
            {i > 0 && <span className={i > baseIndex ? 'sb-seg in' : 'sb-seg'} />}
            <span className={`sb-node mono${nodeClass(i, baseIndex, nodes.length)}`}>{n}</span>
          </span>
        ))}
      </div>
      <span className="sb-tail">
        审核范围 <b>{nodes.length - 1 - baseIndex}</b> 层
      </span>
    </div>
  );
}

function nodeClass(i: number, baseIndex: number, total: number): string {
  if (i === baseIndex) return ' basenode';
  if (i < baseIndex) return '';
  return i === total - 1 ? ' in cur' : ' in';
}

/** 计量的三态。失败要单独一档 —— 退回 loading 会把「算不出来」画成「还在算」。 */
export type DiffStatState =
  | { state: 'loading' }
  | { state: 'value'; value: DiffStat }
  | { state: 'error'; message: string };

const LOADING: DiffStatState = { state: 'loading' };

/**
 * 按当前选择现算改动面。**换一条 base 先把上一次的结果清掉**,否则新数到手前那几百毫秒里
 * 屏上摆着的是上一条 base 的计量 —— 它看起来完全正常,只是说的是另一件事。
 * 结果连同它是为哪次选择算的一起存,换选择即作废,晚回来的旧请求也盖不上。
 */
export function useDiffStat(input: {
  source: SourceKind;
  ref: string;
  repoPath: string;
  baseRef: string;
  enabled: boolean;
}): DiffStatState {
  const [stat, setStat] = useState<{ key: string; value: DiffStatState } | null>(null);
  const key = [input.source, input.ref, input.repoPath, input.baseRef].join(' ');
  const { enabled, source, ref, repoPath, baseRef } = input;

  useEffect(() => {
    if (!enabled || !ref.trim()) {
      setStat(null);
      return;
    }
    let alive = true;
    window.duetlens.source
      .diffStat({ source, ref, repoPath: repoPath || undefined, baseRef: baseRef || undefined })
      .then((v) => alive && setStat({ key, value: { state: 'value', value: v } }))
      .catch(
        (e: Error) =>
          alive && setStat({ key, value: { state: 'error', message: e.message ?? String(e) } }),
      );
    return () => {
      alive = false;
    };
  }, [key, enabled, source, ref, repoPath, baseRef]);

  return stat?.key === key ? stat.value : LOADING;
}
