import { useEffect, useState } from 'react';
import type { Review } from '@shared/domain';
import './EntryScreen.css';

// → mockup/entry.html:Hero + 发起审核卡片 + 最近的审核(骨架期先接演示审核 + 历史列表)
export function EntryScreen({ onOpenReview }: { onOpenReview: (id: string) => void }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [starting, setStarting] = useState(false);

  const refresh = () => window.duetlens.review.list().then(setReviews);
  useEffect(() => {
    void refresh();
  }, []);

  const startDemo = async () => {
    setStarting(true);
    try {
      const review = await window.duetlens.review.startDemo();
      onOpenReview(review.id);
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="entry">
      <div className="hero">
        <h1 className="mono hero-mark">duetlens_</h1>
        <p className="hero-sub">人与 agent 协同对话式 code review</p>
      </div>

      <div className="start-card">
        <div className="start-head">发起审核</div>
        <p className="start-note">
          真实 source 层(GitHub PR / 本地分支 / GitButler)开发中。先跑一个内置 fixture 的演示审核,
          验证 codex 扫描 → findings 实时流入。
        </p>
        <button className="start-cta" onClick={startDemo} disabled={starting}>
          {starting ? '启动中…' : '▶ 开始演示审核'}
        </button>
      </div>

      <div className="recent">
        <div className="recent-head">
          最近的审核 <span className="count">{reviews.length}</span>
        </div>
        {reviews.length === 0 ? (
          <p className="recent-empty">还没有审核记录。</p>
        ) : (
          <ul className="recent-list">
            {reviews.map((r) => (
              <li key={r.id} className="recent-row" onClick={() => onOpenReview(r.id)}>
                <span className={`badge s-${r.status}`}>{r.status}</span>
                <span className="recent-title">{r.title ?? r.sourceRef}</span>
                <span className="mono recent-source">{r.source}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
