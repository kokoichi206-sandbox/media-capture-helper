// node_modules から ffmpeg.wasm 一式を public/vendor へコピーする。
// 拡張は CDN からのスクリプト読み込みが CSP で禁止されているため、全アセットを
// 拡張内に同梱する。public/ 配下は WXT がビルド出力へそのままコピーする。
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = join(root, 'public', 'vendor')

await rm(vendorDir, { recursive: true, force: true })
await mkdir(vendorDir, { recursive: true })

// 実行時に不要な型定義(.d.ts / .d.mts)は同梱しない。
const runtimeOnly = {
  recursive: true,
  filter: (src) => !/\.d\.m?ts$/.test(src),
}

await cp(
  join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm'),
  join(vendorDir, 'ffmpeg'),
  runtimeOnly,
)
await cp(
  join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm'),
  join(vendorDir, 'ffmpeg-core'),
  runtimeOnly,
)

console.log('vendor synced:', vendorDir)
