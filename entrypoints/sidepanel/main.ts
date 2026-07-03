import type {
  ContentRequest,
  DownloadItem,
  DownloadJob,
  DownloadState,
  DownloadStatus,
  PanelMessage,
  StreamProgress,
  VideoInfo,
  VideoInfoResponse,
} from '../../src/shared/messages'
import { DOWNLOADS_KEY, isActiveStatus } from '../../src/shared/messages'
import {
  buildDownloadJob,
  hasLockedQuality,
  listQualityIds,
  pickVideoStream,
  qualityLabel,
} from '../../src/extractor/streams'
import { buildDisplayTitle } from '../../src/extractor/filename'

// 単一の UI 面。上部で「現在のタブの動画」を画質選択して開始し、下部で進行中・履歴を
// 管理する。実処理は background 経由で offscreen が行い、状態は storage.session を購読して
// 描画する(パネルの開閉と作業を疎結合にするため、UI 側は決定も実処理も持たない)。

const VIDEO_PAGE_PATTERN = /^https:\/\/www\.bilibili\.com\/video\//

const STATUS_LABELS: Record<DownloadStatus, string> = {
  queued: '待機中',
  downloading: 'ダウンロード中',
  merging: '結合中',
  saving: '保存中',
  done: '完了',
  error: 'エラー',
}

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} が見つかりません`)
  return el as T
}

const els = {
  status: byId<HTMLDivElement>('status'),
  reloadPage: byId<HTMLButtonElement>('reload-page'),
  info: byId<HTMLElement>('video-info'),
  title: byId<HTMLParagraphElement>('video-title'),
  select: byId<HTMLSelectElement>('quality-select'),
  loginHint: byId<HTMLParagraphElement>('login-hint'),
  button: byId<HTMLButtonElement>('download-button'),
  list: byId<HTMLUListElement>('downloads-list'),
  empty: byId<HTMLParagraphElement>('downloads-empty'),
  clearFinished: byId<HTMLButtonElement>('clear-finished'),
  themeToggle: byId<HTMLButtonElement>('theme-toggle'),
}

function setStatus(text: string, state?: 'error'): void {
  els.status.textContent = text
  els.status.dataset.state = state ?? ''
  els.status.hidden = text === ''
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

// --- テーマ(システム / ライト / ダーク) ---
type ThemePref = 'system' | 'light' | 'dark'

const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark']
const THEME_LABELS: Record<ThemePref, string> = {
  system: 'システム',
  light: 'ライト',
  dark: 'ダーク',
}
// Lucide 由来の SVG パス(絵文字は使わない)。
const THEME_ICONS: Record<ThemePref, string> = {
  system:
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  light:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  dark: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
}

const darkMedia = window.matchMedia('(prefers-color-scheme: dark)')
let themePref: ThemePref = 'system'

// 静的な定数 SVG を DOMParser で組み立てる(innerHTML を避け、外部入力も混ぜない)。
function svgIcon(paths: string): SVGElement {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`,
    'image/svg+xml',
  )
  return document.importNode(doc.documentElement, true) as unknown as SVGElement
}

function applyTheme(pref: ThemePref): void {
  // system のときは OS 設定を解決し、常に light/dark のどちらかを属性に入れる
  // (CSS は data-theme="dark" だけを見ればよくなる)。
  const effective =
    pref === 'system' ? (darkMedia.matches ? 'dark' : 'light') : pref
  document.documentElement.dataset.theme = effective
  els.themeToggle.replaceChildren(svgIcon(THEME_ICONS[pref]))
  const label = `テーマ: ${THEME_LABELS[pref]}（クリックで切替）`
  els.themeToggle.title = label
  els.themeToggle.setAttribute('aria-label', label)
}

async function initTheme(): Promise<void> {
  const stored = await chrome.storage.local.get('theme')
  const saved = stored.theme
  themePref = saved === 'light' || saved === 'dark' ? saved : 'system'
  applyTheme(themePref)
  // system 選択中は OS のライト/ダーク変更に追従する。
  darkMedia.addEventListener('change', () => {
    if (themePref === 'system') applyTheme(themePref)
  })
  els.themeToggle.onclick = () => {
    const next =
      THEME_ORDER[(THEME_ORDER.indexOf(themePref) + 1) % THEME_ORDER.length]!
    themePref = next
    void chrome.storage.local.set({ theme: next })
    applyTheme(next)
  }
}

// --- 上部: 現在のタブの動画を開始する ---
async function findVideoTab(): Promise<chrome.tabs.Tab | null> {
  const [active] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  })
  if (active?.url && VIDEO_PAGE_PATTERN.test(active.url)) {
    return active
  }
  // パネルをタブとして開いた場合(E2E 等)は動画タブを検索する。
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
  const message: PanelMessage = { type: 'START_DOWNLOAD', job }
  await chrome.runtime.sendMessage(message)
  // パネルは開いたまま。開始したジョブは下部の一覧に現れる。
}

// 現在のタブに追従して上部を描き直す(パネルは持続 UI なのでタブ切替に能動的に反応する)。
async function renderTop(): Promise<void> {
  els.select.textContent = ''
  els.info.hidden = true
  els.loginHint.hidden = true
  els.reloadPage.hidden = true
  els.button.disabled = false
  setStatus('動画情報を取得中...')

  const tab = await findVideoTab()
  if (!tab?.id) {
    setStatus('対応している動画ページを開いた状態で使用してください。', 'error')
    return
  }

  let response: VideoInfoResponse
  try {
    response = await requestVideoInfo(tab.id)
  } catch {
    // content script が未注入(拡張の更新後などに前から開いていたタブ)だと sendMessage が
    // 例外になる。パネルの再読込では受信側が生まれないため、対象ページをリロードして注入させる。
    setStatus(
      '動画ページと通信できませんでした。下のボタンでページを再読み込みしてください。',
      'error',
    )
    const tabId = tab.id
    els.reloadPage.hidden = false
    els.reloadPage.onclick = () => {
      setStatus('ページを再読み込みしています...')
      els.reloadPage.hidden = true
      // 完了(tab status = complete)は init の onUpdated 購読が拾い、renderTop を再実行する。
      void chrome.tabs.reload(tabId)
    }
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
  // 再描画で重複しないよう addEventListener ではなく代入で差し替える。
  els.button.onclick = () => void startDownload(info)
}

// --- 下部: ダウンロード一覧 ---
function progressText(p: StreamProgress): string {
  if (p.total > 0) return `${formatBytes(p.received)} / ${formatBytes(p.total)}`
  return formatBytes(p.received)
}

function makeBar(label: string, p: StreamProgress): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'dl-bar'
  const name = document.createElement('span')
  name.className = 'dl-bar-label'
  name.textContent = label
  const bar = document.createElement('progress')
  if (p.total > 0) {
    bar.max = p.total
    bar.value = p.received
  } else {
    bar.removeAttribute('value')
  }
  const text = document.createElement('span')
  text.className = 'dl-bar-text'
  text.textContent = progressText(p)
  row.append(name, bar, text)
  return row
}

function formatTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function makeCancelButton(jobId: string): HTMLButtonElement {
  const cancel = document.createElement('button')
  cancel.className = 'link'
  cancel.textContent = 'キャンセル'
  cancel.onclick = () => {
    const message: PanelMessage = { type: 'CANCEL_DOWNLOAD', jobId }
    void chrome.runtime.sendMessage(message)
  }
  return cancel
}

function renderItem(item: DownloadItem): HTMLLIElement {
  const li = document.createElement('li')
  li.className = 'dl-item'
  li.dataset.status = item.status

  const head = document.createElement('div')
  head.className = 'dl-head'
  const title = document.createElement('span')
  title.className = 'dl-title'
  title.textContent = item.displayTitle
  const badge = document.createElement('span')
  badge.className = 'dl-badge'
  badge.textContent = STATUS_LABELS[item.status]
  head.append(title, badge)
  li.append(head)

  const time = document.createElement('div')
  time.className = 'dl-time'
  time.textContent = `開始 ${formatTime(item.createdAt)}`
  li.append(time)

  if (item.status === 'downloading') {
    li.append(makeBar('映像', item.video))
    if (item.audio) li.append(makeBar('音声', item.audio))
  } else if (item.status === 'merging' || item.status === 'saving') {
    const bar = document.createElement('div')
    bar.className = 'dl-indeterminate'
    li.append(bar)
  } else if (item.status === 'done' && item.filename) {
    const file = document.createElement('div')
    file.className = 'dl-file'
    file.textContent = item.filename
    li.append(file)
  } else if (item.status === 'error' && item.error) {
    const error = document.createElement('div')
    error.className = 'dl-error'
    error.textContent = item.error
    li.append(error)
  }

  if (item.status === 'queued' || isActiveStatus(item.status)) {
    const actions = document.createElement('div')
    actions.className = 'dl-actions'
    actions.append(makeCancelButton(item.jobId))
    li.append(actions)
  }
  return li
}

async function renderList(): Promise<void> {
  const stored = await chrome.storage.session.get(DOWNLOADS_KEY)
  const state = (stored[DOWNLOADS_KEY] as DownloadState | undefined) ?? {}
  // 開始時刻の新しい順(進行中・完了を問わず、最後に始めたものを一番上に)。
  const items = Object.values(state).sort((a, b) => b.createdAt - a.createdAt)
  const hasFinished = items.some(
    (i) => i.status === 'done' || i.status === 'error',
  )

  els.list.textContent = ''
  els.empty.hidden = items.length > 0
  els.clearFinished.hidden = !hasFinished
  for (const item of items) {
    els.list.append(renderItem(item))
  }
}

function init(): void {
  void initTheme()
  void renderTop()
  void renderList()

  chrome.tabs.onActivated.addListener(() => void renderTop())
  chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
    if (tab.active && changeInfo.status === 'complete') void renderTop()
  })
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[DOWNLOADS_KEY]) void renderList()
  })
  els.clearFinished.onclick = () => {
    const message: PanelMessage = { type: 'CLEAR_FINISHED' }
    void chrome.runtime.sendMessage(message)
  }
}

init()
