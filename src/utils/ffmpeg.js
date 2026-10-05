/**
 * ffmpeg 集成：把 DASH 分离的音视频轨合回一个文件。
 *
 * 为什么需要：抖音的 /video/<id> 页面走 DASH，播放器分别请求
 *   …/media-video-avc1/…（纯视频轨）和 …/media-audio-und-mp4a/…（纯音频轨），
 * 直接落盘就成了"没声音的视频 + 一个音频文件"。ffmpeg 可用时用 -c copy 无损合流。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { logger } from './logger.js';

const log = logger.child({ mod: 'ffmpeg' });

let cached = null;

/** 找一个能用的 ffmpeg：配置 > PATH > Playwright 自带（可能不支持合流，会实测） */
async function candidates() {
  const list = [];
  if (config.media?.ffmpegPath) list.push(config.media.ffmpegPath);
  list.push('ffmpeg');
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  try {
    for (const entry of await fs.readdir(root)) {
      if (!entry.startsWith('ffmpeg')) continue;
      const dir = path.join(root, entry);
      for (const file of await fs.readdir(dir)) {
        if (/^ffmpeg(\.exe)?$/.test(file)) list.push(path.join(dir, file));
      }
    }
  } catch {
    /* 没有自带 ffmpeg 就算了 */
  }
  return list;
}

function run(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const done = (err, stdout, stderr) =>
      resolve({ ok: !err, code: err?.code ?? 0, error: err ? String(stderr || err.message).slice(-400) : '', stdout });
    try {
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, done);
    } catch (err) {
      // 受限沙箱（禁止管道 stdio）里 spawn 会**同步**抛 EPERM，这里当成"这个 ffmpeg 不可用"
      done(err, '', '');
    }
  });
}

/** 探测一次并缓存结果；返回可用的 ffmpeg 路径，找不到返回 '' */
export async function findFfmpeg() {
  if (cached !== null) return cached;
  for (const bin of await candidates()) {
    const res = await run(bin, ['-hide_banner', '-version'], { timeoutMs: 15000 });
    if (res.ok && /ffmpeg version/i.test(res.stdout)) {
      log.info('ffmpeg 可用', { bin });
      cached = bin;
      return cached;
    }
  }
  log.debug('未找到可用的 ffmpeg（DASH 分离音视频将无法合流）');
  cached = '';
  return cached;
}

/**
 * 把「纯视频轨 + 纯音频轨」无损合成一个 MP4。
 * @returns {Promise<Buffer|null>} 合成结果；失败返回 null（调用方退回分别保存）
 */
export async function muxTracks(videoBuffer, audioBuffer) {
  const bin = await findFfmpeg();
  if (!bin) return null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webclip-mux-'));
  const videoPath = path.join(dir, 'v.mp4');
  const audioPath = path.join(dir, 'a.mp4');
  const outPath = path.join(dir, 'out.mp4');
  try {
    await fs.writeFile(videoPath, videoBuffer);
    await fs.writeFile(audioPath, audioBuffer);
    const res = await run(bin, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      outPath,
    ]);
    if (!res.ok) {
      log.warn('音视频合流失败，改为分别保存', { err: res.error });
      return null;
    }
    const merged = await fs.readFile(outPath);
    if (!merged.length || merged.length < videoBuffer.length) {
      log.warn('合流结果异常，改为分别保存', { mergedBytes: merged.length, videoBytes: videoBuffer.length });
      return null;
    }
    log.info('DASH 音视频轨已合流', { videoBytes: videoBuffer.length, audioBytes: audioBuffer.length, mergedBytes: merged.length });
    return merged;
  } catch (err) {
    log.warn('音视频合流异常，改为分别保存', { err: err.message });
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
