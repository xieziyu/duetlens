/**
 * 拉取一个 PR 的协作上下文(复审轮次用):作者、描述、inline review threads(含 resolved/outdated)、
 * PR 级评论、各次 review 表态。一条 GraphQL 拿全 —— REST 要三四个来回,且拿不到 resolved 状态。
 *
 * 拿回来的是外部数据,注入 agent 前的隔离处理见 backend/prompt/rerun-prompt.ts。
 */
import type { Review } from '@shared/domain';
import { emptyPrContext, type PrContext, type PrReviewThread } from '@shared/github-context';
import { run } from './exec';
import { resolvePrRef } from './github-pr-source';

/** 每类内容的抓取上限;超出部分丢弃(极少见,真超了也不该把整个上下文喂爆)。 */
const PAGE = 100;
const THREAD_COMMENTS = 50;

/**
 * inline thread 是这份查询里最贵的一块(最多 PAGE × THREAD_COMMENTS 条评论正文),
 * 而首轮扫描根本不用它(见 prompt/scan-prompt.ts)。用 `@include` 把它整段开关掉:
 * 同一份查询兼两种用法,既不必维护第二份字段清单,也不靠 `first:0` 这类没进文档的容忍值。
 * 关掉时响应里**没有** reviewThreads 这个键 —— 下面的解析本来就按缺省处理。
 */
const QUERY = `
query($owner:String!,$name:String!,$num:Int!,$page:Int!,$tc:Int!,$wantThreads:Boolean!){
  viewer{ login }
  repository(owner:$owner,name:$name){
    pullRequest(number:$num){
      title body headRefOid author{login}
      reviewThreads(first:$page) @include(if:$wantThreads){ nodes{ isResolved isOutdated path line originalLine
        comments(first:$tc){ nodes{ databaseId createdAt body author{login} } } } }
      comments(last:$page){ nodes{ createdAt body author{login} } }
      reviews(last:$page){ nodes{ state submittedAt body author{login} } }
    }
  }
}`;

export interface PrContextOptions {
  /** 是否连 inline review thread 一并取。首轮扫描不用,给 false 可省掉整份查询里最贵的一块。 */
  threads?: boolean;
}

interface GqlActor {
  login?: string | null;
}
interface GqlResponse {
  data?: {
    viewer?: { login?: string | null };
    repository?: {
      pullRequest?: {
        title?: string | null;
        body?: string | null;
        headRefOid?: string | null;
        author?: GqlActor | null;
        reviewThreads?: {
          nodes?: ({
            isResolved?: boolean;
            isOutdated?: boolean;
            path?: string | null;
            line?: number | null;
            originalLine?: number | null;
            comments?: {
              nodes?: ({
                databaseId?: number | null;
                createdAt?: string | null;
                body?: string | null;
                author?: GqlActor | null;
              } | null)[];
            };
          } | null)[];
        };
        comments?: {
          nodes?: ({ createdAt?: string | null; body?: string | null; author?: GqlActor | null } | null)[];
        };
        reviews?: {
          nodes?: ({
            state?: string | null;
            submittedAt?: string | null;
            body?: string | null;
            author?: GqlActor | null;
          } | null)[];
        };
      } | null;
    } | null;
  };
}

/** 已注销 / ghost 用户的 author 为 null,统一成占位串,免得下游到处判空。 */
const login = (a?: GqlActor | null): string => a?.login ?? '(unknown)';

/** 按 review 的 source 取上下文;非 github-pr source 或引用解析失败都返回空上下文。 */
export async function fetchPrContextForReview(
  review: Review,
  opts: PrContextOptions = {},
): Promise<PrContext> {
  if (review.source !== 'github-pr') return emptyPrContext();
  try {
    const { nwo, num } = await resolvePrRef(review.sourceRef, review.repoPath);
    return await fetchPrContext(nwo, num, opts);
  } catch {
    return emptyPrContext();
  }
}

/**
 * 拉取 PR 上下文。**任何失败都降级为空上下文**而非抛错 —— 少一份参考材料可以照常复审,
 * 因为 gh 掉线就跑不了整轮复审是不可接受的。
 */
export async function fetchPrContext(
  nwo: string,
  num: string,
  opts: PrContextOptions = {},
): Promise<PrContext> {
  const [owner, name] = nwo.split('/');
  if (!owner || !name) return emptyPrContext();

  let parsed: GqlResponse;
  try {
    const out = await run('gh', [
      'api', 'graphql',
      '-f', `query=${QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `num=${num}`,
      '-F', `page=${PAGE}`,
      '-F', `wantThreads=${opts.threads !== false}`,
      '-F', `tc=${THREAD_COMMENTS}`,
    ]);
    parsed = JSON.parse(out) as GqlResponse;
  } catch {
    return emptyPrContext();
  }

  const pr = parsed.data?.repository?.pullRequest;
  if (!pr) return emptyPrContext();

  const threads: PrReviewThread[] = (pr.reviewThreads?.nodes ?? [])
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({
      path: t.path ?? null,
      // 锚点被后续 commit 冲掉时 line 为 null,退回 originalLine 才能与我方 finding 对上
      line: t.line ?? t.originalLine ?? null,
      isResolved: !!t.isResolved,
      isOutdated: !!t.isOutdated,
      comments: (t.comments?.nodes ?? [])
        .filter((c): c is NonNullable<typeof c> => !!c)
        .map((c) => ({
          author: login(c.author),
          body: c.body ?? '',
          createdAt: c.createdAt ?? '',
          databaseId: c.databaseId ?? null,
        })),
    }))
    .filter((t) => t.comments.length > 0);

  return {
    author: login(pr.author),
    viewer: parsed.data?.viewer?.login ?? '',
    title: pr.title ?? '',
    body: pr.body ?? '',
    headSha: pr.headRefOid ?? null,
    threads,
    issueComments: (pr.comments?.nodes ?? [])
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ author: login(c.author), body: c.body ?? '', createdAt: c.createdAt ?? '' })),
    reviews: (pr.reviews?.nodes ?? [])
      .filter((r): r is NonNullable<typeof r> => !!r)
      // 空 body 的 review 只是 inline 评论的容器,内容已在 threads 里,去掉免得刷屏
      .filter((r) => (r.body ?? '').trim())
      .map((r) => ({
        author: login(r.author),
        state: r.state ?? '',
        body: r.body ?? '',
        submittedAt: r.submittedAt ?? null,
      })),
    fetchedAt: Date.now(),
  };
}
