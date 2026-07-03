import type { DownloadJob, JobStream } from '../../src/shared/messages'
import {
  buildDisplayTitle,
  buildOutputFilename,
} from '../../src/extractor/filename'
import { loadFFmpeg } from '../../src/downloader/ffmpeg-loader'

// 進捗表示付きのダウンロード実行ページ。DASH の映像・音声を fetch し、
// ffmpeg.wasm の -c copy(再エンコードなし)で 1 つの MP4 に結合して保存する。

type StatusState =
  | 'init'
  | 'loading'
  | 'downloading'
  | 'merging'
  | 'saving'
  | 'done'
  | 'error'

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} が見つかりません`)
  return el as T
}

const els = {
  status: byId<HTMLDivElement>('status'),
  title: byId<HTMLHeadingElement>('video-title'),
  meta: byId<HTMLParagraphElement>('video-meta'),
  log: byId<HTMLPreElement>('log'),
}

function setStatus(text: string, state: StatusState): void {
  els.status.textContent = text
  els.status.dataset.state = state
}

function log(line: string): void {
  els.log.textContent += `${line}\n`
  els.log.scrollTop = els.log.scrollHeight
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

type ProgressReporter = (received: number, total: number) => void

function progressReporter(kind: 'video' | 'audio'): ProgressReporter {
  const row = byId<HTMLDivElement>(`${kind}-progress-row`)
  const bar = byId<HTMLProgressElement>(`${kind}-progress`)
  const text = byId<HTMLSpanElement>(`${kind}-progress-text`)
  row.hidden = false
  return (received, total) => {
    if (total > 0) {
      bar.max = total
      bar.value = received
      text.textContent = `${formatBytes(received)} / ${formatBytes(total)}`
    } else {
      bar.removeAttribute('value')
      text.textContent = formatBytes(received)
    }
  }
}

async function fetchWithProgress(
  url: string,
  onProgress: ProgressReporter,
): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const total = Number(res.headers.get('content-length') ?? 0)
  const reader = res.body!.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    onProgress(received, total)
  }
  const data = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.length
  }
  return data
}

// primary が失敗したら backup を順に試す(暗黙 fallback ではなく明示的な多重化)。
async function fetchStream(
  kind: string,
  stream: JobStream,
  onProgress: ProgressReporter,
): Promise<Uint8Array> {
  const candidates = [stream.url, ...stream.backupUrls]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      log(`${kind}: ${new URL(candidate).host} からダウンロード開始`)
      return await fetchWithProgress(candidate, onProgress)
    } catch (err) {
      lastError = err
      log(
        `${kind}: 失敗 (${err instanceof Error ? err.message : String(err)})。次の URL を試します。`,
      )
    }
  }
  throw new Error(
    `${kind}ストリームを取得できませんでした: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

async function saveBlob(blob: Blob, filename: string): Promise<void> {
  const blobUrl = URL.createObjectURL(blob)
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
    })
    await waitForDownload(downloadId)
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
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

async function run(): Promise<void> {
  const jobId = new URLSearchParams(location.search).get('job')
  if (!jobId) {
    setStatus('ダウンロード情報の ID がありません。', 'error')
    return
  }
  const stored = await chrome.storage.session.get(jobId)
  const job = stored[jobId] as DownloadJob | undefined
  if (!job) {
    setStatus(
      'ダウンロード情報が見つかりません。ポップアップからやり直してください。',
      'error',
    )
    return
  }

  const displayTitle = buildDisplayTitle(job.title, job.partTitle)
  els.title.textContent = displayTitle
  document.title = `DL: ${displayTitle}`
  els.meta.textContent =
    `${job.bvid} / ${job.qualityLabel} (${job.video.width}x${job.video.height}, ${job.video.codecs})` +
    (job.audio ? '' : ' / 音声トラックなし')

  setStatus('ffmpeg.wasm を読み込み中...', 'loading')
  const ffmpegPromise = loadFFmpeg((message) => log(`[ffmpeg] ${message}`))

  setStatus('ストリームをダウンロード中...', 'downloading')
  const [videoData, audioData] = await Promise.all([
    fetchStream('映像', job.video, progressReporter('video')),
    job.audio
      ? fetchStream('音声', job.audio, progressReporter('audio'))
      : Promise.resolve(null),
  ])
  log(`映像: ${formatBytes(videoData.length)} 取得完了`)
  if (audioData) {
    log(`音声: ${formatBytes(audioData.length)} 取得完了`)
  }

  setStatus('MP4 に変換中 (再エンコードなし)...', 'merging')
  const ffmpeg = await ffmpegPromise
  await ffmpeg.writeFile('video.m4s', videoData)
  const args = ['-i', 'video.m4s']
  if (audioData) {
    await ffmpeg.writeFile('audio.m4s', audioData)
    args.push('-i', 'audio.m4s')
  }
  args.push('-c', 'copy', '-movflags', '+faststart', 'output.mp4')
  const code = await ffmpeg.exec(args)
  if (code !== 0) {
    throw new Error(`ffmpeg の変換に失敗しました (exit code ${code})`)
  }
  const output = await ffmpeg.readFile('output.mp4')
  if (typeof output === 'string') {
    throw new Error('ffmpeg 出力の読み出しに失敗しました')
  }

  setStatus('ファイルを保存中...', 'saving')
  const filename = buildOutputFilename(displayTitle, job.qualityLabel)
  await saveBlob(
    new Blob([output as BlobPart], { type: 'video/mp4' }),
    filename,
  )

  await chrome.storage.session.remove(jobId)
  setStatus(`完了: ${filename}`, 'done')
}

void run().catch((err: unknown) => {
  console.error(err)
  setStatus(
    `エラー: ${err instanceof Error ? err.message : String(err)}`,
    'error',
  )
})
