import { describe, expect, it } from 'vitest'
import type { Dash, DashStream, PlayInfo } from '../shared/api-types'
import type { VideoInfo } from '../shared/messages'
import {
  buildDownloadJob,
  codecRank,
  hasLockedQuality,
  listQualityIds,
  pickAudioStream,
  pickVideoStream,
  qualityLabel,
} from './streams'

function video(partial: Partial<DashStream> & { id: number }): DashStream {
  return {
    baseUrl: `https://cdn.example/${partial.id}-${partial.codecs ?? 'avc1'}.m4s`,
    backupUrl: ['https://backup.example/x.m4s'],
    codecs: 'avc1.64001F',
    bandwidth: 100000,
    mimeType: 'video/mp4',
    width: 640,
    height: 480,
    ...partial,
  }
}

function audio(partial: Partial<DashStream> & { id: number }): DashStream {
  return {
    baseUrl: `https://cdn.example/audio-${partial.id}.m4s`,
    codecs: 'mp4a.40.2',
    bandwidth: 60000,
    mimeType: 'audio/mp4',
    ...partial,
  }
}

describe('codecRank', () => {
  it('avc1 を最優先にする', () => {
    expect(codecRank('avc1.64001F')).toBeLessThan(codecRank('av01.0.08M'))
    expect(codecRank('hev1.1')).toBeLessThan(codecRank('av01.0.08M'))
  })
  it('未知コーデックは最後尾', () => {
    expect(codecRank('vp09')).toBe(4)
  })
})

describe('listQualityIds', () => {
  it('重複を除いて降順', () => {
    const dash: Dash = {
      duration: 10,
      video: [
        video({ id: 32 }),
        video({ id: 32, codecs: 'av01' }),
        video({ id: 16 }),
      ],
      audio: null,
    }
    expect(listQualityIds(dash)).toEqual([32, 16])
  })
})

describe('pickVideoStream', () => {
  it('同一画質では avc1 を選ぶ', () => {
    const videos = [
      video({ id: 32, codecs: 'av01.0.08M', bandwidth: 130000 }),
      video({ id: 32, codecs: 'avc1.64001F', bandwidth: 300000 }),
    ]
    expect(pickVideoStream(videos, 32)?.codecs).toBe('avc1.64001F')
  })
  it('同一コーデックなら高帯域を選ぶ', () => {
    const videos = [
      video({ id: 32, codecs: 'avc1.a', bandwidth: 100000 }),
      video({ id: 32, codecs: 'avc1.b', bandwidth: 200000 }),
    ]
    expect(pickVideoStream(videos, 32)?.bandwidth).toBe(200000)
  })
  it('該当画質が無ければ undefined', () => {
    expect(pickVideoStream([video({ id: 32 })], 64)).toBeUndefined()
  })
})

describe('pickAudioStream', () => {
  it('最高ビットレートを選ぶ', () => {
    const dash: Dash = {
      duration: 10,
      video: [],
      audio: [
        audio({ id: 30216, bandwidth: 65000 }),
        audio({ id: 30280, bandwidth: 165000 }),
      ],
    }
    expect(pickAudioStream(dash)?.id).toBe(30280)
  })
  it('音声が無ければ null', () => {
    expect(pickAudioStream({ duration: 10, video: [], audio: null })).toBeNull()
  })
})

describe('qualityLabel', () => {
  it('support_formats の説明を使う', () => {
    const playinfo = {
      support_formats: [{ quality: 80, new_description: '1080P 高清' }],
    } as PlayInfo
    expect(qualityLabel(playinfo, 80)).toBe('1080P 高清')
  })
  it('未知の画質は qn+id にフォールバック', () => {
    expect(
      qualityLabel({ support_formats: [] } as unknown as PlayInfo, 16),
    ).toBe('qn16')
  })
})

describe('hasLockedQuality', () => {
  const dash: Dash = { duration: 10, video: [video({ id: 32 })], audio: null }
  it('accept_quality に DASH 最大より上があれば true(ログインで解放)', () => {
    const playinfo = { accept_quality: [80, 64, 32] } as PlayInfo
    expect(hasLockedQuality(playinfo, dash)).toBe(true)
  })
  it('DASH 最大以下しか無ければ false', () => {
    const playinfo = { accept_quality: [32, 16] } as PlayInfo
    expect(hasLockedQuality(playinfo, dash)).toBe(false)
  })
})

describe('buildDownloadJob', () => {
  const info: VideoInfo = {
    bvid: 'BV1xx',
    cid: 123,
    page: 1,
    title: 'タイトル',
    partTitle: '',
    durationSec: 37,
    playinfo: {
      quality: 32,
      accept_quality: [32, 16],
      accept_description: [],
      support_formats: [{ quality: 32, new_description: '480P 标清' }],
      dash: {
        duration: 37,
        video: [
          video({ id: 32, codecs: 'av01', bandwidth: 130000 }),
          video({ id: 32, codecs: 'avc1.64001F', bandwidth: 300000 }),
        ],
        audio: [audio({ id: 30280, bandwidth: 165000 })],
      },
    },
  }

  it('選択画質の映像(avc1)と最高音声を含む job を作る', () => {
    const job = buildDownloadJob(info, 32)
    expect(job.qualityLabel).toBe('480P 标清')
    expect(job.video.codecs).toBe('avc1.64001F')
    expect(job.video.width).toBe(640)
    expect(job.audio?.url).toContain('audio-30280')
    expect(job.video.backupUrls.length).toBe(1)
  })

  it('DASH が無ければ例外(暗黙 fallback しない)', () => {
    const noDash = { ...info, playinfo: { ...info.playinfo, dash: undefined } }
    expect(() => buildDownloadJob(noDash, 32)).toThrow(/DASH/)
  })

  it('存在しない画質は例外', () => {
    expect(() => buildDownloadJob(info, 64)).toThrow(/64/)
  })
})
