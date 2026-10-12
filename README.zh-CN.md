# motion-use

[English](README.md) | 中文

让 coding agent 当导演：先规划镜头里的动作，再写按时间精确计算的动画，在本地渲染，最后检查交付的 MP4。支持中英文，横版、竖版和方形，字体和素材都在本地。需要快速出讲解视频时，场景模板仍然可用。

下面这支推广片就是用 motion-use 自己导演和渲染的：60 秒、60fps，中文旁白和烧录字幕。画面里都是真东西：用 motion-use 做的片子、其中一支的源码，还有 `verify`、`still --guides`、`voiceover check` 的真实输出。[源码和导演记录](examples/motion-use-film/)。之前那支 three.js 推广片在 [examples/motion-use-promo](examples/motion-use-promo/)。

https://github.com/user-attachments/assets/0ee1c904-c84a-43a9-911a-9ce935102642

导演模式示例：[OCS：一条消息跨过间隔](examples/ocs-film/film.json)，附[绘制代码](examples/ocs-film/composition/draw.js)和[导演记录](examples/ocs-film/DIRECTOR.md)。

**案例：毛线接力（three.js）**。六只毛毡小怪物接力推一个白毛线球，放下的线织成 OpenAI 的标志，再膨胀成毛绒管、立起来；熄灯后六色光沿线跑、合成白光，最后闪光灯合影。40 秒、60fps，配乐和音效都用代码合成。[源码和导演记录](examples/openai-yarn-film/)。非官方作品，与 OpenAI 无关联。

https://github.com/user-attachments/assets/5bf4053f-9243-48cc-b8f2-ecd2dccc7e79

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/motion-use/main/install.sh | sh
motion-use doctor
```

motion-use 属于 [*-use 工具族](https://github.com/leeguooooo/plugins)：给 AI agent 一双手的工具。随附的 skill 教 agent 把“给 X 做个发布视频”变成镜头计划、关键帧和成片 MP4。

## 导演模式（默认）

```bash
motion-use init my-film --name my-product --lang zh,en --format landscape,vertical \
  --subject "纸船记账 App" --purpose "App Store 预览视频" --tone "安静、利落" --length 30
motion-use reference https://prompt-motion.com/<作品页> my-film  # 研究别人发布的作品：署名、提示词、拆解
# 在 DIRECTOR.md、film.json 和 composition/draw.js 里导演这部片子
motion-use validate my-film
motion-use voiceover my-film                 # 按镜头生成旁白，有缓存
motion-use still my-film --allow-code
motion-use render my-film --allow-code --quality high --json
motion-use render my-film --allow-code --release  # 平台用的高画质母版和清单，在 out/release/
motion-use breakdown 参考.mp4                # 拆参考片：切点、节拍网格、运动热力图
motion-use beats 歌曲.wav                    # 卡歌曲节拍：速度、第一个强拍、高潮
```

**代码短，片子不雷同。** 绘图工具包把一支片子的绘图代码压到几 KB：脉冲运镜、从 `film.json` 读数字的图表和计数器、标注、逐词动态文字、砸入印章、手写、演示用的光标和聚光，素材视频上叠图形（`videos`，渲染前抽帧），以及按旁白时间自动生成的字幕。起手模板画面不变，代码从 7,008 字节降到 3,053 字节。三个示例三种画风：[数据故事](examples/data-story/)、[白板](examples/whiteboard/)、[动态文字](examples/kinetic/)。迭代成本低：`still --shot <id>` 只看一个镜头，`render --from 3 --to 7` 渲一段无声草稿；构图和起手模板太像的片子会被标出来，提醒重新设计而不是换皮。一页指南：[references/kit.md](references/kit.md)。

**导演，不是堆幻灯片。** `film.json` 先用 `look` 锁定全片画风：一句话的风格、一套色板、角色怎么处理。每个镜头写清画面里的物、它自己在做什么、镜头怎么动。校验会标出幻灯片式的写法：“出现、展示、淡入”这类动词，开头和结尾都是字卡，连续三镜同一个运镜，整片没有一次快动作，以及蓝紫色板。绘图工具包给 `draw.js` 提供脉冲运镜（停住 → 0.28 秒快推 / 0.30 秒横移 / 0.17 秒砸入 → 停住），还有缓动和弹簧、12 fps 步进、手绘线、白板手写、色板和纸张纹理。渲染后，交付检查在成片上测运动：读起来像翻页 PPT、片中出现空画面、大面积蓝紫的影片不予交付，除非写明理由。方法参考了 [huashu-art-motion](https://github.com/alchaincyf/huashu-art-motion)（MIT），详见 [references/directing.md](references/directing.md)，八种解说画风见 [references/grammars.md](references/grammars.md)。

镜头编排由 agent 写，CLI 不会把每段文字自动变成一个场景。每个镜头都有目的和看得见的动作。画面是时间的纯函数，所以同一个物体可以跨镜头延续，镜头可以跟着它走，动作可以对齐音乐的节拍网格。默认必须有旁白：按镜头写好，再生成或导入语音。渲染时会自动生成缺失的旁白；语音缺失、超长或没有混进成片，渲染都会失败。只有刻意不要旁白的片子才用 `voiceover:false`。可选的子帧采样能加运动模糊。字体和指定的图片会预加载；本地浏览器打包文件可以准备更复杂的渲染器，比如上面毛线案例用的 three.js 场景。

起步模板是一份可改的绘制练习，不是做好的广告，请按题材换掉它的编排。[OCS 片子](examples/ocs-film/film.json)演示了另一种做法：大号的 agent 名字收缩成两个端点，一条消息穿过去，展开成唤醒的脉冲，再收成标志。它是示意流程，不是真实消息投递的录屏。

`--allow-code` 只用于你自己写的或信任的绘制代码。代码在渲染器里执行，静态检查不是安全沙箱。普通文字始终作为 JSON 数据处理。指定的文件逐个复制，所以 composition 目录里的密钥和无关文件不会进入构建。

每次渲染还会输出封面、从**交付的 MP4** 抽帧得到的联系表，以及一份技术报告：能否完整解码，实测时长、帧率、尺寸，有无音频，响度和峰值，每个镜头的 RMS，暗场和静止区间，以及运动指标。编码成功不等于审美通过：在人或 agent 看过之前，`visual_review` 一直是 pending。Canvas 上画的文字不在 DOM 布局检查的覆盖范围内。音频按 -14 LUFS / -1 dBTP 的工作目标做两遍归一化；`--no-normalize` 保留原始电平。

**眼睛看不出的问题，交给检查。** 渲染时会用 whisper 把每段旁白转成文字，和脚本逐句对照，标出读错的地方，比如把“AI”读成“A-A-I”、把“重试”读成“重视”（单独跑用 `voiceover check`）。它还会测量画面里每一段文字，超出画面或竖版安全区的、两段字叠在一起的（比如前一句还没淡出、下一句已经出现在同一位置）都会报出来，带上时间。字在屏幕上停留的时间不够读完（每个英文词 0.3 秒、每个汉字 0.15 秒，再加 0.5 秒），或者和背景的对比度低于 WCAG 标准，也会提醒；一秒内闪烁超过三次（WCAG 2.3.1）的片子过不了运动检查。每次渲染都会把当时的输入存成快照，配音改了以后也能用 `render --snapshot <id>` 原样重渲染。`render --release` 生成发各平台用的文件：x264 veryslow CRF 16 母版、需要时给 X 的 45 MB 以内版本、封面，再写一份带哈希的 `release-manifest.json`；上传前用 `verify --manifest` 确认手里的就是当前母版。

完整的绘制和音频约定见 [references/film.md](references/film.md)。已有的 MP4 可以用 `motion-use verify file.mp4 --json` 生成检查报告，不用重新渲染。

## 场景模板

```bash
motion-use init my-video --mode template --style promo        # 或 --style explainer
# 编辑 my-video/brief.json
motion-use validate my-video/brief.json      # 报错带 JSON 路径，打印时间线和缺字
motion-use still my-video/brief.json         # 每个场景一张 PNG，外加联系表
motion-use render my-video/brief.json        # my-video/out/<name>-<lang>-<format>.mp4
```

brief 是一组场景：`title`、`terminal`、`steps`、`diagram`、`features`、`image`、`video`（录屏）、`stat`、`compare`、`kinetic`、`code` 或 `cta`，每种有自己的布局和转场选项，文字按语言分别写：

```json
{
  "version": 1,
  "name": "my-tool",
  "style": "promo",
  "languages": ["zh", "en"],
  "formats": ["landscape", "vertical"],
  "voiceover": { "dir": "voiceover" },
  "scenes": [
    { "id": "hook", "type": "title", "title": { "zh": "验证码到底在哪个邮箱？", "en": "Which inbox has the code?" } },
    { "id": "demo", "type": "terminal", "lines": [{ "cmd": "mail-use code --since 10m" }] },
    { "id": "cta", "type": "cta", "title": "mail-use", "url": "github.com/leeguooooo/mail-use" }
  ]
}
```

完整结构见 [references/brief.md](references/brief.md)。示例在 [examples/](examples/)：`ocs` 和 `mail-use` 的宣传片，以及一个 `chrome-use` 讲解片。

## 你能得到什么

- **两种风格。** `promo`：深色、带光效，每个节拍有音效。`explainer`：浅色纸面、节奏平稳，步骤依次高亮，流程图的箭头逐条画出。`theme.accent` 设定品牌色。
- **旁白。** 把录音放进 `voiceover/<语言>/<场景 id>.mp3`，或者给每个场景写 `narration`，再运行 `motion-use voiceover`（Azure AI Speech，或作为预览的 edge-tts）。场景会自动拉长以容纳旁白，旁白之间不会重叠。没有旁白也能出片，只有配乐。
- **像样的封面。** 第 0 帧就是做好的第一个场景，播放器和信息流显示的是缩略图而不是黑帧；`render` 也会单独输出封面 PNG。
- **真实素材。** `video` 场景播放你自己的录屏（可剪切、加速）；`image` 场景展示截图或用 [image-use](https://github.com/leeguooooo/image-use) 生成的插图。两者都能高亮一个区域（其余部分压暗）并放大。
- **你的品牌。** 封面、片尾和（可选）每个场景上的 logo；带对比度检查的完整配色；你自己的字体，按每个视频用到的字裁剪，附带许可证。
- **竖版安全区。** 9:16 的文字会避开点赞分享那一列和底部文案区。
- **可复现，全本地。** 同一份 brief 渲染出同一个视频，逐位一致（软件渲染），录屏片段的帧可能有肉眼不可见的差异。动画是 CSS，由 [HyperFrames](https://github.com/heygen-com/hyperframes) 逐帧定位；字体随 motion-use 发布，并按每个视频用到的字裁剪；配乐按视频长度合成。渲染不从网络加载任何资源，引擎的统计上报已关闭（`HYPERFRAMES_NO_TELEMETRY`、`DO_NOT_TRACK`）。CLI 每天最多访问一次 GitHub 检查新版本，设置 `MOTION_USE_NO_UPDATE_CHECK=1` 可以关闭。
- **不信任的文字也安全。** brief 里的文字始终当作文字绘制，不当 HTML。模板不够用时可以写自定义 HTML 场景，但必须加 `--allow-custom-html` 才会渲染。motion-use 不会覆盖不是它写出的输出文件（`--force` 可以强制覆盖）。

## 环境要求

motion-use 是一个 Node.js 程序，不是单个原生二进制：渲染要驱动 Chrome 和 FFmpeg。

- Node.js 22 或更新（安装脚本会检查）
- FFmpeg（`brew install ffmpeg`、`apt install ffmpeg`）
- Chrome：用你已安装的 Chrome，或者 `motion-use doctor --install-browser`

在 macOS（Apple Silicon）上验证过。CI 在 macOS 和 Ubuntu 上跑测试和一次真实渲染。暂不支持 Windows。

安装脚本从 GitHub 下载发布包和它的 `.sha256`，校验后用随附的 lockfile 执行 `npm ci`，装到 `~/.local/share/motion-use`（依赖来自公开的 npm 仓库，不需要账号或 token）。可选项写在 [install.sh](install.sh) 开头。

## 命令

| 命令 | |
|---|---|
| `init [dir]` | 默认创建导演模式项目；`--mode template` 选择模板 brief：`--style`、`--name`、`--lang zh,en`、`--format landscape,vertical` |
| `validate [brief]` | 检查 brief、文件、旁白长度和字形覆盖；打印时间线 |
| `voiceover [brief]` | 按场景的 `narration` 生成语音：`--engine azure`（有授权）或 `edge`（预览）；`voiceover check` 把旁白转成文字，标出读错的地方 |
| `still [brief]` | 关键帧和联系表；`--at 1.5,4` 指定秒数，`--beats 4` 每小节一帧；`--onion 1.2-2` 把一段动作的若干帧叠成一张图，看间距判断缓动；绘制代码在帧之间留了状态时会警告 |
| `render [brief]` | 每种语言 × 画幅一个 MP4，外加封面 PNG；`--quality draft\|standard\|high`、`--target github` / `--max-size 9MB`；`--release` 出平台母版和清单，`--snapshot <id>` 原样重渲染之前的版本，`--gate` 旁白被标出、文字出画或叠字时失败 |
| `verify <mp4>` | 解码并测量交付的视频：检查帧、音频、运动指标；`--gate` 红灯时失败，`--loop` 检查循环接缝，`--manifest` 确认文件就是当前发布母版 |
| `breakdown <video>` | 拆解参考片：切点、节拍网格、联系表、转场条、运动热力图、色板、运动指标 |
| `reference <url>` | 把别人发布的作品存下来研究（[Prompt Motion](https://prompt-motion.com) 的作品页，或任何带 `VideoObject` 的页面）：作者和原帖、提示词或 skill、视频和拆解结果，放在不进 git 的 `references/<slug>/`。提示词归原作者，只能借鉴着自己写，不能照抄 |
| `beats <audio>` | 测一首歌：速度、第一个强拍、每小节响度、高潮；打印让片子从强拍开始的 `music` 配置 |
| `compare <a> <b>` | 两支片子同一时刻并排对比：`--times 1.5,4` |
| `doctor` | 检查 Node、FFmpeg、Chrome、引擎和字体 |
| `upgrade` | 更新 CLI 和它的 skill；`--check` 只检查不安装 |

所有命令都支持 `--json`。`still` 和 `render` 支持 `--lang`、`--format` 和 `--out`。

## 许可证

motion-use 使用 MIT 许可证。渲染引擎 HyperFrames 是 Apache-2.0。字体是 SIL OFL；音效是 CC0 或原创；引擎的一个依赖（`@img/sharp-libvips`）是 LGPL-3.0。所有文件和依赖都列在 [ASSETS.md](ASSETS.md)。motion-use 和 HyperFrames、Remotion 等工具的对比见 [docs/alternatives.md](docs/alternatives.md)。
