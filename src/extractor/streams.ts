// DASH ストリームの選別と、画質選択肢・ダウンロード指示の組み立て(純粋ロジック)。

import type { Dash, DashStream, PlayInfo } from '../shared/api-types'
import type { DownloadJob, JobStream, VideoInfo } from '../shared/messages'

// 再生互換性の高い順。同一画質で複数コーデックが返るため 1 つに絞る指標。
export const CODEC_PRIORITY = ['avc1', 'hev1', 'hvc1', 'av01'] as const

export function codecRank(codecs: string): number {
  const i = CODEC_PRIORITY.findIndex((p) => codecs.startsWith(p))
  return i === -1 ? CODEC_PRIORITY.length : i
}

// 画質 ID を高い順・重複なしで返す(UI の選択肢順)。
export function listQualityIds(dash: Dash): number[] {
  return [...new Set(dash.video.map((v) => v.id))].sort((a, b) => b - a)
}

// 指定画質の映像から、コーデック優先度→帯域の順で 1 本選ぶ。
export function pickVideoStream(
  videos: DashStream[],
  qualityId: number,
): DashStream | undefined {
  return videos
    .filter((v) => v.id === qualityId)
    .sort(
      (a, b) =>
        codecRank(a.codecs) - codecRank(b.codecs) || b.bandwidth - a.bandwidth,
    )[0]
}

// 最高ビットレートの音声を選ぶ。音声トラックが無ければ null。
export function pickAudioStream(dash: Dash): DashStream | null {
  const audios = dash.audio ?? []
  return audios.slice().sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null
}

// 画質 ID を人間可読なラベルにする。support_formats が最も情報量が多い。
export function qualityLabel(playinfo: PlayInfo, qualityId: number): string {
  const format = (playinfo.support_formats ?? []).find(
    (f) => f.quality === qualityId,
  )
  return format?.new_description ?? format?.display_desc ?? `qn${qualityId}`
}

// accept_quality には「ログインすれば選べる画質」も含まれる。DASH で実際に取れる
// 最大画質より上の値があれば、ログインで解放される画質があると判断できる。
export function hasLockedQuality(playinfo: PlayInfo, dash: Dash): boolean {
  const ids = listQualityIds(dash)
  const maxDashQuality = ids[0] ?? 0
  return (playinfo.accept_quality ?? []).some((q) => q > maxDashQuality)
}

function toJobStream(stream: DashStream): JobStream {
  return {
    id: stream.id,
    url: stream.baseUrl,
    backupUrls: stream.backupUrl ?? [],
    codecs: stream.codecs,
  }
}

// 選択された画質から、downloader に渡す指示を組み立てる。
// dash や指定画質の映像が無い場合は不整合として例外にする(暗黙 fallback しない)。
export function buildDownloadJob(
  info: VideoInfo,
  qualityId: number,
): DownloadJob {
  const dash = info.playinfo.dash
  if (!dash) {
    throw new Error('この動画には DASH ストリームがありません')
  }
  const video = pickVideoStream(dash.video, qualityId)
  if (!video || video.width == null || video.height == null) {
    throw new Error(`画質 ${qualityId} の映像ストリームが見つかりません`)
  }
  const audio = pickAudioStream(dash)
  return {
    title: info.title,
    partTitle: info.partTitle,
    bvid: info.bvid,
    cid: info.cid,
    durationSec: info.durationSec,
    qualityId,
    qualityLabel: qualityLabel(info.playinfo, qualityId),
    video: { ...toJobStream(video), width: video.width, height: video.height },
    audio: audio ? toJobStream(audio) : null,
  }
}

// ダウンロード中に CDN URL の署名期限が切れた際、再取得した playinfo から進行中
// ジョブと同一実体のストリームを引き直す。Range による途中再開はバイト同一性が
// 前提のため、id と codecs の完全一致だけを許し、不一致は例外にする(fallback しない)。
export function refreshJobStreams(
  job: DownloadJob,
  playinfo: PlayInfo,
): { video: JobStream; audio: JobStream | null } {
  const dash = playinfo.dash
  if (!dash) {
    throw new Error('再取得した再生情報に DASH ストリームがありません')
  }
  const video = dash.video.find(
    (v) => v.id === job.video.id && v.codecs === job.video.codecs,
  )
  if (!video) {
    throw new Error(
      `再取得した再生情報に同一の映像ストリームがありません (id=${job.video.id}, ${job.video.codecs})`,
    )
  }
  const jobAudio = job.audio
  if (!jobAudio) {
    return { video: toJobStream(video), audio: null }
  }
  const audio = (dash.audio ?? []).find(
    (a) => a.id === jobAudio.id && a.codecs === jobAudio.codecs,
  )
  if (!audio) {
    throw new Error(
      `再取得した再生情報に同一の音声ストリームがありません (id=${jobAudio.id})`,
    )
  }
  return { video: toJobStream(video), audio: toJobStream(audio) }
}
