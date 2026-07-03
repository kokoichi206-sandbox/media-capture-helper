import type {
  DownloadBlobRequest,
  DownloadBlobResponse,
  DownloadJob,
  DownloadStatus,
  JobStream,
  OffscreenEvent,
  OffscreenMessage,
} from '../../src/shared/messages'
import {
  buildDisplayTitle,
  buildOutputFilename,
} from '../../src/extractor/filename'
import { loadFFmpeg } from '../../src/downloader/ffmpeg-loader'

// 不可視の作業エンジン。background の RUN_JOB を受け取り、DASH の映像・音声を
// fetch → ffmpeg.wasm(-c copy = 再エンコードなし)で 1 つの MP4 に結合して保存する。
// 進捗・状態は background へメッセージで返し、UI(サイドパネル)は storage 経由で描画する。
// downloader タブを廃し可視ページを不要にするため、DOM への描画は持たない。

// 進捗イベントの送信間隔。1 チャンクごとに送るとメッセージが溢れるため間引く。
const PROGRESS_INTERVAL_MS = 200

// ffmpeg は 1 インスタンスのみで CPU も重いため、この offscreen では常に 1 ジョブだけ
// 処理する(並列化は background 側のキューで直列化される前提)。
interface ActiveJob {
  jobId: string
  controller: AbortController
  cancelled: boolean
}
let active: ActiveJob | null = null

function emit(event: OffscreenEvent): void {
  // 応答は不要。SW 停止に伴う "port closed" は無害なので握りつぶす。
  void chrome.runtime.sendMessage(event).catch(() => {})
}

function reportStatus(
  jobId: string,
  status: DownloadStatus,
  extra?: { error?: string; filename?: string },
): void {
  emit({ type: 'JOB_STATUS', jobId, status, ...extra })
}

type ProgressReporter = (received: number, total: number) => void

function progressReporter(
  jobId: string,
  kind: 'video' | 'audio',
): ProgressReporter {
  let last = 0
  return (received, total) => {
    const isFinal = total > 0 && received >= total
    const now = Date.now()
    if (!isFinal && now - last < PROGRESS_INTERVAL_MS) return
    last = now
    emit({ type: 'JOB_PROGRESS', jobId, kind, received, total })
  }
}

async function fetchWithProgress(
  url: string,
  onProgress: ProgressReporter,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetch(url, { signal })
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
  kind: 'video' | 'audio',
  stream: JobStream,
  onProgress: ProgressReporter,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const candidates = [stream.url, ...stream.backupUrls]
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return await fetchWithProgress(candidate, onProgress, signal)
    } catch (err) {
      // 中断(キャンセル)は多重化で救えないので即座に打ち切る。
      if (signal.aborted) throw err
      lastError = err
    }
  }
  throw new Error(
    `${kind}ストリームを取得できませんでした: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

// 保存(chrome.downloads)は offscreen から使えないため、blob URL を background へ渡して
// 実行を依頼する。background の応答を待って初めて done を報告する。
async function requestDownload(
  jobId: string,
  blobUrl: string,
  filename: string,
): Promise<DownloadBlobResponse> {
  const request: DownloadBlobRequest = {
    type: 'DOWNLOAD_BLOB',
    jobId,
    blobUrl,
    filename,
  }
  return (await chrome.runtime.sendMessage(request)) as DownloadBlobResponse
}

function throwIfCancelled(job: ActiveJob): void {
  // fetch は AbortSignal で止まるが ffmpeg 結合は中断できないため、段階の境目で確認する。
  if (job.cancelled) throw new Error('キャンセルしました')
}

async function runJob(jobId: string, job: DownloadJob): Promise<void> {
  const displayTitle = buildDisplayTitle(job.title, job.partTitle)
  const current: ActiveJob = {
    jobId,
    controller: new AbortController(),
    cancelled: false,
  }
  active = current

  try {
    reportStatus(jobId, 'downloading')
    const ffmpegPromise = loadFFmpeg(() => {})

    const [videoData, audioData] = await Promise.all([
      fetchStream(
        'video',
        job.video,
        progressReporter(jobId, 'video'),
        current.controller.signal,
      ),
      job.audio
        ? fetchStream(
            'audio',
            job.audio,
            progressReporter(jobId, 'audio'),
            current.controller.signal,
          )
        : Promise.resolve(null),
    ])
    throwIfCancelled(current)

    reportStatus(jobId, 'merging')
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
    throwIfCancelled(current)

    reportStatus(jobId, 'saving')
    const filename = buildOutputFilename(displayTitle, job.qualityLabel)
    const blobUrl = URL.createObjectURL(
      new Blob([output as BlobPart], { type: 'video/mp4' }),
    )
    try {
      const result = await requestDownload(jobId, blobUrl, filename)
      if (!result.ok) throw new Error(result.error)
    } finally {
      // background が保存完了を待って応答するため、ここで解放して問題ない。
      URL.revokeObjectURL(blobUrl)
    }

    reportStatus(jobId, 'done', { filename })
  } catch (err) {
    reportStatus(jobId, 'error', {
      error: err instanceof Error ? err.message : String(err),
    })
  } finally {
    if (active?.jobId === jobId) active = null
  }
}

function handleMessage(message: OffscreenMessage): void {
  switch (message.type) {
    case 'RUN_JOB':
      // background がキューを直列化する前提。万一重複したら無視して現ジョブを守る。
      if (active) return
      void runJob(message.jobId, message.job)
      return
    case 'CANCEL_JOB':
      if (active?.jobId === message.jobId) {
        active.cancelled = true
        active.controller.abort()
      }
      return
  }
}

function isOffscreenMessage(v: unknown): v is OffscreenMessage {
  if (typeof v !== 'object' || v === null) return false
  const type = (v as { type?: unknown }).type
  return type === 'RUN_JOB' || type === 'CANCEL_JOB'
}

chrome.runtime.onMessage.addListener((message) => {
  if (isOffscreenMessage(message)) handleMessage(message)
})
