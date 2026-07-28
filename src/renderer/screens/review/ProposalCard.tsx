import { useState } from 'react';
import {
  isProposalStale,
  isProposalUndoBlocked,
  type Finding,
  type FindingProposal,
  type ProposalUpdatePatch,
  type Severity,
} from '@shared/domain';
import { stripIpcWrapper } from './round-error';

const SEV_LABEL: Record<Severity, string> = { high: 'high', medium: 'med', low: 'low' };

export interface ProposalCardProps {
  proposal: FindingProposal;
  /** 提案针对的 finding 当前值(create 提案尚无);用于对照旧值与判定是否已过期 */
  finding: Finding | null;
  onApply: (id: string) => Promise<unknown>;
  onSkip: (id: string) => Promise<unknown>;
  onUndo: (id: string) => Promise<unknown>;
}

/** 每档的图标 / 标题 / 工具名。剔除单独用 sev-high 色,免得与「更新」长得一样却后果不同。 */
const KIND_META = {
  update: { icon: '◆', title: '建议更新这条 finding', tool: 'update_finding', danger: false },
  dismiss: { icon: '✕', title: '建议剔除这条 finding', tool: 'dismiss_finding', danger: true },
  restore: { icon: '↩', title: '建议恢复这条 finding', tool: 'restore_finding', danger: false },
  create: { icon: '＋', title: '建议记为一条 finding', tool: 'report_finding', danger: false },
} as const;

/**
 * agent 在讨论里提出的回写提案,接在它那条回复下方。
 * 提案本身不改任何东西 —— 落库要 reviewer 点这里的主按钮(见 backend applyProposal)。
 * applied / skipped 之后卡片不消失,折叠成一行留作「谁在什么时候改了什么」的凭据。
 */
export function ProposalCard({ proposal, finding, onApply, onSkip, onUndo }: ProposalCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = KIND_META[proposal.kind];
  const stale = isProposalStale(proposal, finding);
  // 已提交的 finding 内容锁定(后端也拦,见 assertContentWritable)。提前说,别让人点了才知道。
  // 只锁内容:剔除/恢复是「这条还追不追」的判断,已提交的追评项照样可以剔。
  const locked = proposal.kind === 'update' && finding?.submission === 'submitted';
  // 应用之后 finding 又被改过 → 撤销会顶掉那次改动,后端直接回绝(见 isProposalUndoBlocked)。
  // 这里同口径先把按钮收起来,别让人点了才知道。
  const undoBlocked = isProposalUndoBlocked(proposal, finding);

  const run = (fn: (id: string) => Promise<unknown>) => () => {
    setError(null);
    setBusy(true);
    void fn(proposal.id)
      .catch((e: unknown) => setError(stripIpcWrapper((e as Error)?.message ?? String(e))))
      .finally(() => setBusy(false));
  };

  if (proposal.status !== 'pending') {
    const applied = proposal.status === 'applied';
    // create 无从撤销:新建出来的 finding 该留该删是 reviewer 的事,不在这里替他决定
    const undoable =
      applied && proposal.kind !== 'create' && !!proposal.before && !locked && !undoBlocked;
    return (
      <div className={`prop ${applied ? 'done' : 'skipped'}${stale ? ' stale' : ''}`}>
        <div className="prop-done-row">
          <span className="pi">{applied ? '✓' : '○'}</span>
          <span>
            {applied ? '已应用' : '已忽略'} · {summarize(proposal, finding)}
          </span>
          {undoable && (
            <button className="pb u" disabled={busy} onClick={run(onUndo)}>
              ↩ 撤销
            </button>
          )}
          {!applied && !locked && (
            <button className="pb u" disabled={busy} onClick={run(onApply)}>
              {stale ? '仍要应用' : '重新应用'}
            </button>
          )}
        </div>
        {locked && <div className="prop-warn stale-note">{LOCKED_NOTE}</div>}
        {undoBlocked && !locked && (
          <div className="prop-warn stale-note">这条 finding 在应用之后又被改过,已不能一键撤销。</div>
        )}
        {/* 忽略过的提案照样能重新应用,所以过期提醒在折叠态也得给 —— 不给的话,
            那一下会静默盖掉 finding 在忽略之后的改动 */}
        {stale && <div className="prop-warn stale-note">{STALE_NOTE[proposal.kind]}</div>}
        {error && <div className="prop-warn">✕ {error}</div>}
      </div>
    );
  }

  return (
    <div className={`prop${meta.danger ? ' drop' : ''}${stale ? ' stale' : ''}`}>
      <div className="prop-head">
        <span className="pi">{stale ? '!' : meta.icon}</span>
        {stale ? '提案已过期' : meta.title}
        <span className="pt">{meta.tool}</span>
      </div>
      {stale && <div className="prop-warn">{STALE_NOTE[proposal.kind]}</div>}
      {locked && <div className="prop-warn stale-note">{LOCKED_NOTE}</div>}
      <div className="prop-body">
        <ProposalDetail proposal={proposal} finding={finding} />
      </div>
      <div className="prop-foot">
        <button
          className={`pb ${meta.danger ? 'drop' : 'go'}`}
          disabled={busy || locked}
          onClick={run(onApply)}
        >
          {stale ? '仍要应用' : APPLY_LABEL[proposal.kind]}
        </button>
        <button className="pb" disabled={busy} onClick={run(onSkip)}>
          忽略
        </button>
        <span className="why">{FOOT_NOTE[proposal.kind]}</span>
      </div>
      {error && <div className="prop-warn">✕ {error}</div>}
    </div>
  );
}

const LOCKED_NOTE = '这条 finding 已提交到 GitHub,内容已锁定 —— 改了会与发出去的评论对不上。';

/** 过期提醒:说清套用会顶掉的**具体是什么**,一句「又被改过」不足以让人判断要不要点。 */
const STALE_NOTE: Record<FindingProposal['kind'], string> = {
  update: '这条 finding 在提案之后又被改过,套用会盖掉那次改动。',
  dismiss: '这条已被剔除,且理由与本提案不同 —— 套用会替换掉现有的剔除理由。',
  restore: '',
  create: '',
};

/** 页脚那句话要与实际能做的事对上:create 在后端与折叠态都不给撤销,别在这里许一个不存在的出口。 */
const FOOT_NOTE: Record<FindingProposal['kind'], string> = {
  update: '应用后可撤销',
  restore: '应用后可撤销',
  dismiss: '理由会注入下一轮复审',
  create: '新建后不可撤销,如需去掉请剔除该 finding',
};

const APPLY_LABEL: Record<FindingProposal['kind'], string> = {
  update: '✓ 应用',
  dismiss: '✕ 剔除并记录理由',
  restore: '↩ 恢复',
  create: '＋ 记为 finding',
};

/** 折叠态的一句话交代:改了什么 / 剔除了什么,不必展开就知道这行记的是哪件事。 */
function summarize(p: FindingProposal, finding: Finding | null): string {
  if (p.kind === 'create') return `新建 finding「${p.patch.title}」`;
  if (p.kind === 'dismiss') return `剔除${finding ? `「${finding.title}」` : ''}`;
  if (p.kind === 'restore') return `恢复${finding ? `「${finding.title}」` : ''}`;
  const fields = changedFields(p.patch);
  return fields.length ? `更新 ${fields.join(' · ')}` : '未改动任何字段';
}

const FIELD_LABEL: Record<keyof ProposalUpdatePatch, string> = {
  severity: 'severity',
  category: 'category',
  title: '标题',
  body: '说明',
  suggestion: 'suggestion',
};

function changedFields(patch: ProposalUpdatePatch): string[] {
  return (Object.keys(FIELD_LABEL) as (keyof ProposalUpdatePatch)[])
    .filter((k) => patch[k] !== undefined)
    .map((k) => FIELD_LABEL[k]);
}

function ProposalDetail({
  proposal,
  finding,
}: {
  proposal: FindingProposal;
  finding: Finding | null;
}) {
  if (proposal.kind === 'dismiss' || proposal.kind === 'restore') {
    return (
      <>
        <Row k={proposal.kind === 'dismiss' ? '剔除理由' : '恢复原因'}>
          <span className="pf-new">{proposal.patch.reason}</span>
        </Row>
        {proposal.kind === 'dismiss' && (
          <Row k="原文">
            <span className="pf-keep">保留不动(标题 / 说明 / suggestion 均不改写)</span>
          </Row>
        )}
      </>
    );
  }

  if (proposal.kind === 'create') {
    const p = proposal.patch;
    return (
      <>
        <Row k="severity">
          <span className={`sev sev-${p.severity}`}>
            {SEV_LABEL[p.severity]}
            {p.category ? ` · ${p.category}` : ''}
          </span>
        </Row>
        <Row k="标题">
          <span className="pf-new">{p.title}</span>
        </Row>
        <Row k="锚点">
          <span className="pf-new mono">
            {p.file}:{p.line}
          </span>
        </Row>
        {p.body && <TextDiff before={null} after={p.body} />}
        {/* suggestion 会随 finding 一并落库、最终提交给 author 当一键补丁 —— 卡上不给看,
            就是让 reviewer 在没读过补丁的情况下把它发出去 */}
        {p.suggestion && <TextDiff label="suggestion" before={null} after={p.suggestion} mono />}
      </>
    );
  }

  const patch = proposal.patch;
  const fields = changedFields(patch);
  if (fields.length === 0) return <Row k="改动">{'（无改动字段）'}</Row>;
  return (
    <>
      {patch.severity !== undefined && (
        <Row k="severity">
          <span className="pf-sev">
            {finding && finding.severity !== patch.severity && (
              <>
                <span className={`sev sev-${finding.severity} pf-old`}>
                  {SEV_LABEL[finding.severity]}
                </span>
                <span className="pf-arr">→</span>
              </>
            )}
            <span className={`sev sev-${patch.severity}`}>{SEV_LABEL[patch.severity]}</span>
          </span>
        </Row>
      )}
      {patch.category !== undefined && (
        <Row k="category">
          <Swap before={finding?.category ?? null} after={patch.category} />
        </Row>
      )}
      {patch.title !== undefined && (
        <Row k="标题">
          <Swap before={finding?.title ?? null} after={patch.title} />
        </Row>
      )}
      {patch.body !== undefined && <TextDiff before={finding?.body ?? null} after={patch.body} />}
      {patch.suggestion !== undefined && (
        <TextDiff label="suggestion" before={finding?.suggestion ?? null} after={patch.suggestion} mono />
      )}
    </>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="pf">
      <span className="pf-k">{k}</span>
      <span className="pf-v">{children}</span>
    </div>
  );
}

/** 短字段的旧→新。旧值缺失或与新值相同时只显示新值,不摆一个空的箭头。 */
function Swap({ before, after }: { before: string | null; after: string | null }) {
  const next = after ?? '（清空）';
  if (before == null || before === after) return <span className="pf-new">{next}</span>;
  return (
    <>
      <span className="pf-old">{before}</span>
      <span className="pf-arr">→</span>
      <span className="pf-new">{next}</span>
    </>
  );
}

/**
 * 长文本(正文 / suggestion)的逐块对照;沿用 diff 栏的红绿两档,不必学新的读法。
 *
 * `mono`(suggestion)**逐字照显,不做 trim**:那是会被字面替换进代码的补丁,首行缩进是它的一部分
 * (见 findingSuggestion)。裁掉的话,卡上看到的和采纳后落库、最终发给 author 的不是同一段。
 * 「有没有内容」因此只按 null 判,不按 trim 后是否为空 —— 纯空白的补丁也是补丁。
 */
function TextDiff({
  label = '说明',
  before,
  after,
  mono,
}: {
  label?: string;
  before: string | null;
  after: string | null;
  mono?: boolean;
}) {
  const show = (v: string | null): string | null => (v == null ? null : mono ? v : v.trim() || null);
  const oldText = show(before);
  const newText = show(after);
  if (oldText == null && newText == null) return <Row k={label}>{'（清空）'}</Row>;
  return (
    <div className={`pf-diff${mono ? ' mono' : ''}`}>
      {oldText != null && (
        <div className="r del">
          <span className="g">−</span>
          <span>{oldText}</span>
        </div>
      )}
      {newText != null ? (
        <div className="r add">
          <span className="g">＋</span>
          <span>{newText}</span>
        </div>
      ) : (
        <div className="r add">
          <span className="g">＋</span>
          <span className="pf-keep">（清空 {label}）</span>
        </div>
      )}
    </div>
  );
}
