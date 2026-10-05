/**
 * 极简 MP4 解析：只为了拿时长。
 *
 * 用途：抖音这类 MSE 播放器会为同一条视频请求多个清晰度档位（起播低档、随后升档），
 * 抓下来就是两个内容相同、体积不同的文件。时长相同即同一段内容 —— 据此只留体积最大的那档。
 * 解析失败返回 0，调用方就当"无法判断"，不做去重（宁可多留，不可误删）。
 */

function boxes(buf, start, end) {
  const out = [];
  let off = start;
  while (off + 8 <= end) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (size < 8) break;
    out.push({ type, start: off, size });
    off += size;
  }
  return out;
}

/** @returns {number} 秒；拿不到返回 0 */
export function mp4DurationSeconds(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 32) return 0;
    let seconds = 0;
    const walk = (start, end, depth) => {
      if (depth > 5 || seconds) return;
      for (const box of boxes(buffer, start, end)) {
        if (box.type === 'mvhd') {
          const p = box.start + 8;
          const version = buffer.readUInt8(p);
          const timescale = version === 1 ? buffer.readUInt32BE(p + 20) : buffer.readUInt32BE(p + 12);
          const duration = version === 1 ? Number(buffer.readBigUInt64BE(p + 24)) : buffer.readUInt32BE(p + 16);
          if (timescale) seconds = duration / timescale;
          return;
        }
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.type)) {
          walk(box.start + 8, box.start + box.size, depth + 1);
        }
      }
    };
    walk(0, buffer.length, 0);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch {
    return 0;
  }
}

/** 常见视频编码的四字符码 → 归一化名字 */
const CODEC_NAMES = {
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'h265',
  hev1: 'h265',
  av01: 'av1',
  vp09: 'vp9',
  mp4v: 'mpeg4',
};

/**
 * 读出视频轨的编码。
 *
 * 为什么需要：小红书同一个笔记会同时给 H.265 和 H.264 两套（H.265 那档往往分辨率更高），
 * 而 H.265 在 Windows 自带播放器 / 很多设备上解不了 —— 播出来就只有声音。
 * 所以选档位时要先知道哪个是 H.264。
 *
 * @returns {string} 'h264' | 'h265' | 'av1' | ... ；读不出来返回 ''
 */
export function mp4VideoCodec(buffer) {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 64) return '';
    let found = '';
    const walk = (start, end, depth, inVideoTrack) => {
      if (depth > 7 || found) return;
      for (const box of boxes(buffer, start, end)) {
        if (box.type === 'trak' || box.type === 'mdia' || box.type === 'minf' || box.type === 'stbl' || box.type === 'moov') {
          walk(box.start + 8, box.start + box.size, depth + 1, inVideoTrack);
        } else if (box.type === 'hdlr') {
          // hdlr: version/flags(4) pre_defined(4) handler_type(4)
          const handler = buffer.toString('ascii', box.start + 16, box.start + 20);
          walk(box.start + box.size, box.start + box.size, depth, handler === 'vide');
        } else if (box.type === 'stsd' && inVideoTrack) {
          // stsd: version/flags(4) entry_count(4) 然后是第一项 sample entry（size(4)+format(4)）
          const entry = box.start + 16;
          if (entry + 8 <= box.start + box.size) {
            const fourcc = buffer.toString('ascii', entry + 4, entry + 8).toLowerCase();
            found = CODEC_NAMES[fourcc] || fourcc;
          }
        }
      }
    };
    // 先按"标准路径"找 vide 轨的 stsd，找不到再兜底扫第一个 stsd
    walk(0, buffer.length, 0, false);
    if (found) return found;
    const anyStsd = (start, end, depth) => {
      if (depth > 7 || found) return;
      for (const box of boxes(buffer, start, end)) {
        if (box.type === 'stsd') {
          const entry = box.start + 16;
          const fourcc = buffer.toString('ascii', entry + 4, entry + 8).toLowerCase();
          found = CODEC_NAMES[fourcc] || fourcc;
          return;
        }
        if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(box.type)) anyStsd(box.start + 8, box.start + box.size, depth + 1);
      }
    };
    anyStsd(0, buffer.length, 0);
    return found || '';
  } catch {
    return '';
  }
}
