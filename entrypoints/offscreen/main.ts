import type {
  DownloadBlobRequest,
  DownloadBlobResponse,
  DownloadJob,
  DownloadStatus,
  JobStream,
  OffscreenEvent,
  OffscreenMessage,
  RefreshStreamsRequest,
  RefreshStreamsResponse,
} from '../../src/shared/messages'
import {
  buildDisplayTitle,
  buildOutputFilename,
} from '../../src/extractor/filename'
import { loadFFmpeg } from '../../src/downloader/ffmpeg-loader'
import type { FFmpegLike } from '../../src/downloader/ffmpeg-loader'

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

/**
 * CDN URL は署名期限(deadline)付きで、期限を跨ぐと転送中でも切断される。
 * 切断や候補切替のたびに先頭からやり直さないよう、
 * 受信済みバイトを候補・URL 再取得をまたいで持ち回り、Range で続きから再開する。
 */
interface StreamBuffer {
  chunks: Uint8Array[]
  received: number
  total: number
}

/**
 * 進捗が一切ないまま URL 再取得だけを繰り返す異常系(恒久的な 403 等)の打ち切り回数。
 * 進捗があればカウントは戻るため、期限を複数回跨ぐ長時間ダウンロードは制限されない。
 */
const MAX_STALLED_REFRESHES = 3

function parseContentRange(
  header: string | null,
): { start: number; total: number } | null {
  const m = /^bytes (\d+)-\d+\/(\d+|\*)$/.exec(header ?? '')
  if (!m) return null
  return { start: Number(m[1]), total: m[2] === '*' ? 0 : Number(m[2]) }
}

/**
 * 1 つの URL から受信済み位置以降を取得してバッファへ追記する。
 * 途中切断(deadline 執行を含む)は total との不一致で検出して例外にし、呼び出し側の再開に委ねる。
 */
async function fetchRange(
  url: string,
  buf: StreamBuffer,
  onProgress: ProgressReporter,
  signal: AbortSignal,
): Promise<void> {
  const resume = buf.received > 0
  const res = await fetch(url, {
    signal,
    headers: resume ? { Range: `bytes=${buf.received}-` } : undefined,
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  if (resume) {
    if (res.status === 206) {
      const range = parseContentRange(res.headers.get('content-range'))
      if (!range || range.start !== buf.received) {
        throw new Error(
          `Range 再開位置が一致しません (要求 ${buf.received}, 応答 ${range ? range.start : '不明'})`,
        )
      }
      if (buf.total === 0 && range.total > 0) buf.total = range.total
    } else {
      // Range を無視して全体(200)が返った場合は、受信済みを破棄して先頭から取り直す。
      buf.chunks = []
      buf.received = 0
    }
  }
  if (buf.total === 0) {
    const remaining = Number(res.headers.get('content-length') ?? 0)
    if (remaining > 0) buf.total = buf.received + remaining
  }
  const reader = res.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf.chunks.push(value)
    buf.received += value.length
    onProgress(buf.received, buf.total)
  }
  if (buf.total > 0 && buf.received < buf.total) {
    throw new Error(
      `転送が途中で終了しました (${buf.received}/${buf.total} bytes)`,
    )
  }
}

/**
 * 全候補が失敗したとき、background 経由でページコンテキストから新しい署名の URL を取り直す。
 * (認証 Cookie が要るため offscreen からは再取得できない)。
 */
async function requestRefreshedStream(
  jobId: string,
  kind: 'video' | 'audio',
): Promise<JobStream> {
  const request: RefreshStreamsRequest = { type: 'REFRESH_STREAMS', jobId }
  const response = (await chrome.runtime.sendMessage(
    request,
  )) as RefreshStreamsResponse
  if (!response.ok) {
    throw new Error(`URL の再取得に失敗しました: ${response.error}`)
  }
  const stream = kind === 'video' ? response.data.video : response.data.audio
  if (!stream) {
    throw new Error('URL の再取得結果に音声ストリームがありません')
  }
  return stream
}

// primary → backup の順に試し(明示的な多重化)、全滅したら URL を再取得して
// 受信済み位置から再開する(署名期限切れへの対処)。どちらも失敗は握りつぶさない。
async function fetchStream(
  jobId: string,
  kind: 'video' | 'audio',
  stream: JobStream,
  onProgress: ProgressReporter,
  signal: AbortSignal,
): Promise<Blob> {
  const buf: StreamBuffer = { chunks: [], received: 0, total: 0 }
  let candidates = [stream.url, ...stream.backupUrls]
  let stalledRefreshes = 0
  let receivedAtRefresh = 0
  let lastError: unknown
  let complete = false
  for (;;) {
    for (const candidate of candidates) {
      try {
        await fetchRange(candidate, buf, onProgress, signal)
        complete = true
        break
      } catch (err) {
        // 中断(キャンセル)は再開しても無意味なので即座に打ち切る。
        if (signal.aborted) throw err
        // 最終バイトまで受信済みなら、直後に切断されていてもデータは完全。
        // 末尾からの再開要求は定義上 416 にしかならないため、完了として扱う。
        if (buf.total > 0 && buf.received >= buf.total) {
          complete = true
          break
        }
        lastError = err
      }
    }
    if (complete) break
    stalledRefreshes =
      buf.received > receivedAtRefresh ? 0 : stalledRefreshes + 1
    if (stalledRefreshes > MAX_STALLED_REFRESHES) break
    receivedAtRefresh = buf.received
    try {
      const fresh = await requestRefreshedStream(jobId, kind)
      candidates = [fresh.url, ...fresh.backupUrls]
    } catch (err) {
      lastError = err
      break
    }
  }
  if (!complete) {
    throw new Error(
      `${kind}ストリームを取得できませんでした: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    )
  }
  // フルサイズの連続バッファ(数 GB の単一確保)は作らず、チャンクのまま Blob に
  // 束ねる。大きな Blob はブラウザがディスクへ退避するため、以降チャンクは GC 可能。
  return new Blob(buf.chunks)
}

/**
 * 保存(chrome.downloads)は offscreen から使えないため、
 * blob URL を background へ渡して実行を依頼する。
 * background の応答を待って初めて done を報告する。
 */
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

// WORKERFS の mount 先と fMP4 セグメントの出力先。offscreen は連続ジョブで
// 使い回されるため、いずれもジョブ終端で必ず片付ける。
const INPUT_DIR = '/input'
const OUTPUT_DIR = '/merged'

// セグメント長(秒)。短いほど 1 ファイルあたりの確保が小さくなる代わりに数が増える。
const SEGMENT_SECONDS = 30

// OUTPUT_DIR の残ファイルとディレクトリを外す(成功時は collectFmp4 が大半を削除済み)。
// 後始末の失敗で本来のエラーを差し替えない(問題は次ジョブの createDir 失敗で表面化する)。
async function removeOutputDir(ffmpeg: FFmpegLike): Promise<void> {
  try {
    for (const node of await ffmpeg.listDir(OUTPUT_DIR)) {
      if (!node.isDir) await ffmpeg.deleteFile(`${OUTPUT_DIR}/${node.name}`)
    }
    await ffmpeg.deleteDir(OUTPUT_DIR)
  } catch (err) {
    console.error('[offscreen] output cleanup failed', err)
  }
}

// init + セグメント(番号順)を連結して 1 つの fMP4 Blob にする。fMP4 は
// 「init + moof/mdat 列の単純連結 = 有効な MP4」なので、Blob の参照連結だけで
// 全長の連続バッファを一切作らずにファイルを組み立てられる。
async function collectFmp4(ffmpeg: FFmpegLike): Promise<Blob> {
  const entries = await ffmpeg.listDir(OUTPUT_DIR)
  const segments = entries
    .filter((e) => !e.isDir)
    .map((e) => /^seg(\d+)\.m4s$/.exec(e.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[0])
  if (segments.length === 0) {
    throw new Error('結合結果のセグメントがありません')
  }
  let assembled = new Blob([], { type: 'video/mp4' })
  for (const name of ['init.mp4', ...segments]) {
    const path = `${OUTPUT_DIR}/${name}`
    const data = await ffmpeg.readFile(path)
    if (typeof data === 'string') {
      throw new Error(`結合結果の読み出しに失敗しました: ${name}`)
    }
    assembled = new Blob([assembled, data as BlobPart], { type: 'video/mp4' })
    // 読み出し済みセグメントは直ちに消し、worker 側の保持量を増やさない。
    await ffmpeg.deleteFile(path)
  }
  return assembled
}

// 入力 Blob を WORKERFS で遅延読みさせ、-c copy(再エンコードなし)で結合する。
// 出力を古典的 MP4 にしない理由: MEMFS はファイルを 1 本の連続配列で持つため、
// 数 GB の動画で確保に失敗する(実測: RangeError)。fMP4 セグメント列で小分けに
// 書かせ、連結して 1 ファイルにする。
async function mergeStreams(
  ffmpeg: FFmpegLike,
  videoBlob: Blob,
  audioBlob: Blob | null,
): Promise<Blob> {
  const blobs = [{ name: 'video.m4s', data: videoBlob }]
  if (audioBlob) blobs.push({ name: 'audio.m4s', data: audioBlob })
  await ffmpeg.createDir(INPUT_DIR)
  try {
    await ffmpeg.createDir(OUTPUT_DIR)
    try {
      await ffmpeg.mount('WORKERFS', { blobs }, INPUT_DIR)
      try {
        const args = ['-y', '-i', `${INPUT_DIR}/video.m4s`]
        if (audioBlob) args.push('-i', `${INPUT_DIR}/audio.m4s`)
        args.push(
          '-c',
          'copy',
          '-f',
          'hls',
          '-hls_time',
          String(SEGMENT_SECONDS),
          '-hls_list_size',
          '0',
          '-hls_segment_type',
          'fmp4',
          // init はプレイリストと同じディレクトリ(OUTPUT_DIR)に置かれる。
          '-hls_fmp4_init_filename',
          'init.mp4',
          '-hls_segment_filename',
          `${OUTPUT_DIR}/seg%d.m4s`,
          `${OUTPUT_DIR}/play.m3u8`,
        )
        const code = await ffmpeg.exec(args)
        if (code !== 0) {
          throw new Error(`ffmpeg の変換に失敗しました (exit code ${code})`)
        }
        return await collectFmp4(ffmpeg)
      } finally {
        // 後始末の失敗で本来のエラーを差し替えない(問題は次ジョブの mount 失敗で表面化する)。
        await ffmpeg.unmount(INPUT_DIR).catch((err: unknown) => {
          console.error('[offscreen] unmount failed', err)
        })
      }
    } finally {
      await removeOutputDir(ffmpeg)
    }
  } finally {
    await ffmpeg.deleteDir(INPUT_DIR).catch((err: unknown) => {
      console.error('[offscreen] deleteDir failed', err)
    })
  }
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

    const [videoBlob, audioBlob] = await Promise.all([
      fetchStream(
        jobId,
        'video',
        job.video,
        progressReporter(jobId, 'video'),
        current.controller.signal,
      ),
      job.audio
        ? fetchStream(
            jobId,
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
    const output = await mergeStreams(ffmpeg, videoBlob, audioBlob)
    throwIfCancelled(current)

    reportStatus(jobId, 'saving')
    const filename = buildOutputFilename(displayTitle, job.qualityLabel)
    const blobUrl = URL.createObjectURL(output)
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
