/**
 * 抖音（含图文作品与视频作品）。
 *
 * 页面特征：HTML 里没有 <img>/<video> 的真实地址，播放器靠 tt-videoid + 签名接口换流。
 * 地址在页面数据里，几种常见位置：
 *   <script>window._ROUTER_DATA = {"loaderData":{"video_(id)/page":{"videoInfoRes":{"item_list":[{...}]}}}}</script>
 *   <script id="RENDER_DATA" type="application/json">%7B...%7D</script>
 *   <script>window.__INITIAL_STATE__ = {...}</script>
 *
 * 字段（随版本变化，适配层按字段名模式识别，见 index.js）：
 *   视频：video.play_addr.url_list[]（多域名 + 多码率）、video.cover.url_list[]
 *   图文：images[].url_list[]
 *   文案：desc        作者：author.nickname
 *
 * 注意：分享短链 v.douyin.com/xxx 会 302 到 www.douyin.com/video/<id>，
 * 用 browser 引擎抓取时会自动跟到最终页，适配层用的是最终 URL。
 */
export const douyinSite = {
  id: 'douyin',
  label: '抖音',
  hosts: ['douyin.com', 'iesdouyin.com'],
  /** 按优先级尝试的页面数据位置 */
  stateHints: [
    { label: '_ROUTER_DATA', keys: ['_ROUTER_DATA', '__ROUTER_DATA__', '_router_data'] },
    { label: 'RENDER_DATA', ids: ['RENDER_DATA', '__RENDER_DATA__'] },
    { label: '__INITIAL_STATE__', keys: ['__INITIAL_STATE__'] },
  ],
};
