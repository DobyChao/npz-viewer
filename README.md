# npz 浏览器

浏览、渲染、对比 `.npz` 文件的本地工具。针对图像类实验产物设计：一个 npz 里通常有若干张
linear RGB 图、gainmap、mask、特征图和一些小矩阵，需要快速看图、跨版本比对、读原始像素值。

- 后端 Python + FastAPI，负责扫目录、解 npz、把数组渲染成 PNG/WebP
- 前端 React + Vite + TailwindCSS，负责布局、缩略图、FastStone 式同步对比
- 单文件夹 20 万个 npz 也能用：目录索引分三级缓存，列表服务端分页，缩略图懒加载并限流

详细的需求与设计决策见 [`docs/SPEC.md`](docs/SPEC.md)。对比面板拖动收起/展开与按钮状态如何对齐，见 [`docs/resizable-panel-visibility.md`](docs/resizable-panel-visibility.md)。

## 环境要求

- Python 3.11+（开发验证于 3.14）
- Node.js `^20.19.0 || >=22.12.0`（Vite 8 的要求，已写进 `frontend/package.json` 的 `engines`；
  开发验证于 24）

`typecheck` 脚本直接调用 `node node_modules/typescript/lib/tsc.js` 而不是 `tsc`，这是刻意的：
typescript 7 的 `bin/tsc` 是个**没有扩展名**的 ESM 文件，只有较新的 Node 能把它当入口执行，稍旧的
Node 会报 `ERR_UNKNOWN_FILE_EXTENSION`。改走带扩展名的 `lib/tsc.js`，在上面整个版本范围内都能用。

## 快速开始

```bash
# 1. 后端依赖
python -m venv .venv
.venv\Scripts\pip install -r requirements-dev.txt      # Linux/macOS: .venv/bin/pip

# 2. 生成样例数据（顺便把它写进 roots.json）
.venv\Scripts\python scripts/make_sample_npz.py

# 3. 启动后端（默认 127.0.0.1:8756）
cd backend && ..\.venv\Scripts\python -m app.main

# 4. 另开一个终端启动前端（默认 127.0.0.1:5273）
cd frontend && npm install && npm run dev
```

打开 http://127.0.0.1:5273 即可。前端 dev server 会把 `/api` 代理到后端，不涉及跨域。

### 配置可访问的目录（roots）

后端只允许访问 `roots.json` 里列出的目录及其子目录，路径穿越（`..`、符号链接指到外面）会被
拒绝并返回 `PATH_OUTSIDE_ROOT`。

```json
{
  "roots": [
    { "id": "results", "name": "实验结果", "path": "D:/data/results" },
    { "id": "nas", "name": "NAS", "path": "/mnt/nas/exp" }
  ]
}
```

这个文件可以在前端顶栏的「管理 root」里增删，也可以直接用编辑器改 —— 后端按 mtime 热加载，
不用重启。Windows 和 Linux 都用正斜杠写绝对路径。

### 生产模式（单进程）

```bash
cd frontend && npm run build
cd ../backend && ..\.venv\Scripts\python -m app.main --static-dir ../frontend/dist
```

此时后端同时提供 API 和前端静态文件，只需要访问 http://127.0.0.1:8756 一个地址。

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

所有参数也可以用 `NPZVIEW_` 前缀的环境变量设置，例如 `NPZVIEW_PORT=9000`。

## 渲染规则

数据类型的判定和像素处理完全在后端完成，前端只负责显示返回的 8bit 图。

| 数组形态 | 判定 | 渲染方式 |
| --- | --- | --- |
| `[C,H,W]` / `[H,W,C]`，C=3 | `rgb` | 视作 linear RGB，clip 到 0–1，gamma 2.2 编码 |
| C=4 | `rgba` | 同上，alpha 通道**不做 gamma**，前端用棋盘格衬底 |
| C=1 或二维 | `gray` | 保持线性，不做 gamma；可选 min/max 归一化和伪彩色 |
| key 名含 `gainmap` | `gainmap` | clip 到 0–2 再除以 2，然后 gamma 2.2 |
| C 为其他值 | `stack` | 按通道逐张显示灰度图 |
| 四维 `[B,...]` | 带 batch | 卡片上可以切换 batch 序号 |
| 一维、或不超过 9×9 的二维 | `table` | 直接列出数值 |

**色域**：顶栏可以在 BT.2020 和 P3 之间切换。选 P3 时会做一次 BT.2020 → Display P3 的矩阵变换
再 gamma 编码；矩阵由两个色域的原色/白点坐标现算（见 `backend/app/color.py`），不是硬编码常数。

输出的 PNG/WebP **不嵌入 ICC profile**，浏览器一律按 sRGB 解释。所以 P3 模式是"数值变换后按
sRGB 显示"，在广色域屏上是近似效果，用于对比两种色域下的数值差异，不适合当色彩校样。这是一个
刻意的简化，取舍记录在 SPEC 第 2 节。

**通道轴歧义**：形如 `[3,4,3]` 这种两端都像通道轴的数组，默认按 HWC 解释，卡片上会出现
CHW/HWC 切换按钮，并标注歧义。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `←` / `→` | 上一个 / 下一个 npz（同文件夹内，自然序） |
| `↑` / `↓` | 跳到相邻兄弟文件夹里**同序号**的 npz，用于跨版本比对；会自动跳过没有 npz 的文件夹 |
| `空格` | A/B 翻转，在已选的对比图之间切换 |
| `1`–`4` | 直接切到第 N 张对比图 |
| 按住 `X` | 覆盖模式下临时移开覆盖层，松开恢复，用于闪烁比对 |
| `F` | 对比面板占满右侧 / 还原分栏 |
| `Ctrl+0` / `Ctrl+1` | 对比面板适应窗口 / 100% |
| `R` | 刷新当前目录（丢弃该目录的索引缓存） |
| `Esc` | 关闭对比面板；灯箱打开时先关灯箱 |

对比视图里滚轮缩放（以光标为锚点）、拖拽平移，**所有分块共享同一个视口**，缩放超过 150% 后
切成最近邻采样以便看清像素边界。分块数量决定默认网格（2 张并排、3 张三列、4 张 2×2），也可以
在工具栏里手动指定 1×1 / 并排 / 上下 / 三列 / 三行 / 2×2。

找细微差异有两种模式，同时提供：

- **A/B 翻转**：整个面板只显示一张图，空格轮流切换。适合两张图差别较大、想看整体的时候。
- **覆盖**：对应 FastStone 的 Overlay (Right on Left)，把「覆盖源」那一格的图直接叠到第 1 格
  上，布局不变、覆盖源那一格仍显示原图作参照。按住 `X` 临时移开覆盖层，一放一按之间图上任何
  位移或数值变化都会跳出来。超过两张图时，点其他分块右上角的图层按钮可以改覆盖源。

两个模式是互斥的，开一个会自动关掉另一个。因为所有分块共享视口，叠上去的两层天然像素对齐，
不需要额外配准。

**等高**：图的尺寸不一样时（gainmap 常常是半分辨率），共享视口会让小图显示得也小，没法比。
打开「等高」后每张图各自等比缩放到与第 1 格相同的显示高度，第 1 格就是基准，状态栏会显示基准
高度。这个开关和覆盖可以叠着用 —— 半分辨率的 gainmap 叠到全分辨率的图上会先拉到等高再叠，
边界正好对上。检测到分块尺寸不一致时，「等高」按钮上会出现一个琥珀色小点提示你可以开。

缩放上跟随 FastStone 的模型：处于「适应窗口」状态时，改变面板大小、增删分块、切换布局都会重新
适应；一旦你手动滚轮缩放过，就不再自动改动你的视口，翻页也保持不变。

## 测试

```bash
# 后端：渲染规则、分类逻辑、目录索引、API 契约
.venv\Scripts\python -m pytest

# 前端：类型检查
cd frontend && npm run typecheck

# 前端端到端：同步缩放/平移、缩放保持、像素读数、灯箱、键盘导航、无 console 报错
cd frontend && npm run e2e
```

端到端用例需要后端在 8756 上跑着；Playwright 会自己拉起前端 dev server（已在跑就复用）。

同步缩放/平移只能靠真实浏览器输入验证 —— 它依赖 non-passive 的原生 wheel 监听和 pointer
capture，用 JS 合成事件测不出来，所以这部分放在 Playwright 而不是单元测试里。

## 大目录

单个文件夹 20 万个 npz 是设计目标，做法是：

- `os.scandir` 一次拿到名字和 stat，避免每个文件再 stat 一遍
- 目录快照三级缓存：进程内 LRU → 磁盘上的列式 JSON → 重新扫描；用目录 mtime 判断是否失效
- 快照按自然序（`img_2` 在 `img_10` 前）存一份，其他排序方式按需派生并记忆化
- 列表服务端分页，前端再用虚拟滚动只渲染可见行
- 缩略图 IntersectionObserver 懒加载，全局最多 4 个并发请求，滚走的请求直接 abort
- 渲染结果按（文件 mtime+size+全部渲染参数）哈希后缓存到磁盘，带 ETag，重复访问走 304

压测数据可以用 `python scripts/make_sample_npz.py --stress 200000 --stress-only` 生成。

## 目录结构

```
backend/app/
  api/          FastAPI 路由：roots / fs / npz / nav
  services/     dirindex 目录索引、npzio 读取与分类、render 渲染管线、imgcache 磁盘缓存
  color.py      色域矩阵推导与 gamma 编码
  paths.py      路径归一化与 root 白名单校验
frontend/src/
  components/   TopBar、FolderTree、NpzList、NpzInfo、gallery/、compare/
  hooks/        usePanZoom、useImageResource、useHotkeys、useNpzNavigation
  store/        zustand：应用状态与对比状态
  lib/          API 客户端、类型、格式化
scripts/        样例与压测数据生成
docs/SPEC.md    需求与设计规格
```
