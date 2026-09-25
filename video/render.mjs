// Renders explainer.html to an MP4, frame by frame, with headless Chrome + ffmpeg.
//   node render.mjs video [out.mp4]      full video (default ../get-paid-explainer.mp4)
//   node render.mjs stills 9.5 25 40     JPEG stills at those seconds, for checking a scene
import puppeteer from 'puppeteer-core';
import QRCode from 'qrcode';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const SITE_URL = 'https://get-paid.xyz';
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(p => p && existsSync(p));
if (!CHROME) throw new Error('Chrome not found; set CHROME_PATH');

const [mode = 'video', ...rest] = process.argv.slice(2);

writeFileSync(path.join(here, 'qr.svg'), await QRCode.toString(SITE_URL, {
  type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#0b0b0b', light: '#ffffff' },
}));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  args: ['--hide-scrollbars', '--font-render-hinting=none', '--force-color-profile=srgb', '--allow-file-access-from-files'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(pathToFileURL(path.join(here, 'explainer.html')).href + '?render', { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
const duration = await page.evaluate(() => window.DURATION);

if (mode === 'stills') {
  for (const t of rest.map(Number)) {
    await page.evaluate(t => render(t), t);
    const file = path.join(here, `still_${String(t).replace('.', '_')}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 85 });
    console.log(file);
  }
} else {
  const out = path.resolve(rest[0] ?? path.join(here, '..', 'get-paid-explainer.mp4'));
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(duration * FPS);
  for (let i = 0; i < total; i++) {
    await page.evaluate(t => render(t), i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 95, optimizeForSpeed: true });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`frame ${i}/${total}`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  console.log(out);
}
await browser.close();
