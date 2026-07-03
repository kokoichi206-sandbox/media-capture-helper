// ビルド済み拡張(.output/chrome-mv3)を読み込んだ Chromium を起動し、
// テスト動画のダウンロードを E2E で検証する。
// 使い方: pnpm e2e [動画URL]  (npm script が先に wxt build を実行する)
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const extensionPath = join(root, '.output', 'chrome-mv3')
const profileDir = join(root, 'tests', '.profile')
const downloadsDir = join(root, 'tests', 'downloads')

const videoUrl =
  process.argv[2] ??
  'https://www.bilibili.com/video/BV1TajH6UE54/?spm_id_from=333.788.videopod.sections&vd_source=f490d0f8560510bf42888a1706e2e61b'

await rm(profileDir, { recursive: true, force: true })
await rm(downloadsDir, { recursive: true, force: true })
await mkdir(downloadsDir, { recursive: true })

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
})

try {
  let [serviceWorker] = context.serviceWorkers()
  serviceWorker ??= await context.waitForEvent('serviceworker', {
    timeout: 15000,
  })
  const extensionId = new URL(serviceWorker.url()).host
  console.log('extension id:', extensionId)

  const videoPage = await context.newPage()
  await videoPage.goto(videoUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  })
  // content script は document_idle で注入されるため少し待つ。
  await videoPage.waitForTimeout(5000)

  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.waitForSelector('#video-info:not([hidden])', { timeout: 30000 })

  const title = (await popup.textContent('#video-title')).trim()
  const qualities = await popup.$$eval('#quality-select option', (options) =>
    options.map((o) => o.textContent),
  )
  const loginHintShown = await popup.$eval('#login-hint', (el) => !el.hidden)
  console.log('title:', title)
  console.log('selectable qualities:', qualities)
  console.log('login hint shown:', loginHintShown)

  const [downloaderPage] = await Promise.all([
    context.waitForEvent('page', { timeout: 15000 }),
    popup.click('#download-button'),
  ])
  await downloaderPage.waitForSelector(
    '#status[data-state="done"], #status[data-state="error"]',
    { timeout: 300000 },
  )
  const state = await downloaderPage.$eval('#status', (el) => el.dataset.state)
  const statusText = (await downloaderPage.textContent('#status')).trim()
  console.log('downloader status:', state, '-', statusText)
  if (state !== 'done') {
    const logText = await downloaderPage.textContent('#log')
    console.error('--- downloader log ---\n' + logText)
    process.exit(1)
  }

  // Playwright はダウンロードを一時ディレクトリへ逃がすため、chrome.downloads
  // から実パスを取得し、コンテキストを閉じる前に回収する。
  const [item] = await downloaderPage.evaluate(() =>
    chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }),
  )
  if (!item || item.state !== 'complete') {
    console.error('ダウンロード項目が見つかりません:', item)
    process.exit(1)
  }
  const outputPath = join(downloadsDir, basename(item.filename))
  await copyFile(item.filename, outputPath)
  console.log('downloaded file:', outputPath)

  const probe = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size:stream=codec_type,codec_name,width,height',
    '-of',
    'json',
    outputPath,
  ]).toString()
  console.log('--- ffprobe ---\n' + probe)
  console.log('E2E OK')
} finally {
  await context.close()
}
