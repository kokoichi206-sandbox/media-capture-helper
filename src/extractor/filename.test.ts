import { describe, expect, it } from 'vitest'
import {
  buildDisplayTitle,
  buildOutputFilename,
  sanitizeFilename,
} from './filename'

describe('sanitizeFilename', () => {
  it('パス区切り・予約文字を _ にする', () => {
    expect(sanitizeFilename('a/b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i')
  })
  it('制御文字を除去する', () => {
    expect(sanitizeFilename('ab\x01\x1fcd')).toBe('abcd')
  })
  it('空白の連続を 1 つに畳む(空白自体は残す)', () => {
    expect(sanitizeFilename('a   b')).toBe('a b')
  })
  it('120 文字に切り詰める', () => {
    expect(sanitizeFilename('あ'.repeat(200)).length).toBe(120)
  })
  it('日本語・中国語はそのまま残す', () => {
    expect(sanitizeFilename('山川宇衣MSG')).toBe('山川宇衣MSG')
  })
})

describe('buildDisplayTitle', () => {
  it('パート名があれば連結', () => {
    expect(buildDisplayTitle('本編', 'part1')).toBe('本編 / part1')
  })
  it('パート名が空なら本編のみ', () => {
    expect(buildDisplayTitle('本編', '')).toBe('本編')
  })
})

describe('buildOutputFilename', () => {
  it('画質ラベル付きの mp4 名にする', () => {
    expect(buildOutputFilename('動画 / p1', '480P 标清')).toBe(
      '動画 _ p1 [480P 标清].mp4',
    )
  })
})
