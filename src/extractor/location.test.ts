import { describe, expect, it } from 'vitest'
import { parseVideoLocation } from './location'

describe('parseVideoLocation', () => {
  it('BV 形式を取り出す', () => {
    expect(
      parseVideoLocation('https://www.bilibili.com/video/BV1TajH6UE54/'),
    ).toEqual({ bvid: 'BV1TajH6UE54', page: 1 })
  })

  it('クエリ付き URL でも BV を取り出す', () => {
    expect(
      parseVideoLocation(
        'https://www.bilibili.com/video/BV1TajH6UE54/?spm_id_from=333.788&vd_source=x',
      ),
    ).toEqual({ bvid: 'BV1TajH6UE54', page: 1 })
  })

  it('p パラメータをパート番号にする', () => {
    expect(
      parseVideoLocation('https://www.bilibili.com/video/BV1xx/?p=3'),
    ).toEqual({ bvid: 'BV1xx', page: 3 })
  })

  it('av 形式は aid にする', () => {
    expect(
      parseVideoLocation('https://www.bilibili.com/video/av12345'),
    ).toEqual({ aid: '12345', page: 1 })
  })

  it('不正な p は 1 に丸める', () => {
    expect(
      parseVideoLocation('https://www.bilibili.com/video/BV1xx/?p=0'),
    ).toEqual({ bvid: 'BV1xx', page: 1 })
    expect(
      parseVideoLocation('https://www.bilibili.com/video/BV1xx/?p=abc'),
    ).toEqual({ bvid: 'BV1xx', page: 1 })
  })

  it('動画ページでない URL は null', () => {
    expect(parseVideoLocation('https://www.bilibili.com/')).toBeNull()
    expect(parseVideoLocation('not a url')).toBeNull()
  })
})
