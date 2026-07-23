import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import {
  IpcChannels,
  IpcEvents,
  type AppInfo,
  type DiscussionAnchor,
  type AddFindingInput,
  type FindingEditInput,
  type OpenExternalResult,
  type RerunInput,
  type ReviewEvent,
  type ReviewStartInput,
  type SubmitReviewInput,
} from '@shared/ipc';
import type { ReviewUiState, Triage, UiSettings } from '@shared/domain';
import type { EnvCheckOptions } from '@shared/environment';
import type { PromptSaveInput } from '@shared/prompt';
import type { ReviewManager } from '../review/review-manager';
import { resolvePrUrl } from '../source/source-discovery';

export interface IpcDeps {
  manager: ReviewManager;
  /** 把领域事件推给所有 renderer(main 提供,通常遍历 BrowserWindow) */
  broadcast: (channel: string, payload: unknown) => void;
}

/** 注册 main 侧全部 IPC handler,并把 ReviewManager 事件转发给 renderer。 */
export function registerIpcHandlers({ manager, broadcast }: IpcDeps): void {
  ipcMain.handle(IpcChannels.appGetInfo, (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));

  ipcMain.handle(IpcChannels.appCheckEnvironment, (_e, opts?: EnvCheckOptions) =>
    manager.checkEnvironment(opts),
  );

  ipcMain.handle(IpcChannels.reviewList, () => manager.listReviews());
  ipcMain.handle(IpcChannels.reviewListRecent, () => manager.listRecentReviews());
  ipcMain.handle(IpcChannels.reviewGet, (_e, id: string) => manager.getReview(id));
  ipcMain.handle(IpcChannels.reviewFindings, (_e, reviewId: string) => manager.getFindings(reviewId));
  ipcMain.handle(IpcChannels.reviewDiff, (_e, reviewId: string) => manager.getDiff(reviewId));
  ipcMain.handle(IpcChannels.reviewFileContent, (_e, reviewId: string, path: string) =>
    manager.getFileContent(reviewId, path),
  );
  ipcMain.handle(IpcChannels.reviewDiscussions, (_e, reviewId: string) => manager.getDiscussions(reviewId));
  ipcMain.handle(IpcChannels.reviewMessages, (_e, discussionId: string) => manager.getMessages(discussionId));
  ipcMain.handle(IpcChannels.reviewStart, (_e, input: ReviewStartInput) =>
    manager.startReview({
      source: input.source,
      ref: input.ref,
      repoPath: input.repoPath ?? '',
      baseRef: input.baseRef,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      context: input.context,
    }),
  );
  ipcMain.handle(IpcChannels.reviewRerun, (_e, reviewId: string, input?: RerunInput) =>
    manager.rerunReview(reviewId, input ?? {}),
  );
  ipcMain.handle(IpcChannels.reviewRounds, (_e, reviewId: string) => manager.getRounds(reviewId));
  ipcMain.handle(IpcChannels.reviewResume, (_e, reviewId: string) => manager.resumeReview(reviewId));
  ipcMain.handle(IpcChannels.reviewRelease, (_e, reviewId: string) => manager.disposeReview(reviewId));
  ipcMain.handle(IpcChannels.reviewDelete, (_e, reviewId: string) => manager.deleteReview(reviewId));
  ipcMain.handle(IpcChannels.reviewAddDiscussion, (_e, reviewId: string, anchor: DiscussionAnchor) =>
    manager.addUserDiscussion(reviewId, anchor),
  );
  ipcMain.handle(IpcChannels.reviewSendMessage, (_e, reviewId: string, discussionId: string, text: string) =>
    manager.sendMessage(reviewId, discussionId, text),
  );
  ipcMain.handle(IpcChannels.reviewClearDiscussion, (_e, reviewId: string, discussionId: string) =>
    manager.clearDiscussion(reviewId, discussionId),
  );
  ipcMain.handle(
    IpcChannels.reviewSetTriage,
    (_e, reviewId: string, findingId: string, triage: Triage, reason?: string | null) =>
      manager.setTriage(reviewId, findingId, triage, reason),
  );
  ipcMain.handle(IpcChannels.reviewSetFindingAnchor, (_e, reviewId: string, findingId: string, line: number) =>
    manager.setFindingAnchor(reviewId, findingId, line),
  );
  ipcMain.handle(IpcChannels.reviewAddFinding, (_e, reviewId: string, input: AddFindingInput) =>
    manager.addManualFinding(reviewId, input),
  );
  ipcMain.handle(IpcChannels.reviewPromoteDiscussion, (_e, reviewId: string, discussionId: string) =>
    manager.promoteDiscussion(reviewId, discussionId),
  );
  ipcMain.handle(IpcChannels.reviewUpdateFinding, (_e, reviewId: string, input: FindingEditInput) =>
    manager.updateFinding(reviewId, input),
  );
  ipcMain.handle(IpcChannels.reviewUpdateSummary, (_e, reviewId: string, body: string) =>
    manager.updateSummary(reviewId, body),
  );
  ipcMain.handle(IpcChannels.reviewSubmit, (_e, reviewId: string, input: SubmitReviewInput) =>
    manager.submitReview(reviewId, input),
  );
  // 外链只接受自己拼出的 github.com PR 地址,不透传任意 renderer 字符串给 openExternal。
  ipcMain.handle(IpcChannels.reviewOpenInBrowser, async (_e, reviewId: string): Promise<OpenExternalResult> => {
    const review = await manager.getReview(reviewId);
    if (!review) return { ok: false, message: '找不到该审核' };
    if (review.source !== 'github-pr') return { ok: false, message: '该来源没有可打开的网页' };
    try {
      const url = await resolvePrUrl(review.sourceRef, review.repoPath ?? undefined);
      await shell.openExternal(url);
      return { ok: true, url };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  });
  ipcMain.handle(IpcChannels.reviewGetUiState, (_e, reviewId: string) =>
    manager.getReviewUiState(reviewId),
  );
  ipcMain.handle(IpcChannels.reviewSaveUiState, (_e, reviewId: string, state: ReviewUiState) =>
    manager.saveReviewUiState(reviewId, state),
  );

  ipcMain.handle(IpcChannels.uiGetSettings, () => manager.getUiSettings());
  ipcMain.handle(IpcChannels.uiSaveSettings, (_e, settings: UiSettings) => manager.saveUiSettings(settings));

  ipcMain.handle(IpcChannels.agentListModels, () => manager.listModels());

  ipcMain.handle(IpcChannels.sourceCheckGhAuth, () => manager.checkGhAuth());
  ipcMain.handle(IpcChannels.sourcePreviewPr, (_e, ref: string, repoPath?: string) =>
    manager.previewPr(ref, repoPath),
  );
  ipcMain.handle(IpcChannels.sourceListOpenPrs, (_e, opts: { nwo?: string; repoPath?: string }) =>
    manager.listOpenPrs(opts),
  );
  ipcMain.handle(IpcChannels.sourceGetRepoRemote, (_e, repoPath: string) =>
    manager.getRepoRemote(repoPath),
  );
  ipcMain.handle(IpcChannels.sourceListLocalBranches, (_e, repoPath: string, baseRef?: string) =>
    manager.listLocalBranches(repoPath, baseRef),
  );
  ipcMain.handle(IpcChannels.sourceDetectGitButler, (_e, repoPath: string) =>
    manager.detectGitButler(repoPath),
  );

  ipcMain.handle(IpcChannels.promptGet, (_e, cwd?: string) => manager.getReviewPrompt(cwd));
  ipcMain.handle(IpcChannels.promptSave, (_e, input: PromptSaveInput) => manager.saveReviewPrompt(input));

  ipcMain.handle(IpcChannels.dialogPickDirectory, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { properties: ['openDirectory' as const] };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle(IpcChannels.dialogPickFile, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = { properties: ['openFile' as const] };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.handle(IpcChannels.dialogSaveTextFile, async (_e, defaultName: string, content: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, content, 'utf8');
    return res.filePath;
  });

  manager.on('review-event', (e: ReviewEvent) => broadcast(IpcEvents.reviewEvent, e));
}
