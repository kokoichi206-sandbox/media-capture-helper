import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 対象は純粋ロジック(URL 解析・ストリーム選別・ファイル名生成)のみ。
    // ネットワーク取得・ffmpeg 結合・chrome.* は実機 Chrome でしか検証できない。
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
