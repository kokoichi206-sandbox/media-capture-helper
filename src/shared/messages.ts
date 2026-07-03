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
