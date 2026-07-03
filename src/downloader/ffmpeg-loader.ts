// ffmpeg.wasm を public/vendor から実行時ロードするための最小ラッパ。
// Vite のバンドルグラフに載せず(CSP と worker バンドルの不確実性を避ける)、
// chrome.runtime.getURL() の実行時文字列で動的 import する。

// 使う API だけを型として固定する(@ffmpeg/ffmpeg の FFmpeg クラス相当)。
// 入力は writeFile(MEMFS へのフルコピー)ではなく WORKERFS mount(Blob の遅延読み)で
// 渡す。数 GB 級の動画でヒープ上のフルサイズコピーを増やさないため。
export interface FFmpegLike {
  on(event: 'log', cb: (e: { message: string }) => void): void
  load(config: {
    coreURL: string
    wasmURL: string
    classWorkerURL: string
  }): Promise<boolean>
  readFile(path: string): Promise<Uint8Array | string>
  deleteFile(path: string): Promise<boolean>
  createDir(path: string): Promise<boolean>
  listDir(path: string): Promise<{ name: string; isDir: boolean }[]>
  deleteDir(path: string): Promise<boolean>
  mount(
    fsType: 'WORKERFS',
    options: { blobs: { name: string; data: Blob }[] },
    mountPoint: string,
  ): Promise<boolean>
  unmount(mountPoint: string): Promise<boolean>
  exec(args: string[]): Promise<number>
}

interface FFmpegModule {
  FFmpeg: new () => FFmpegLike
}

// 実行時文字列を渡すことで Vite の静的解析(=バンドル)を回避する。
async function importVendor(path: string): Promise<FFmpegModule> {
  const url = chrome.runtime.getURL(path)
  return (await import(/* @vite-ignore */ url)) as FFmpegModule
}

export async function loadFFmpeg(
  onLog: (message: string) => void,
): Promise<FFmpegLike> {
  const { FFmpeg } = await importVendor('/vendor/ffmpeg/index.js')
  const ffmpeg = new FFmpeg()
  ffmpeg.on('log', ({ message }) => onLog(message))
  await ffmpeg.load({
    coreURL: chrome.runtime.getURL('/vendor/ffmpeg-core/ffmpeg-core.js'),
    wasmURL: chrome.runtime.getURL('/vendor/ffmpeg-core/ffmpeg-core.wasm'),
    classWorkerURL: chrome.runtime.getURL('/vendor/ffmpeg/worker.js'),
  })
  return ffmpeg
}
