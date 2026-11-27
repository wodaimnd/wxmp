/** 帮助文案里与文章模板相关的说明（单独放，避免 commands.js 过长）。 */
export const ARTICLE_TEMPLATE_HELP = `
文章文件格式（Markdown + front matter）:

  ---
  title: 标题（必填，≤32 字）
  author: 作者（≤16 字）
  digest: 摘要（≤120 字，不填自动截取）
  cover: ./cover.png       封面（本地路径或 https URL；空着时 cover 命令会自动写回这一行）
  sourceUrl: 阅读原文链接
  theme: default           排版主题
  comments: false          是否开启评论
  ---

  正文用 Markdown：标题、列表、引用、表格、代码块、图片都能转成微信内联样式。
  正文图片必须 <1MB 且是 jpg/png；封面会走永久素材，正文图走 uploadimg。

  封面：wxmp cover 默认生成 <文章名>-cover.png（每篇独立，不会互相覆盖）并自动写回
  front matter 的 cover 字段。建草稿时必须带封面，否则微信会回 40007 invalid media_id；
  工具会在本地先拦下并提示先跑 cover，不会让你拿到那条看不懂的错误。

发布链路:
  article new → 写正文 → article check → cover → draft create → publish submit --yes → publish wait

发布权限:
  freepublish 接口只对认证服务号开放。个人/未认证订阅号跑到 publish submit 会得到
  48001 api unauthorized——这不是工具坏了，草稿已经在草稿箱里，去
  https://mp.weixin.qq.com 的「草稿箱」手动群发即可。
`
