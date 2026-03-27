# Attachment Hub

Obsidian 全能附件管理插件：自动重命名、格式转换、路径同步，一个插件搞定所有附件需求。

## 功能

### 附件管理

- **粘贴/拖拽自动重命名**：支持自定义命名格式，变量包括 `${date}`、`${notename}`、`${originalname}`、`${md5}`
- **自定义存储位置**：跟随 Obsidian 设置 / Vault 根目录子文件夹 / 笔记同级目录
- **子路径模板**：支持 `${notename}`、`${notepath}`、`${parent}`、`${date}` 变量
- **扩展名覆盖**：针对不同文件类型设置不同的命名规则
- **单文件/文件夹覆盖**：为特定文件或文件夹自定义附件设置

### 图片处理

- **格式转换**：粘贴/拖拽时自动转换为 WEBP、JPEG 或 PNG
- **质量压缩**：可调节压缩质量（1-100）
- **尺寸调整**：按最大宽度/高度/长边/短边自动缩放
- **HEIC 支持**：自动解码 HEIC/HEIF 图片（静态图使用 heic2any，动态实况图走 FFmpeg）
- **EXIF 保留**：可选保留相机参数，GPS 位置信息独立开关

### 视频处理

- **FFmpeg 集成**：配置系统 FFmpeg 路径，支持 MP4、MOV、AVI、MKV、WEBM 转换
- **视频转动图**：转换为 Animated WEBP 或 GIF

### Frontmatter 路径同步

- **自动追踪**：指定 frontmatter 字段（如 `ogImage`），自动记录附件相对路径
- **路径格式**：支持纯路径、Markdown 链接 `![]()` 、Wikilink `![[]]` 三种格式
- **移动同步**：移动笔记时自动更新 frontmatter 和正文中的相对路径（支持 `.md` 和 `.mdx`）
- **附件重命名同步**：附件移动/重命名时同步更新所有引用
- **删除清理**：附件删除时自动清空对应的 frontmatter 字段
- **剪贴板粘贴**：通过命令将剪贴板图片直接粘贴到 frontmatter 字段

### 排除规则

- 按文件扩展名排除（正则匹配）
- 按文件夹路径排除（支持子路径）

## 安装

### 从源码构建

确保已安装 Node.js（>= v16）。

```bash
# 克隆仓库
git clone https://github.com/frevia/obsidian-attachment-hub.git
cd obsidian-attachment-hub

# 安装依赖
npm install

# 开发模式（监听文件变化，自动编译）
npm run dev

# 生产构建
npm run build
```

### 安装到 Obsidian

#### 方式一：符号链接（推荐开发时使用）

```bash
ln -s /path/to/obsidian-attachment-hub /path/to/vault/.obsidian/plugins/attachment-hub
```

#### 方式二：手动复制

将以下文件复制到 Vault 的 `.obsidian/plugins/attachment-hub/` 目录：

- `main.js`
- `manifest.json`
- `styles.css`

然后在 Obsidian 设置 → 第三方插件 中启用 **Attachment Hub**。

## 命令面板

| 命令 | 说明 |
| --- | --- |
| 扫描并修复所有 frontmatter 路径 | 全库扫描，修复 frontmatter 中的附件路径 |
| 粘贴剪贴板图片到 frontmatter | 将剪贴板中的图片保存并写入指定 frontmatter 字段 |
| 覆盖当前文件的附件设置 | 为当前文件设置独立的附件命名/存储规则 |
| 重置附件设置覆盖 | 移除当前文件的独立设置，恢复全局规则 |

## 项目结构

```text
src/
├── main.ts              # 插件主入口，事件处理和核心逻辑
├── settings.ts          # 设置接口、默认值、类型工具
├── settings-tab.ts      # 设置界面 UI
├── modals.ts            # 弹窗（字段选择、确认、覆盖设置）
├── utils.ts             # 工具函数（路径、MD5、变量替换、frontmatter 读写）
├── image-processor.ts   # 图片格式检测与 Canvas API 转换
├── heic-handler.ts      # HEIC/HEIF 静态图解码（heic2any）
├── tiff-handler.ts      # TIFF 解码（utif2，待集成）
├── ffmpeg-handler.ts    # FFmpeg 系统调用（视频/动态图转换）
└── types.d.ts           # 第三方模块类型声明
```

## 开发

```bash
# 开发模式（自动编译 + sourcemap）
npm run dev

# 生产构建（类型检查 + 压缩）
npm run build

# 代码检查
npm run lint
```

## 许可

MIT
