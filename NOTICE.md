# NOTICE · 二次创作与第三方素材归属

本项目 **dsh-whale-chat** 是 [**dsh-pet**](https://github.com/PC2005-cloud/dsh-pet) 的**二次创作（derivative work）**：
沿用了它的桌宠形象、动画素材与字体，并参考了它的浏览器 overlay 形态。本项目与 dsh-pet 官方无关，
不代表原作者立场；如果你喜欢这只鲸鱼，请先去给原项目点个 Star ⭐。

- 原项目：<https://github.com/PC2005-cloud/dsh-pet>
- 原项目许可：代码 MIT；素材（动画 / 提示词 / 源视频）**允许开源使用、禁止商用**
- 原项目许可说明：<https://github.com/PC2005-cloud/dsh-pet#-许可>
- 原项目素材目录：<https://github.com/PC2005-cloud/dsh-pet/tree/main/assets/webm>

## 一、从 dsh-pet 复用的素材

| 本仓库路径 | 原始路径 | 说明 |
|---|---|---|
| `assets/webm/*.webm`（35 段） | `dsh-pet/assets/webm/*.webm` | 640×360 VP9-alpha 动画，原样拷贝、文件名未改 |
| `assets/font/candy.ttf` | `dsh-pet/assets/fonts/上首软糖体.ttf` | 气泡与悬浮提示使用的「上首软糖体」 |
| `icon.png`、`assets/icon.png` | `dsh-pet/assets/logo.png` | 插件图标 / 兜底图 |
| 动画池划分（待机 / 点击回应 / 碎碎念 / 工作状态 / 随机小动作） | `dsh-pet/assets/config.jsonc` | 池子的选段思路参考，客户端选择逻辑为本项目重新实现 |

**素材版权归 dsh-pet 原作者（PC2005-cloud）所有。** 按原项目 README 的许可：

> 素材（动画/提示词/源视频）：允许开源使用，**禁止商用**

因此：

- 你可以自由地为本项目（或基于这些素材）做开源分发、修改与再创作；
- **不得**将这些素材或其衍生作品用于商业用途（售卖、付费产品、商业服务内置等）；
- 商用授权请直接联系原项目作者：<https://github.com/PC2005-cloud>。

如果原作者认为本项目的复用方式不妥，请在本仓库开 issue，我会调整或移除相关素材。

## 二、参考过思路的项目（代码均为重新实现）

| 项目 | 许可 | 参考内容 |
|---|---|---|
| [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) | MIT | 浏览器 `shell.overlay` 桌宠形态、`settings.section` 配置页、LLM 调用与提示词拼装方式 |
| [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) | MIT | 设置分区（settings.section）的信息架构与视觉风格、宿主 webServer 路由与信任栅栏写法、配置读写与定时调度的组织方式 |

## 三、DSH 平台

- 宿主侧使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `@deepseek-ai/dsh-llm`
  （`BlockAssembler` / `createUserMessage` / `createAssistantMessage` / `ReasoningEffortId`）完成模型调用；
- 客户端使用 DSH 的模块系统与 `slots` 槽位（`shell.overlay`、`settings.section`）。
- 本项目按 DSH 插件契约接入，**不修改 DSH 本体**。

## 四、代码许可

除非另有说明，本仓库**代码**（`lib/`、`test/`、`docs/` 等）以 [MIT](LICENSE) 发布，
版权归本仓库贡献者所有。素材不适用 MIT，见上表。
