import TurndownService from 'turndown';
import turndownPluginGfm from 'turndown-plugin-gfm';

const { gfm } = turndownPluginGfm;

const NEEDS_ANGLE = /[\s()<>]/;

/** Markdown 链接目标的安全包装 */
function mdUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  return NEEDS_ANGLE.test(value) ? `<${value.replace(/>/g, '%3E')}>` : value;
}

function escapeTitle(title) {
  return String(title).replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"').trim();
}

/** HTML 属性值转义（视频/音频标签用） */
function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * 视频 / 音频输出形式：
 *  - html（默认）：<video src="…" controls></video>，支持 HTML 的阅读器（Obsidian 阅读模式、
 *    Typora、VS Code 预览、多数静态站点）可以直接播放
 *  - link：退化成 `[▶ 视频](…)` 链接，适合不支持 HTML 的渲染器（例如 GitHub）
 *  - both：先给能播的标签，再附一行链接兜底
 */
function renderMediaTag({ isVideo, src, poster, style, label }) {
  const tag = isVideo ? 'video' : 'audio';
  if (!src) {
    // 只有封面没有地址：退回成图片
    return poster ? `\n\n![${isVideo ? '视频封面' : '音频封面'}](${mdUrl(poster)})\n\n` : '';
  }

  const html = () => {
    const attrs = [`src="${escapeAttr(src)}"`, 'controls', 'preload="metadata"'];
    if (poster) attrs.push(`poster="${escapeAttr(poster)}"`);
    return `<${tag} ${attrs.join(' ')}></${tag}>`;
  };

  if (style === 'link') {
    const parts = [];
    if (poster) parts.push(`![${isVideo ? '视频封面' : '音频封面'}](${mdUrl(poster)})`);
    parts.push(`[${label}](${mdUrl(src)})`);
    return `\n\n${parts.join('\n\n')}\n\n`;
  }

  if (style === 'both') {
    return `\n\n${html()}\n\n[${label}](${mdUrl(src)})\n\n`;
  }

  // html：没封面时不再单独插一张封面图，避免和播放器重复
  return `\n\n${html()}\n\n`;
}

export function createTurndown({ gfmTables = true, keepEmbeds = true, videoMarkdown = 'html' } = {}) {
  const mediaStyle = ['html', 'link', 'both'].includes(videoMarkdown) ? videoMarkdown : 'html';
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    br: '  \n',
    blankReplacement: (content, node) => (node.isBlock ? '\n\n' : ''),
  });

  if (gfmTables) td.use(gfm);

  // 图片：处理缺省属性、空格路径、懒加载残留
  td.addRule('wcImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const src = node.getAttribute('src') || node.getAttribute('data-src');
      if (!src) return '';
      const alt = (node.getAttribute('alt') || '').replace(/[\r\n]+/g, ' ').trim();
      const title = node.getAttribute('title');
      return `![${alt}](${mdUrl(src)}${title ? ` "${escapeTitle(title)}"` : ''})`;
    },
  });

  // 视频 / 音频
  td.addRule('wcMedia', {
    filter: ['video', 'audio'],
    replacement: (_content, node) => {
      const child = node.querySelector?.('source[src]');
      const src = node.getAttribute('src') || child?.getAttribute('src') || '';
      const poster = node.getAttribute('poster') || '';
      const isVideo = node.nodeName === 'VIDEO';
      return renderMediaTag({
        isVideo,
        src,
        poster,
        style: mediaStyle,
        label: isVideo ? '▶ 视频' : '♪ 音频',
      });
    },
  });

  // iframe 嵌入（只保留白名单里的，其余在清洗阶段已删除）
  td.addRule('wcIframe', {
    filter: 'iframe',
    replacement: (_content, node) => {
      if (!keepEmbeds) return '';
      const src = node.getAttribute('src');
      if (!src) return '';
      const title = node.getAttribute('title') || '嵌入内容';
      return `\n\n[▶ ${escapeTitle(title)}](${mdUrl(src)})\n\n`;
    },
  });

  // 代码块：保留语种，去掉行号容器带来的噪音
  td.addRule('wcCodeBlock', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const codeEl = node.querySelector?.('code') || node;
      const lang =
        node.getAttribute('data-lang') ||
        (codeEl.getAttribute?.('class') || '').match(/(?:language|lang)-([\w+#]+)/i)?.[1] ||
        '';
      let code = (codeEl.textContent || '').replace(/\u00a0/g, ' ');
      code = code.replace(/^\n+/, '').replace(/\s+$/, '');
      if (!code) return '';
      const fence = code.includes('```') ? '````' : '```';
      return `\n\n${fence}${lang}\n${code}\n${fence}\n\n`;
    },
  });

  // 图注
  td.addRule('wcFigcaption', {
    filter: 'figcaption',
    replacement: (content) => {
      const text = content.replace(/\s+/g, ' ').trim();
      return text ? `\n\n*${text}*\n\n` : '';
    },
  });

  td.keep(['sub', 'sup', 'mark', 'kbd', 'abbr', 'time', 'details', 'summary']);

  return td;
}

/** 生成 YAML frontmatter */
export function buildFrontmatter(fields = {}) {
  const yamlValue = (value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      if (!value.length) return null;
      return `\n${value.map((v) => `  - ${JSON.stringify(String(v))}`).join('\n')}`;
    }
    const s = String(value);
    return JSON.stringify(s);
  };

  const lines = [];
  for (const [key, value] of Object.entries(fields)) {
    const rendered = yamlValue(value);
    if (rendered === null) continue;
    lines.push(`${key}: ${rendered}`);
  }
  return lines.length ? `---\n${lines.join('\n')}\n---\n\n` : '';
}

/** 收敛 Markdown 的空白与常见冗余 */
export function cleanMarkdown(markdown) {
  let md = String(markdown || '');
  md = md.replace(/\r\n?/g, '\n');
  md = md.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  md = md.replace(/\u00a0/g, ' ');

  // 图片链接包着同一张图：[![alt](img)](img) → ![alt](img)
  md = md.replace(/\[!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\]\(\2(?:\s+"[^"]*")?\)/g, '![$1]($2)');

  // 空链接（注意排除图片语法 ![](...)，否则无 alt 的图片会被吃掉）
  md = md.replace(/(?<!!)\[\s*\]\([^)]*\)/g, '');

  // 只含空白/分隔符的行
  md = md.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, (m) => (m.trim().length >= 3 ? '---' : m));

  // Turndown 的列表缩进是 "-   "，收敛成 "- "（保留嵌套缩进）
  md = md.replace(/^(\s*)([-*+]) {2,3}(?=\S)/gm, '$1$2 ');
  md = md.replace(/^(\s*)(\d{1,9})\. {2,3}(?=\S)/gm, '$1$2. ');

  md = md.replace(/[ \t]+$/gm, '');
  md = md.replace(/[ \t]{2,}\n/g, '  \n');

  // 多余空行
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.replace(/^\s+/, '').replace(/\s+$/, '');

  return md ? `${md}\n` : '';
}

/**
 * 正文 HTML → Markdown。
 */
export function htmlToMarkdown(html, options = {}) {
  const { title = '', frontmatter = null, includeTitle = true, turndown } = options;  const td = turndown || createTurndown(options);
  let body = cleanMarkdown(td.turndown(html || ''));

  // 正文里常常也有一个 h1/h2 就是标题本身，前面已经输出过「# 标题」了，去掉重复的那行
  if (includeTitle && title) {
    const lines = body.split('\n');
    const firstIndex = lines.findIndex((line) => line.trim());
    if (firstIndex >= 0) {
      const match = lines[firstIndex].match(/^#{1,3}\s+(.*)$/);
      const heading = match ? match[1].replace(/[*_`]/g, '').replace(/\s+/g, '').trim() : '';
      const normalizedTitle = String(title).replace(/\s+/g, '');
      // 正文里的标题常常少了「 - 站点名」后缀，所以前缀相同也算重复
      const same =
        heading &&
        (heading === normalizedTitle ||
          (heading.length >= 8 && normalizedTitle.startsWith(heading)) ||
          (normalizedTitle.length >= 8 && heading.startsWith(normalizedTitle)));
      if (same) {
        lines.splice(firstIndex, 1);
        body = cleanMarkdown(lines.join('\n'));
      }
    }
  }

  const parts = [];
  if (frontmatter) parts.push(buildFrontmatter(frontmatter).trimEnd());
  if (includeTitle && title) parts.push(`# ${title}`);
  if (body) parts.push(body);
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}
