# npz 浏览器

**中文** | [English](README.en.md)

本地浏览、渲染、对比 `.npz` 的工具，面向图像实验产物：一个文件里通常有若干张 linear RGB、gainmap、mask、特征图和小矩阵，需要快速看图、跨版本比对、读原始像素。

- 后端 Python + FastAPI：扫目录、解 npz、把数组渲染成 PNG/WebP
- 前端 React + Vite + Tailwind：布局、缩略图、FastStone 式同步对比
- 单文件夹 20 万个 npz 也能用：目录索引三级缓存、列表服务端分页、缩略图懒加载并限流
- 界面 **中文 / English**，顶栏可切换；首次打开跟随浏览器语言

需求与设计决策见 [`docs/SPEC.md`](docs/SPEC.md)。对比面板拖动收起/展开与按钮状态如何对齐，见 [`docs/resizable-panel-visibility.md`](docs/resizable-panel-visibility.md)。

## 目录

- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [本机客户端](#本机客户端tauri)
- [远程后端](#远程后端把后端部署到服务器)
- [渲染规则](#渲染规则)
- [快捷键与对比](#快捷键与对比)
- [测试](#测试)
- [大目录](#大目录)
- [目录结构](#目录结构)

## 环境要求

- Python 3.11+（开发验证于 3.14）
- Node.js `^20.19.0 || >=22.12.0`（Vite 8 要求，已写进 `frontend/package.json` 的 `engines`；开发验证于 24）
- 桌面窗口（`npm run tauri:dev` / `tauri:build`）：Rust 1.85+，以及系统 WebView（Linux：`libwebkit2gtk-4.1-dev` `libgtk-3-dev`）

`typecheck` 直接调用 `node node_modules/typescript/lib/tsc.js` 而不是 `tsc`：typescript 7 的 `bin/tsc` 是没有扩展名的 ESM，稍旧的 Node 会报 `ERR_UNKNOWN_FILE_EXTENSION`。走带扩展名的 `lib/tsc.js` 在整个版本范围内都能用。

## 快速开始

浏览器开发（前端代理 `/api`，不涉及跨域）：

```bash
# 1. 后端依赖
python -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt      # Linux/macOS: .venv/bin/pip

# 2. 生成样例数据（顺便写进 roots.json）
.venv\Scripts\python scripts/make_sample_npz.py

# 3. 启动后端（默认 127.0.0.1:8756）
cd backend && ..\.venv\Scripts\python -m app.main

# 4. 另开终端启动前端（默认 127.0.0.1:5273）
cd frontend && npm install && npm run dev
```

打开 http://127.0.0.1:5273 。

### 配置可访问的目录（roots）

后端只允许访问 `roots.json` 里列出的目录及其子目录。路径穿越（`..`、符号链接指到外面）会返回 `PATH_OUTSIDE_ROOT`。

```json
{
  "roots": [
    { "id": "results", "name": "实验结果", "path": "D:/data/results" },
    { "id": "nas", "name": "NAS", "path": "/mnt/nas/exp" }
  ]
}
```

可在顶栏「管理 root」里增删，也可直接改文件——后端按 mtime 热加载。Windows 和 Linux 都用正斜杠写绝对路径。

### 服务器单进程（无本机 SSH 切换）

数据已经在这台机器上、别人用浏览器直接打开时，可以只跑 Python：

```bash
cd frontend && npm run build
cd ../backend && ..\.venv\Scripts\python -m app.main --static-dir ../frontend/dist
```

访问 http://127.0.0.1:8756 一个地址。没有 Node，也就没有 UI 里「连另一台机器」的能力。

### 常用启动参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--host` / `--port` | `127.0.0.1` / `8756` | 监听地址 |
| `--roots-file` | `./roots.json` | root 白名单文件 |
| `--cache-dir` | 系统缓存目录下的 `npz_view` | 渲染图与目录索引的磁盘缓存 |
| `--max-cache-gb` | `8` | 磁盘缓存上限，超出后按最近访问时间淘汰 |
| `--array-cache-mb` | `2048` | 已解码数组的内存 LRU 上限 |
| `--small-matrix-max` | `9` | 小于等于 N×N 的二维数组按数值表格显示 |
| `--allow-pickle` | 关闭 | 允许读取含 object 数组的 npz，**会执行文件里的 pickle**，仅用于可信数据 |
| `--static-dir` | 无 | 指定后托管前端构建产物 |

也可用 `NPZVIEW_` 前缀的环境变量，例如 `NPZVIEW_PORT=9000`。

## 本机客户端（Tauri）

浏览器不能 SSH。桌面窗口是 Tauri（系统 WebView），SSH 仍是本机 Node `ssh2` hub。

```bash
cd frontend && npm install
npm run tauri:dev
```

会起 Vite `:5273`，再打开原生窗口（顶部原生标签栏，每个标签一个 WebView）。顶栏「后端服务器」只切换**当前标签**的后端。

### Windows 便携 zip（解压即用）

64 位 Windows（需 Node、Rust、本机 WebView2）：

```bash
cd frontend && npm install
npm run pack:windows
```

产物是 `dist-portable/npz-view-0.1.1-windows-x64.zip`。解压到普通文件夹，双击 `npz-view.exe`。zip 里已带 Node、embeddable Python 和前端 dist，**不需要**再装 Node / Python，也**不要**放到 Program Files。打不开时看同目录 `npz-view-hub.log`。

源码直接打 exe（迭代用，仍要本机 Node / Python / 这份仓库）：

```bash
cd frontend && npm run build
npm run tauri:build
```

Windows x64 交叉编译（Linux 上）可用 `npm run tauri:build:windows`；那个 NSIS `setup.exe` 会装到 Program Files，便携布局对不上，请用上面的 zip。

发布版启动时会拉起 `scripts/npz-view.mjs`（便携版用自带 Python + hub；源码运行则用本机 Python + vite preview），并给 hub 一个**临时本机端口**（`NPZVIEW_UI_PORT`，不固定占用 5273）。关掉最后一个标签或退出窗口会停掉这层壳。

只要页面、不要窗口时：

```bash
node scripts/npz-view.mjs
```

未指定端口时同样自选空闲端口。

## 远程后端（把后端部署到服务器）

数据在服务器上时，后端跑在数据旁边、前端仍留在本机。顶栏「后端服务器」→「添加服务器」，填 SSH 用户名 / 主机 / SSH 端口、远端目录和后端端口，然后连接。远端目录默认 `~/.npz-viewer-backend`。

认证：

- **密码**：本次连接现场输入，只留内存，不写 `servers.json`
- **私钥文件**：填本机密钥路径，可选口令；路径可以记住，密钥内容和口令不落盘
- **ssh-agent**：沿用本机已有的免密环境

连接时会：SSH 登录 → 探测远端 `127.0.0.1:<后端端口>` 占用和 `/api/health` → **同用户已有健康后端则只建隧道、跳过部署** → 端口空闲才 SFTP 增量同步 `backend/app` 和 `requirements.txt` 并启动（`.venv` 里依赖已能导入则跳过 pip）。连接过程可在界面里中断。

**原始 npz 不过网**，只有渲染好的图和 JSON 回传。已连接的服务器之间点「使用」切换当前标签。断开隧道仅当没有任何标签仍指向该服务器。

远端端口冲突按占用者区分：

1. 空闲 → 部署并启动
2. 本 SSH 用户已有健康的本应用 → **复用**，只接隧道
3. 其他程序或其他用户占用 → 报错，请改后端端口；不会 kill 不认识的进程

要求：远端目录里要有 `.venv`（首次连接会尝试用系统 `python3 -m venv` 创建）。后端需要 Python 3.13+ 才能用视频导出。服务器列表存在本机 `servers.json`（已 gitignore）。

纯 Python `--static-dir` 单进程没有这层 Node，不能从 UI 发起 SSH。

## 渲染规则

数据类型判定和像素处理在后端完成，前端只显示返回的 8bit 图。

| 数组形态 | 判定 | 渲染方式 |
| --- | --- | --- |
| `[C,H,W]` / `[H,W,C]`，C=3 | `rgb` | linear RGB，clip 0–1，gamma 2.2 |
| C=4 | `rgba` | 同上，alpha **不做 gamma**，前端棋盘格衬底 |
| C=1 或二维 | `gray` | 保持线性；可选 min/max 归一化和伪彩色 |
| key 名含 `gainmap` | `gainmap` | clip 到 0–2 再除以 2，然后 gamma 2.2 |
| C 为其他值 | `stack` | 按通道逐张灰度 |
| 四维 `[B,...]` | 带 batch | 卡片上切换 batch 序号 |
| 一维、或不超过 9×9 的二维 | `table` | 直接列出数值 |

顶栏可在 BT.2020 和 P3 之间切换。选 P3 时先做 BT.2020 → Display P3 矩阵变换，再 clip、再 gamma。输出 PNG/WebP **不嵌入 ICC**，浏览器按 sRGB 解释，广色域屏上是近似效果。完整规则见 SPEC 第 4 节。

形如 `[3,4,3]` 两端都像通道轴时，默认按 HWC，卡片上会出现 CHW/HWC 切换。

## 快捷键与对比

| 按键 | 作用 |
| --- | --- |
| `←` / `→` | 上一个 / 下一个 npz（同文件夹，自然序） |
| `↑` / `↓` | 跳到相邻兄弟文件夹里**同序号**的 npz |
| `空格` | A/B 翻转（不是播放） |
| `P` | 文件内对比已选起止帧时，进入序列并播放/暂停 |
| `1`–`4` | 切到第 N 张对比图 |
| 按住 `X` | 覆盖模式下临时移开覆盖层 |
| `F` | 对比面板占满右侧 / 还原分栏 |
| `Ctrl+0` / `Ctrl+1` | 适应窗口 / 100% |
| `R` | 刷新当前目录（丢弃该目录的索引缓存） |
| `Esc` | 关闭对比面板；灯箱打开时先关灯箱 |
| `G` | 开关临时算子格 |

对比视图滚轮缩放（以光标为锚点）、拖拽平移，**所有分块共享视口**。超过 150% 切最近邻采样。

找细微差异有两种互斥模式：

- **A/B 翻转**：整面板只显示一张，空格轮流切换
- **覆盖**：FastStone Overlay (Right on Left)。默认按住 X 覆盖；点「覆盖」锁定。覆盖源可以是任意非基准格（含算子格），目的地始终是第 1 格

**等高**：尺寸不一致时（gainmap 常常半分辨率）把各图缩放到与第 1 格相同的显示高度，可与覆盖叠用。

**序列播放与导出**只在「文件内」对比：点胶片按钮进入序列后格子跟 playhead；点列表里另一个文件会退出。`P` 连续播，不跳帧（跟不上就降有效 fps），不循环。导出把当前宫格合成无音轨 H.264 MP4，写到服务器路径（可改 `save_dir`），不经过浏览器另存为。跨文件对比没有这条能力。

## 测试

```bash
.venv\Scripts\python -m pytest
cd frontend && npm run typecheck
cd frontend && npm run e2e
```

端到端需要后端在 8756 上跑着；Playwright 会自己拉起前端 dev server（已在跑就复用）。同步缩放/平移依赖 non-passive 原生 wheel 和 pointer capture，只能靠真实浏览器输入验证。

## 大目录

单文件夹 20 万个 npz 是设计目标：

- `os.scandir` 一次拿到名字和 stat
- 目录快照三级缓存：进程内 LRU → 磁盘列式 JSON → 重新扫描；用目录 mtime 判断是否失效
- 列表服务端分页，前端虚拟滚动
- 缩略图 IntersectionObserver 懒加载，全局最多 4 个并发
- 渲染结果按（mtime+size+全部渲染参数）哈希缓存，带 ETag

压测：`python scripts/make_sample_npz.py --stress 200000 --stress-only`。

## 目录结构

```
backend/app/
  api/          FastAPI 路由：roots / fs / npz / nav / video
  services/     dirindex、npzio、render、imgcache、video_export
  color.py      色域矩阵推导与 gamma 编码
  paths.py      路径归一化与 root 白名单校验
frontend/src/
  components/   TopBar、FolderTree、NpzList、NpzInfo、gallery/、compare/
  i18n/         中英文字典与 t()
  hooks/        usePanZoom、useImageResource、useHotkeys、useNpzNavigation、useSequencePlayback
  store/        zustand：应用状态与对比状态
  lib/          API 客户端、类型、格式化
scripts/        样例与压测数据生成
docs/SPEC.md    需求与设计规格
```
