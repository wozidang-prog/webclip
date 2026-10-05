/**
 * 小红书。
 *
 * 页面特征：正文（笔记内容）在 DOM 里通常有，但图片是懒加载的、视频是空壳播放器，
 * 真实地址只在页面数据里。几种常见位置：
 *   <script>window.__INITIAL_STATE__ = {"note":{"noteDetailMap":{"<noteId>":{"note":{...}}}}}</script>
 *   <script id="RENDER_DATA" type="application/json">%7B%22note%22...%7D</script>
 *   <script>window.__INITIAL_STATE__ = {...}</script>
 *
 * 字段（随版本变化，适配层按字段名模式识别，见 index.js）：
 *   图片：note.imageList[].urlDefault / urlPre / infoList[].url
 *   视频：note.video.media.stream.h264[].masterUrl（h265/av1 同理）
 *   封面：note.video.consumer.originVideoKey / imageList[0]
 *   标题：note.title   正文：note.desc   作者：note.user.nickname
 *
 * 分享短链 xhslink.com/xxx 会跳到 www.xiaohongshu.com/explore/<id>。
 *
 * 支持自建解析 API（如 https://github.com/JoeanAmier/XHS-Downloader）：
 * 配置 XIAOHONGSHU_API 环境变量后，优先调用自建 API 解析。
 * 自建 API 期望返回格式：
 * {
 *   "success": true,
 *   "data": {
 *     "title": "笔记标题",
 *     "desc": "笔记描述",
 *     "images": ["url1", "url2", ...],
 *     "video": {
 *       "url": "视频直链",
 *       "cover": "封面图 URL",
 *       "duration": 120,
 *       "width": 1080,
 *       "height": 1920
 *     }
 *   }
 * }
 */
export const xiaohongshuSite = {
  id: 'xiaohongshu',
  label: '小红书',
  hosts: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'],
  /** 按优先级尝试的页面数据位置 */
  stateHints: [
    { label: '__INITIAL_STATE__', keys: ['__INITIAL_STATE__'] },
    { label: 'RENDER_DATA', ids: ['RENDER_DATA', '__RENDER_DATA__'] },
    { label: '_ROUTER_DATA', keys: ['_ROUTER_DATA'] },
  ],
};