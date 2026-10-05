/**
 * 文章标题的挑选规则（独立成模块是为了能直接单测）。
 *
 * 背景：小红书/抖音这类站点在「需要登录」时，页面 <title> 是站点自己的占位标题
 * （实测：「小红书 - 你的生活兴趣社区」），而站点适配器或自建解析器手里往往
 * 攥着真正的作品标题。直接信页面标题就会把作品存成「小红书 - 你的生活兴趣社区」。
 */

/** 明显是「站点名 / 登录页 / 风控页 / 验证页」的占位标题 */
const PLACEHOLDER_TITLE_RE =
  /(登录|注册|安全验证|安全限制|访问受限|访问频繁|访问异常|操作频繁|系统繁忙|网络异常|验证码|请稍候|请完成验证|页面不存在|加载中|首页|你的生活兴趣社区|小红书\s*[-–—]|抖音\s*[-–—]|快手\s*[-–—])/;

/**
 * 整条就是站点名/英文样板文案的（必须**完全相等**才算，避免误伤真标题）。
 * "Just a moment…"/"Attention Required" 是 Cloudflare 之类的人机校验页。
 */
const BARE_PLACEHOLDER_RE =
  /^(小红书|抖音|快手|微博|知乎|哔哩哔哩|bilibili|loading|just a moment[.…]*|attention required[!.]*|access denied|forbidden|not found|error|untitled|home|index)$/i;

/** 短到不可能是真标题的拉丁字母标题（"Hi"、"OK"） */
const MIN_TITLE_CHARS = 4;

/** 中日韩文字：信息密度高，两个字就是正经标题（实测作品标题「龙湾」） */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export function isPlaceholderTitle(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (PLACEHOLDER_TITLE_RE.test(text)) return true;
  const compact = text.replace(/\s+/g, '');
  // 英文样板文案（Just a moment... / Attention Required!）里带空格，得保留单空格再比
  if (BARE_PLACEHOLDER_RE.test(compact) || BARE_PLACEHOLDER_RE.test(text.replace(/\s+/g, ' '))) return true;
  /**
   * 长度下限按文字种类区分：
   * 汉字/假名/谚文两个字就够（「龙湾」「周末」都是真标题，实测被 4 字下限误判成占位标题，
   * 结果标题掉成 www.xiaohongshu.com）；拉丁字母仍要求 4 个字符，挡掉 "Hi"/"OK" 这类噪声。
   */
  return compact.length < (CJK_RE.test(compact) ? 2 : MIN_TITLE_CHARS);
}

/**
 * 从若干候选里挑标题：优先第一个「不像占位标题」的，全都像占位标题时退回第一个非空值。
 * @param  {...string} candidates 按优先级排列的候选（页面标题、站点/解析器标题、兜底域名…）
 */
export function pickTitle(...candidates) {
  const list = candidates.map((t) => String(t || '').trim()).filter(Boolean);
  if (!list.length) return '';
  return list.find((t) => !isPlaceholderTitle(t)) || list[0];
}

/**
 * 这个地址是不是「登录页 / 跳转页」而不是真正的内容页。
 * 小红书未登录时分享短链会一路跳到 /login?redirectPath=…，
 * 把它当文章来源地址既难看又对不上原文。
 */
export function isLoginWallUrl(value) {
  return /\/login\b|redirectPath=/i.test(String(value || ''));
}