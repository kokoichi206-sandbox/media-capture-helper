import { defineBackground } from '#imports'
import type {
  ContentRequest,
  DownloadBlobRequest,
  DownloadBlobResponse,
  DownloadItem,
  DownloadJob,
  DownloadState,
  OffscreenEvent,
  OffscreenMessage,
  PanelMessage,
  RefreshStreamsRequest,
  RefreshStreamsResponse,
  VideoInfoResponse,
} from '../src/shared/messages'
import {
  DOWNLOADS_KEY,
  downloadJobId,
  isActiveStatus,
} from '../src/shared/messages'
import { buildDisplayTitle } from '../src/extractor/filename'
import { refreshJobStreams } from '../src/extractor/streams'

// 調整役。サイドパネル(UI)からの指示を受け、offscreen(作業エンジン)を起動・直列化し、
// 進捗を storage.session の唯一の書き手として反映する。ダウンロードの実処理は持たず、
// UI とも storage 経由で疎結合にすることで、SW / パネル / offscreen の生存を分離する。

// 完了・エラーの履歴保持件数。恒久履歴は chrome://downloads に委ね、パネルは「最近の活動」に留める。
const HISTORY_LIMIT = 20
const OFFSCREEN_URL = 'offscreen.html'

async function readState(): Promise<DownloadState> {
  const stored = await chrome.storage.session.get(DOWNLOADS_KEY)
  return (stored[DOWNLOADS_KEY] as DownloadState | undefined) ?? {}
}

async function writeState(state: DownloadState): Promise<void> {
  await chrome.storage.session.set({ [DOWNLOADS_KEY]: state })
}

async function readJob(jobId: string): Promise<DownloadJob | undefined> {
  const stored = await chrome.storage.session.get(jobId)
  return stored[jobId] as DownloadJob | undefined
}

function buildMeta(job: DownloadJob): string {
  return (
    `${job.bvid} / ${job.qualityLabel} (${job.video.width}x${job.video.height}, ${job.video.codecs})` +
    (job.audio ? '' : ' / 音声トラックなし')
  )
}

function newItem(job: DownloadJob, jobId: string): DownloadItem {
  return {
    jobId,
    displayTitle: buildDisplayTitle(job.title, job.partTitle),
    qualityLabel: job.qualityLabel,
    meta: buildMeta(job),
    status: 'queued',
    video: { received: 0, total: 0 },
    audio: job.audio ? { received: 0, total: 0 } : null,
    filename: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  }
}

// --- 全操作の直列化(状態更新と offscreen 生成の競合を防ぐ) ---
let chain: Promise<void> = Promise.resolve()
function serialize(task: () => Promise<void>): Promise<void> {
  const run = chain.then(task).catch((err: unknown) => {
    console.error('[bg] task failed', err)
  })
  chain = run
  return run
}

// --- offscreen(作業エンジン)のライフサイクル ---
function toOffscreen(message: OffscreenMessage): void {
  void chrome.runtime.sendMessage(message).catch(() => {})
}

async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.BLOBS],
    justification:
      'DASH ストリームの取得と ffmpeg.wasm による MP4 結合・保存を行う',
  })
}

// offscreen には chrome.downloads が無いため、生成済み blob URL の保存を代行する。
// 状態遷移とは独立なので serialize は通さず即時に実行する。
async function downloadBlob(
  req: DownloadBlobRequest,
): Promise<DownloadBlobResponse> {
  try {
    const downloadId = await chrome.downloads.download({
      url: req.blobUrl,
      filename: req.filename,
      saveAs: false,
    })
    await waitForDownload(downloadId)
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// CDN URL の署名期限切れ時の再取得。認証 Cookie はページコンテキストからしか送れない
// ため、同一動画(bvid+cid)を開いているタブの content script に playurl を引き直させる。
// 状態遷移とは独立なので serialize は通さず即時に実行する。
async function refreshStreams(
  req: RefreshStreamsRequest,
): Promise<RefreshStreamsResponse> {
  const job = await readJob(req.jobId)
  if (!job) {
    return { ok: false, error: 'ダウンロード指示が見つかりませんでした' }
  }
  const tabs = await chrome.tabs.query({
    url: 'https://www.bilibili.com/video/*',
  })
  const request: ContentRequest = { type: 'GET_VIDEO_INFO' }
  let lastError =
    '動画ページのタブが見つかりません(ダウンロード中は対象ページを開いたままにしてください)'
  for (const tab of tabs) {
    if (tab.id == null) continue
    let response: VideoInfoResponse
    try {
      response = (await chrome.tabs.sendMessage(
        tab.id,
        request,
      )) as VideoInfoResponse
    } catch {
      // content script 未注入のタブ(拡張更新前から開いていた等)は候補から外す。
      continue
    }
    if (!response.ok) {
      lastError = response.error
      continue
    }
    // 別動画へ遷移済みのタブは対象外。
    if (response.data.bvid !== job.bvid || response.data.cid !== job.cid) {
      continue
    }
    // 同一動画のタブを発見。ここから先の失敗は確定的なので探索を打ち切って返す。
    try {
      return { ok: true, data: refreshJobStreams(job, response.data.playinfo) }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  return { ok: false, error: lastError }
}

function waitForDownload(downloadId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (
      state: string | undefined,
      error: string | undefined,
    ): void => {
      chrome.downloads.onChanged.removeListener(onChanged)
      if (state === 'complete') {
        resolve()
      } else {
        reject(new Error(`保存が中断されました: ${error ?? '不明'}`))
      }
    }
    const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
      if (delta.id !== downloadId || !delta.state) return
      if (delta.state.current !== 'in_progress') {
        settle(delta.state.current, delta.error?.current)
      }
    }
    chrome.downloads.onChanged.addListener(onChanged)
    // リスナー登録前に完了しているケースを取りこぼさないよう現状態も確認する。
    void chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item && item.state !== 'in_progress') {
        settle(item.state, item.error)
      }
    })
  })
}

async function closeOffscreenIfIdle(state: DownloadState): Promise<void> {
  const busy = Object.values(state).some(
    (item) => item.status === 'queued' || isActiveStatus(item.status),
  )
  if (busy) return
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument()
  }
}

// 進行中が無ければ、最も古い待機ジョブを offscreen へ投入する(state を破壊的に更新)。
async function dispatchNext(state: DownloadState): Promise<void> {
  const items = Object.values(state)
  if (items.some((item) => isActiveStatus(item.status))) return
  const next = items
    .filter((item) => item.status === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  if (!next) return

  const job = await readJob(next.jobId)
  if (!job) {
    // ジョブ本体が消えているのは異常。握りつぶさず error にする。
    next.status = 'error'
    next.error = 'ダウンロード指示が見つかりませんでした'
    next.finishedAt = Date.now()
    return
  }
  // downloading にして active スロットを確保し、二重 dispatch を防ぐ。
  next.status = 'downloading'
  await ensureOffscreen()
  toOffscreen({ type: 'RUN_JOB', jobId: next.jobId, job })
}

function pruneHistory(state: DownloadState): void {
  const finished = Object.values(state)
    .filter((item) => item.status === 'done' || item.status === 'error')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  for (const item of finished.slice(HISTORY_LIMIT)) {
    delete state[item.jobId]
  }
}

// --- ハンドラ(いずれも serialize 内で 1 タスクとして実行される) ---
async function onStart(job: DownloadJob): Promise<void> {
  const jobId = downloadJobId(job)
  const state = await readState()
  const existing = state[jobId]
  // 同一ジョブが進行中/待機中なら二重投入しない(再DLは完了・エラー後のみ)。
  if (
    existing &&
    (existing.status === 'queued' || isActiveStatus(existing.status))
  ) {
    return
  }
  await chrome.storage.session.set({ [jobId]: job })
  state[jobId] = newItem(job, jobId)
  await dispatchNext(state)
  await writeState(state)
}

async function onProgress(
  event: Extract<OffscreenEvent, { type: 'JOB_PROGRESS' }>,
): Promise<void> {
  const state = await readState()
  const item = state[event.jobId]
  if (!item) return
  const progress = { received: event.received, total: event.total }
  if (event.kind === 'video') {
    item.video = progress
  } else if (item.audio) {
    item.audio = progress
  }
  await writeState(state)
}

async function onStatus(
  event: Extract<OffscreenEvent, { type: 'JOB_STATUS' }>,
): Promise<void> {
  const state = await readState()
  const item = state[event.jobId]
  if (!item) return
  item.status = event.status
  if (event.status === 'done' || event.status === 'error') {
    item.finishedAt = Date.now()
    if (event.filename) item.filename = event.filename
    if (event.error) item.error = event.error
    await chrome.storage.session.remove(event.jobId)
    pruneHistory(state)
  }
  await dispatchNext(state)
  await writeState(state)
  await closeOffscreenIfIdle(state)
}

async function onCancel(jobId: string): Promise<void> {
  const state = await readState()
  const item = state[jobId]
  if (!item) return
  if (item.status === 'queued') {
    delete state[jobId]
    await chrome.storage.session.remove(jobId)
    await writeState(state)
    return
  }
  if (isActiveStatus(item.status)) {
    // 終端(error)への遷移は offscreen の JOB_STATUS で一元的に行う。
    toOffscreen({ type: 'CANCEL_JOB', jobId })
  }
}

async function onClearFinished(): Promise<void> {
  const state = await readState()
  for (const item of Object.values(state)) {
    if (item.status === 'done' || item.status === 'error') {
      delete state[item.jobId]
    }
  }
  await writeState(state)
}

// SW 再起動時の復旧。offscreen が消えているのに active な残骸があれば queued に戻し、
// 待機ジョブがあれば再投入する。storage.session は SW より長命なのでここで再同期する。
async function reconcile(): Promise<void> {
  const state = await readState()
  if (!(await chrome.offscreen.hasDocument())) {
    for (const item of Object.values(state)) {
      if (isActiveStatus(item.status)) {
        item.status = 'queued'
        item.video = { received: 0, total: 0 }
        if (item.audio) item.audio = { received: 0, total: 0 }
      }
    }
  }
  await dispatchNext(state)
  await writeState(state)
}

const HANDLED_TYPES = new Set<string>([
  'START_DOWNLOAD',
  'CANCEL_DOWNLOAD',
  'CLEAR_FINISHED',
  'JOB_PROGRESS',
  'JOB_STATUS',
])

function route(message: PanelMessage | OffscreenEvent): Promise<void> {
  switch (message.type) {
    case 'START_DOWNLOAD':
      return onStart(message.job)
    case 'CANCEL_DOWNLOAD':
      return onCancel(message.jobId)
    case 'CLEAR_FINISHED':
      return onClearFinished()
    case 'JOB_PROGRESS':
      return onProgress(message)
    case 'JOB_STATUS':
      return onStatus(message)
  }
}

export default defineBackground(() => {
  // popup を持たないため、アイコンクリックでサイドパネルを開く。
  if (chrome.sidePanel) {
    void chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err: unknown) => console.error('[bg] setPanelBehavior', err))
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = (message as { type?: unknown }).type
    if (type === 'DOWNLOAD_BLOB') {
      // 保存は状態遷移と独立。offscreen が待つ応答をそのまま返す。
      void downloadBlob(message as DownloadBlobRequest).then(sendResponse)
      return true
    }
    if (type === 'REFRESH_STREAMS') {
      void refreshStreams(message as RefreshStreamsRequest).then(sendResponse)
      return true
    }
    if (typeof type !== 'string' || !HANDLED_TYPES.has(type)) return
    // serialize 完了まで応答を保留し、その間 SW を生存させる。
    void serialize(() => route(message as PanelMessage | OffscreenEvent)).then(
      () => sendResponse({ ok: true }),
    )
    return true
  })

  void serialize(reconcile)
})
