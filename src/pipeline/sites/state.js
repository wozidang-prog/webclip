/**
 * 页面内嵌 JSON 的宽容解析。
 *
 * 抖音 / 小红书这类站点不会把媒体地址写进 DOM，而是塞在页面 script 里：
 *   <script>window._ROUTER_DATA = {"loaderData":{...}}</script>            ← 抖音
 *   <script id="RENDER_DATA" type="application/json">%7B%22note%22%3A...</script>  ← 小红书（整体 URI 编码）
 *   <script>window.__INITIAL_STATE__ = {...}</script>                      ← 通用老写法
 *
 * 这些 JSON 常常不是严格合法的（undefined 字面量、尾逗号、被 HTML 实体转义、外面包一层函数），
 * 所以统一走"能 JSON.parse 就 parse，不行再退回括号配对 + 局部修正"的路子。
 * 这里是纯字符串处理，不依赖 DOM，方便单测。
 */

/** 把 script 里常见的非标准写法修成合法 JSON */
function sanitizeJson(body) {
  return String(body || '')
    .replace(/^\uFEFF/, '')
    // 抖音等站点会直接写 undefined（JSON 里没有这个字面量）
    .replace(/([:,[{]\s*)undefined(\s*[,\]}:])/g, '$1null$2')
    .replace(/([:,[{]\s*)undefined\s*$/gm, '$1null')
    /**
     * 小红书真实页面会把 JS 的 Map/Set 直接塞进 state（"noteDetailMap":new Map([])），
     * 这不是合法 JSON —— 不处理的话整个 __INITIAL_STATE__ 都解析不出来，
     * 站点适配器就永远不生效（媒体只能靠通用兜底逻辑捞，噪声和重复都躲不掉）。
     */
    .replace(/\bnew\s+Map\s*\(\s*\[[^\]]*\]\s*\)/g, '{}')
    .replace(/\bnew\s+Set\s*\(\s*\[[^\]]*\]\s*\)/g, '[]')
    .replace(/\bnew\s+(?:Map|WeakMap)\s*\([^)]*\)/g, '{}')
    .replace(/\bnew\s+(?:Set|WeakSet)\s*\([^)]*\)/g, '[]')
    // NaN / Infinity 同样不是 JSON 字面量
    .replace(/([:,[{]\s*)(?:NaN|Infinity|-Infinity)(\s*[,\]}:])/g, '$1null$2')
    // 尾逗号
    .replace(/,(\s*[}\]])/g, '$1')
    // 单引号包裹的键（少见但真实存在）
    .replace(/([{,]\s*)'([^'\\\n]+)'(\s*:)/g, '$1"$2"$3');
}

const ENTITIES = [
  [/&quot;/g, '"'],
  [/&#34;/g, '"'],
  [/&#39;/g, "'"],
  [/&apos;/g, "'"],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&amp;/g, '&'],
  [/\\x22/g, '"'],
  [/\\x27/g, "'"],
];

function unescapeEntities(text) {
  let out = text;
  for (const [re, to] of ENTITIES) out = out.replace(re, to);
  return out;
}

/** 从任意位置起做括号配对，取出一个完整的 {...}（会跳过字符串里的括号） */
export function extractBalancedJson(text, from = 0) {
  const source = String(text || '');
  const open = source.indexOf('{', Math.max(0, from));
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * 解析一段 script 内容里的 JSON。
 * 依次尝试：原样 → URI 解码（RENDER_DATA 那种）→ 反转义 HTML 实体 → 截取最外层大括号。
 * @returns {any|null}
 */
export function decodeScriptJson(body) {
  const raw = String(body || '').trim();
  if (!raw) return null;

  const candidates = [raw];
  if (/%[0-9a-fA-F]{2}/.test(raw)) {
    try {
      candidates.push(decodeURIComponent(raw));
    } catch {
      /* 不是整体编码，忽略 */
    }
  }
  candidates.push(unescapeEntities(raw));

  for (const candidate of candidates) {
    const attempts = [candidate];
    const balanced = extractBalancedJson(candidate);
    if (balanced && balanced !== candidate) attempts.push(balanced);
    for (const attempt of attempts) {
      for (const variant of [attempt, sanitizeJson(attempt)]) {
        try {
          const parsed = JSON.parse(variant);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {
          /* 换下一个变体 */
        }
      }
    }
  }
  return null;
}

/** 按 id 取出 <script id="..."> 的内容，返回 { id, body } */
export function findScript(html, ids = []) {
  const text = String(html || '');
  if (!text) return null;
  for (const id of ids) {
    const re = new RegExp(`<script[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, 'i');
    const match = re.exec(text);
    if (match?.[1]?.trim()) return { id, body: match[1] };
  }
  return null;
}

/** 取出 `window.XXX = {...}` 这类挂在全局变量上的数据 */
export function parseWindowState(html, keys = []) {
  const text = String(html || '');
  if (!text) return null;
  for (const key of keys) {
    const needles = [
      `window.${key}`,
      `window["${key}"]`,
      `window['${key}']`,
      `self.${key}`,
      `var ${key}`,
      `${key} =`,
    ];
    for (const needle of needles) {
      const at = text.indexOf(needle);
      if (at < 0) continue;
      const chunk = extractBalancedJson(text, at + needle.length);
      if (!chunk) continue;
      const data = decodeScriptJson(chunk);
      if (data) return { data, source: needle };
    }
  }
  return null;
}

/**
 * 按优先级尝试所有已知的"页面数据"位置。
 * @param {string} html
 * @param {{ids?: string[], keys?: string[]}} hints
 * @returns {{data: any, source: string}|null}
 */
export function parsePageState(html, { ids = [], keys = [] } = {}) {
  const script = findScript(html, ids);
  if (script) {
    const data = decodeScriptJson(script.body);
    if (data) return { data, source: `script#${script.id}` };
  }
  return parseWindowState(html, keys);
}
