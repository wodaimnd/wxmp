# operation 全表（42 个）

`*` 必填；`a|b` 表示两个都接受的别名；不写就用默认值。
返回统一是 `{ ok, exitCode, data, text }`——`text` 已截断到 4000 字符，需要精确值时读 `data`。

## 配置与自检

| operation | params | `data` 里要看的字段 |
|---|---|---|
| `config_show` | — | `appid`、`secretMasked`、`source`、`configPath`、`tokenCached` |
| `config_set` | `appid*`、`secret*` | `appid`、`secretMasked`、`path` |
| `config_clear` | — | `cleared`（清凭据 + token 缓存，配错时回到干净状态） |
| `config_set_image_key` | `provider*`、`value*`、`custom?` | `provider`、`imageProviders`（`value: '-'` = 删除这一家的 key） |
| `config_set_image_provider` | `provider*`、`baseUrl*`、`model?` | `provider`、`baseUrl`、`imageProviders` |
| `image_providers` | — | `available`、`providers[]{providerId,model,baseUrl}`、`note` |
| `doctor` | — | 各项自检结论（凭据 / IP 白名单 / 主题字体 / 封面渲染 / 配图 key） |

**出图前先 `image_providers`。** 没配 key 时 `cover(imageGen)` 不会报错，而是**回落渐变**
并在 `data.background.note` 里写原因——不看这一步就会以为"AI 出图就这水平"。

## 文章：写稿链路

| operation | params | `data` 里要看的字段 |
|---|---|---|
| `article_new` | `title*`、`author?`、`theme?`、`cover?`、`force?` | `path`、`title`、`theme` |
| `article_import` | `url?`、`list?`（二选一） | `total`、`imported`、`failed`、`results[]{ok,url,file,title,chars}` |
| `article_brief` | `topic?`、`file?`、`form?`、`words?`、`audience?`、`angle?`、`preset?` | `topic`、`form`、`formLabel`、`words`、`markdown`、`preset{id,name,hasStyle}`（任务书内嵌该预设的风格节） |
| `article_outline` | `file?`、`form?` | 骨架 + 现有小标题的对应关系 |
| `article_titles` | `file?`、`titles?`、`brief?` | `current`、`material`、`candidates[]`、`brief`；给 `titles` 时返回 `scored[]` |
| `article_list` | — | `dir`、`articles[]{name,path,title,mediaId,updated,size}` |
| `article_show` | `file?` | `article`、`rendered`、`report`（含 `limits` 用量） |
| `article_check` | `file?` | `report{ok, issues[], warnings[], limits{}}` |
| `article_review` | `file?`、`minScore?`(`min_score`)、`preset?` | `review{score,grade,pass,breakdown,counts,findings,nextActions,metrics}`、`report`、`preset{id,name,source}` |
| `article_set_title` | `file*`、`title*` | `before`、`after`、`scored{score,issues}` |
| `article_set_author` | `file*`、`author?` | **`author` 传空串 = 清空作者名**（front matter 写成 `author:`） |
| `article_library` | `check?`、`guide?`、`audit?`、`usable?` | `total`、`untagged`、`usable[]`、`items[]` |
| `article_illustrate` | `file?`、`max?`、`apply?` | `suggestions[]{image,section,afterParagraph,reason,hits}`、`applied` |
| `article_preview` | `file?`、`out?`、`open?` | 本地 HTML 预览路径 |

- **`article_import` 是"已经在线的文章"的入口。** 同名文件不覆盖，自动加 `-2` / `-3`；
  批量时单篇失败不中断，`results` 里逐条给原因。`list` 是一行一个链接的文本文件，
  空行和 `#` 注释会被跳过。
- **`article_titles` 给两种东西**：机械候选（半成品起点，必须自己改）+ 结构化任务书
  （真正的好标题从这里生成）。`file` 与 `titles` 同时给时 **`file` 优先**。
- **`article_illustrate` 默认只建议。** 插图会改文章结构，`apply: true` 才真写盘；
  写盘失败报 `apply_failed`（exit 3），文件不动。
- 写命令（`set_title` / `set_author`）的 `file` **必填**，不会回落到「最近改过的那篇」。

## 预设

预设 = 打分标准 + 写作提示词。`style` 存的是风格文案（怎么写），`thresholds/weights` 存的是打分线（写完怎么量）。动笔前先 `article_preset_prompt` 拿提示词，写完再 `article_review` 量分。

| operation | params | `data` 里要看的字段 |
|---|---|---|
| `article_presets` | — | `root`、`current`、`presets[]`（带 style.md 的预设标有风格提示词） |
| `article_preset_show` | `id*` | `preset{thresholds,weights,style}`、`notes[]` |
| `article_preset_prompt` | `id?`（不传=当前预设） | `id`、`name`、`hasStyle`、`prompt`（完整写作提示词：风格正文+节奏参考） |
| `article_preset_use` | `id*` | `current`（写进 config，之后 review 默认用它） |
| `article_preset_export` | `id*`、`out?` | `id`、`out`、`bytes`；不给 `out` 时 JSON 在 `data.json` |
| `article_preset_import` | `file*`、`as?`、`force?` | `id`、`dir`、`preset`、`warnings[]` |
| `article_preset_remove` | `id*`、`allowBuiltin?` | `id`、`current`（内置预设受保护，要 `allowBuiltin: true`） |
| `article_preset_reset` | — | `created[]`、`skipped[]`（只补缺失，不覆盖你改过的） |

## 封面与草稿

| operation | params | `data` 里要看的字段 |
|---|---|---|
| `cover` | `file?`、`subtitle?`、`badge?`、`theme?`、`out?`、`bg?`、`imageGen?`(`image_gen`)、`prompt?`、`width?`、`height?` | `path`、`method`、`bytes`、`coverRef`、`frontMatter{written,value}`、`coverSize{width,height}`、`background.note` |
| `draft_create` | `file?`、`dryRun?`、`thumbMediaId?` | `mediaId`、`path`、`assets{thumbMediaId,thumbFrom,images,cover,coverAuto}`、`payload` |
| `draft_list` | `offset?`、`count?`、`full?` | `total`、`items[]` |
| `draft_get` | `mediaId*`(`media_id`) | `mediaId`、`news` |
| `draft_update` | `file?`、`mediaId?`、`index?`、`dryRun?` | 更新后的草稿 |
| `draft_delete` | `mediaId*`(`media_id`) | `mediaId`、`deleted` |
| `draft_count` | — | `total` |

`cover` 的背景三档优先级：**`bg` > `imageGen` > 内置渐变**。尺寸默认 900×383（2.35:1），
`width` / `height` 可改；`prompt` 写什么就提交什么，不追加任何约束。

## 发布

| operation | params | `data` 里要看的字段 |
|---|---|---|
| `publish_submit` | `file?`、`mediaId?`(`media_id`)、`yes?` | `dryRun`（没给 yes）或 `publishId`、`msgDataId` |
| `publish_status` | `publishId*`(`publish_id`) | 接口原始返回 + `statusLabel` |
| `publish_wait` | `publishId*`、`timeoutMs?`、`intervalMs?` | 终态 + `statusLabel`；超时返回 `data.last` |
| `publish_list` | `offset?`、`count?` | `total`、`items[]{articleId,title,url,updateTime,deleted}` |
| `publish_delete` | `articleId*`(`article_id`)、`yes?`、`index?` | `dryRun` 或 `articleId`、`deleted` |

**`publish_wait` 会撞工具超时。** CLI 默认等 120000ms，插件子进程 `timeoutMs` 也是 120000
—— 两者同时到点，会拿到 `exitCode: 124` 而不是发布结果。要等就显式传小一点的
`timeoutMs`（如 60000），再用 `publish_status` 续查。

## 参数层的四条通用规则

1. **布尔位只认真值 `true`。** `pushFlag` 对 `undefined` / `null` / `false` 一律跳过——
   传 `false` 等于没传；传字符串 `"true"` 会被 CLI 解析成字符串而同样失效。
   `yes`、`force`、`imageGen`、`dryRun`、`apply`、`usable`、`audit`、`guide`、`brief`、
   `allowBuiltin`、`custom` 都是这个语义，想开启必须写布尔 `true`。
2. **`file` 建议每次显式给。** 写命令不会回落到「最近改过的那篇」，省得改错文件。
3. `baseUrl` 除 `config_set_image_provider` 外所有 operation 都接受——指向自建/沙箱网关时用，
   默认走 `api.weixin.qq.com`。那一个的 `baseUrl` 是**供应商接入地址**，不是网关。
4. **`--value -` 是删除语义**（`config_set_image_key` 里用它移除某一家的 key）。
   `-` 不被当成 flag，所以能安全地当值传。

## 工具层自己会报的错

| code | 触发 |
|---|---|
| `invalid_params` | 必填字符串没给、给了空串或非字符串 |
| `unknown_operation` | `operation` 不在上表的枚举里 |
| `cli_not_found` | 找不到 `bin/wxmp.js`——查插件配置 `cliPath` 或环境变量 `WXMP_CLI_JS` |
| `timeout` | 子进程超过插件配置的 `timeoutMs`（默认 120000），`exitCode: 124`。AI 出图 / 大批图片上传最容易撞 |
