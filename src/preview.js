/**
 * 预览：把渲染后的正文包成一个可直接在浏览器打开的 HTML。
 *
 * 微信正文宽度约 375px 的移动视口，这里用手机外框模拟，方便人眼检查排版。
 * 纯本地文件，不联网。
 */

export function wrapPreview({ title, author, digest, html, coverUrl, themeName, dir }) {
  const escape = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escape(title)} · 预览</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 16px 64px; background: #ededed;
         font-family: -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif; }
  .stage { max-width: 420px; margin: 0 auto; }
  .meta { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; color: #666; font-size: 12px; }
  .meta .pill { background: #fff; border-radius: 10px; padding: 2px 8px; color: #07c160; }
  .phone { background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 6px 24px rgba(0,0,0,.09); }
  .cover { width: 100%; display: block; }
  .body { padding: 20px 18px 28px; }
  .title { font-size: 22px; line-height: 1.42; color: #1a1a1a; font-weight: bold; margin: 0 0 10px; }
  .byline { font-size: 13px; color: #999; margin: 0 0 18px; }
  .digest { background: #f7f7f7; border-radius: 6px; padding: 10px 12px; font-size: 13px;
            color: #666; line-height: 1.6; margin: 0 0 20px; }
  .article img { max-width: 100%; }
  .hint { max-width: 420px; margin: 16px auto 0; font-size: 12px; color: #999; text-align: center; }
</style>
</head>
<body>
<div class="stage">
  <div class="meta">
    <span class="pill">本地预览</span>
    <span>主题 ${escape(themeName || 'default')}</span>
    ${dir ? `<span>${escape(dir)}</span>` : ''}
  </div>
  <div class="phone">
    ${coverUrl ? `<img class="cover" src="${escape(coverUrl)}" alt="封面">` : ''}
    <div class="body">
      <div class="title">${escape(title)}</div>
      ${author ? `<div class="byline">${escape(author)}</div>` : ''}
      ${digest ? `<div class="digest">${escape(digest)}</div>` : ''}
      <div class="article">${html}</div>
    </div>
  </div>
  <div class="hint">这是本地模拟排版，最终效果以微信客户端为准（图片域名会被微信改写）。</div>
</div>
</body>
</html>`
}

/** 把文章里的本地图片路径换成 file:// 绝对路径，浏览器才能显示。 */
export function toFileUrl(filePath, pathModule) {
  const normalized = String(filePath).replace(/\\/g, '/')
  const prefix = normalized.match(/^[A-Za-z]:/) ? 'file:///' : 'file://'
  return `${prefix}${normalized.split('/').map(encodeURIComponent).join('/')}`
}
