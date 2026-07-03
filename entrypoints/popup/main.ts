import type {
  ContentRequest,
  DownloadJob,
  VideoInfo,
  VideoInfoResponse,
} from '../../src/shared/messages'
import {
  buildDownloadJob,
  hasLockedQuality,
  listQualityIds,
  pickVideoStream,
  qualityLabel,
} from '../../src/extractor/streams'
import { buildDisplayTitle } from '../../src/extractor/filename'

// UI。アクティブな動画タブの content script に情報を要求し、画質を選ばせ、
// ダウンロード指示を session storage 経由で downloader ページに渡す。

const VIDEO_PAGE_PATTERN = /^https:\/\/www\.bilibili\.com\/video\//

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} が見つかりません`)
  return el as T
}

const els = {
  status: byId<HTMLDivElement>('status'),
  info: byId<HTMLElement>('video-info'),
  title: byId<HTMLParagraphElement>('video-title'),
  select: byId<HTMLSelectElement>('quality-select'),
  loginHint: byId<HTMLParagraphElement>('login-hint'),
  button: byId<HTMLButtonElement>('download-button'),
}

function setStatus(text: string, state?: 'error'): void {
  els.status.textContent = text
  els.status.dataset.state = state ?? ''
  els.status.hidden = text === ''
}

async function findVideoTab(): Promise<chrome.tabs.Tab | null> {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  })
  if (active?.url && VIDEO_PAGE_PATTERN.test(active.url)) {
    return active
  }
  // ポップアップをタブとして開いた場合(E2E 等)は動画タブを検索する。
  const tabs = await chrome.tabs.query({
    url: 'https://www.bilibili.com/video/*',
  })
  return tabs[0] ?? null
}

async function requestVideoInfo(tabId: number): Promise<VideoInfoResponse> {
  const request: ContentRequest = { type: 'GET_VIDEO_INFO' }
  return (await chrome.tabs.sendMessage(tabId, request)) as VideoInfoResponse
}

function renderQualityOptions(info: VideoInfo): void {
  const dash = info.playinfo.dash
  if (!dash) return
  for (const id of listQualityIds(dash)) {
    const stream = pickVideoStream(dash.video, id)
    if (!stream) continue
    const option = document.createElement('option')
    option.value = String(id)
    option.textContent = `${qualityLabel(info.playinfo, id)} (${stream.width}x${stream.height})`
    els.select.append(option)
  }
}

async function startDownload(info: VideoInfo): Promise<void> {
  const qualityId = Number(els.select.value)
  let job: DownloadJob
  try {
    job = buildDownloadJob(info, qualityId)
  } catch (err) {
    setStatus(
      `ダウンロード準備に失敗: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
    return
  }
  const jobId = `job-${info.bvid}-${info.cid}-${qualityId}`
  await chrome.storage.session.set({ [jobId]: job })
  await chrome.tabs.create({
    url: chrome.runtime.getURL(
      `/downloader.html?job=${encodeURIComponent(jobId)}`,
    ),
  })
  window.close()
}

async function init(): Promise<void> {
  const tab = await findVideoTab()
  if (!tab?.id) {
    setStatus('対応している動画ページを開いた状態で使用してください。', 'error')
    return
  }

  let response: VideoInfoResponse
  try {
    response = await requestVideoInfo(tab.id)
  } catch {
    setStatus(
      '動画ページと通信できませんでした。ページを再読み込みしてから再度お試しください。',
      'error',
    )
    return
  }
  if (!response.ok) {
    setStatus(`動画情報の取得に失敗しました: ${response.error}`, 'error')
    return
  }

  const info = response.data
  const dash = info.playinfo.dash
  if (!dash || dash.video.length === 0) {
    setStatus(
      'この動画のストリーム情報を取得できませんでした(有料・地域制限動画の可能性があります)。',
      'error',
    )
    return
  }

  renderQualityOptions(info)
  els.loginHint.hidden = !hasLockedQuality(info.playinfo, dash)
  els.title.textContent = buildDisplayTitle(info.title, info.partTitle)
  setStatus('')
  els.info.hidden = false

  els.button.addEventListener('click', () => {
    els.button.disabled = true
    void startDownload(info)
  })
}

void init().catch((err: unknown) => {
  setStatus(
    `エラー: ${err instanceof Error ? err.message : String(err)}`,
    'error',
  )
})
