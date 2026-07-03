// メッセージ契約(popup / content / downloader 共通のコントラクト層)。
// 判別共用体と Result 型で payload を固定し、取りこぼしを型で防ぐ。

import type { PlayInfo } from './api-types'

// 成否を明示する結果型。fallback で握りつぶさず、失敗は error として運ぶ。
export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

// content script が返す、動画ページから取得した情報。
export interface VideoInfo {
  bvid: string
  cid: number
  page: number
  title: string
  // 多パート動画のときだけパート名。単一動画では空文字。
  partTitle: string
  durationSec: number
  playinfo: PlayInfo
}

// popup -> content script。開いている動画の情報を要求する。
export type ContentRequest = { type: 'GET_VIDEO_INFO' }

export type VideoInfoResponse = Result<VideoInfo>

// ダウンロード対象の 1 ストリーム(映像 or 音声)。CDN は落ちることがあるため
// backupUrls も持ち、順に試す(暗黙 fallback ではなく明示的な多重化)。
export interface JobStream {
  // DASH 上のストリーム識別子(映像は画質 ID、音声は音質 ID)。URL 再取得時に
  // 同一実体のストリームを引き直すためのキー(codecs と併用)。
  id: number
  url: string
  backupUrls: string[]
  codecs: string
}

// popup -> downloader ページ(session storage 経由)で渡すダウンロード指示。
export interface DownloadJob {
  title: string
  partTitle: string
  bvid: string
  cid: number
  durationSec: number
  qualityId: number
  qualityLabel: string
  video: JobStream & { width: number; height: number }
  // 音声トラックが無い動画(古い/無音)では null。
  audio: JobStream | null
}

export function isContentRequest(v: unknown): v is ContentRequest {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'GET_VIDEO_INFO'
  )
}

// ダウンロードの進行状態。offscreen 内の一過性(ffmpeg 読込中など)は downloading に
// 畳み、UI が一覧で扱える粒度だけを状態機械に残す。
export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'merging'
  | 'saving'
  | 'done'
  | 'error'

// 進行中と見なす状態(この間は offscreen が占有され、次のキューは動かない)。
export const ACTIVE_STATUSES: readonly DownloadStatus[] = [
  'downloading',
  'merging',
  'saving',
]

export function isActiveStatus(status: DownloadStatus): boolean {
  return ACTIVE_STATUSES.includes(status)
}

// 1 ストリームの受信バイト進捗。total=0 は content-length 不明を表す。
export interface StreamProgress {
  received: number
  total: number
}

// サイドパネルの一覧が描画する 1 ダウンロードの状態。background が唯一の書き手で、
// storage.session の DOWNLOADS_KEY 配下に jobId をキーにして持つ。
export interface DownloadItem {
  jobId: string
  displayTitle: string
  qualityLabel: string
  meta: string
  status: DownloadStatus
  video: StreamProgress
  // 音声トラックが無い動画では null。
  audio: StreamProgress | null
  filename: string | null
  error: string | null
  createdAt: number
  finishedAt: number | null
}

// storage.session に置くダウンロード状態マップのキーと型。
export const DOWNLOADS_KEY = 'downloads'
export type DownloadState = Record<string, DownloadItem>

// jobId は動画・パート・画質の同一性から決まる。パネルと background で同じ関数を
// 使い、キーのドリフト(開始したのに一覧に出ない等)を防ぐ。
export function downloadJobId(job: DownloadJob): string {
  return `job-${job.bvid}-${job.cid}-${job.qualityId}`
}

// サイドパネル -> background。
export type PanelMessage =
  | { type: 'START_DOWNLOAD'; job: DownloadJob }
  | { type: 'CANCEL_DOWNLOAD'; jobId: string }
  | { type: 'CLEAR_FINISHED' }

// background -> offscreen(作業エンジン)。
export type OffscreenMessage =
  | { type: 'RUN_JOB'; jobId: string; job: DownloadJob }
  | { type: 'CANCEL_JOB'; jobId: string }

// offscreen -> background。進捗と状態遷移を通知し、background が storage に反映する。
export type OffscreenEvent =
  | {
      type: 'JOB_PROGRESS'
      jobId: string
      kind: 'video' | 'audio'
      received: number
      total: number
    }
  | {
      type: 'JOB_STATUS'
      jobId: string
      status: DownloadStatus
      error?: string
      filename?: string
    }

// offscreen -> background(要応答)。chrome.downloads は offscreen に無いため、offscreen が
// 生成した blob URL の保存を background(service worker)に代行させる。blob URL は同一拡張
// オリジンなので SW からでも解決できる。
export type DownloadBlobRequest = {
  type: 'DOWNLOAD_BLOB'
  jobId: string
  blobUrl: string
  filename: string
}
export type DownloadBlobResponse = { ok: true } | { ok: false; error: string }

// offscreen -> background(要応答)。CDN URL は署名期限(deadline)付きで、長時間の
// ダウンロードでは転送中に失効して切断される。認証 Cookie が要るため offscreen からは
// 再取得できず、動画ページの content script 経由で新しい署名の URL を引き直してもらう。
export type RefreshStreamsRequest = { type: 'REFRESH_STREAMS'; jobId: string }
export type RefreshStreamsResponse = Result<{
  video: JobStream
  audio: JobStream | null
}>
