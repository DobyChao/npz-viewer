# NPZ Viewer — 需求与实施规格

本文档是交付给实现 agent 的**唯一权威规格**。实现时如与本文档冲突，以本文档为准；如需偏离，先在文末「变更记录」追加说明。

---

## 1. 项目目标

一个本地运行的 npz 数据浏览器，用于快速查看和对比图像算法产出的 `.npz` 文件。核心场景是：在一个巨大的结果目录里翻找 npz，逐 key 可视化其中的 linear RGB 图 / mask / gainmap / 小矩阵，并用 FastStone Viewer 式的同步缩放面板做跨文件或文件内的图像对比。

**技术栈**：前端 React + Vite + TypeScript + TailwindCSS；后端 Python + FastAPI + NumPy + Pillow。

---

## 2. 已确认的关键决策

这些是和需求方确认过的，不要自行更改：

| 项 | 决策 |
| --- | --- |
| 色彩管线 | 后端渲染成 8bit PNG/WebP，**只做数值转换，不嵌入 ICC profile**（浏览器按 sRGB 显示）。切换色域时重新请求图片。 |
| 数据 dtype | float32/float16（linear，约 0~1，可能超出需 clip）、uint8/uint16（需除 255 / 65535 归一化）都要支持 |
| 维度 | 存在 4D 数组（带 batch 维），需要选择第几张；也存在字符串 / object / 标量等非数值 key |
| C=4 | 第 4 通道当 alpha，用棋盘格背景合成显示，并可单独切换查看 alpha 通道 |
| 纯 2D 大数组 [H,W] | 按灰度图显示，附带 min/max 归一化开关和可选伪彩色（viridis） |
| C=1 / mask | 线性灰度，**不做 gamma**，clip 0~1，卡片上显示实际 min/max |
| 缩略图 key | 自动选第一个可渲染的 3/4 通道图；支持在设置里配置优先 key 名列表（如 `rgb,output,result`） |
| 对比面板 | 最多 4 张，支持 1x2 / 2x1 / 2x2 网格，外加 A/B 快速 toggle 翻转 |
| 「下个上级文件夹的 npz」 | 跳到**兄弟文件夹里相同序号（第 N 个）**的 npz |
| 访问范围 | 通过可随时编辑的 `roots.json` 配置多个 root；**必须同时支持 Windows 和 Linux** |
| 规模 | 图像多数 < 2K，单 npz 多数 < 50MB，**单文件夹最多可能有 20 万个 npz** → 服务端分页 + 多级缓存是硬性要求 |

---

## 3. 界面布局

```
┌───────────────────────────────────────────────────────────────────────┐
│ TopBar: [root 下拉 + 管理] [当前路径面包屑] [色域: BT.2020 | P3] [设置] │
├──────────────┬────────────────────────────────────────────────────────┤
│ FolderTree   │ NpzInfo   文件名/路径(可复制) 大小 mtime key数 压缩标志  │
│ [刷新]       ├────────────────────────────────────────────────────────┤
│ ☑自动打开第  │ CompareBar  模式[跨文件|文件内]  已选项 chips / key勾选  │
│   [3]个 npz  ├────────────────────────────────────────────────────────┤
├──────────────┤ Gallery                                                │
│ NpzList      │  ┌─────────┐ ┌─────────┐ ┌─────────┐                   │
│ 缩略图+文件名 │  │GalleryCard│ │GalleryCard│ │GalleryCard│  每 key 一张  │
│ [复制路径]   │  └─────────┘ └─────────┘ └─────────┘                   │
│ ◀ 3/4000 ▶   ├────────────────────────────────────────────────────────┤
│ (服务端分页)  │ ComparePanel  [◀上一个npz▶] [◀上级文件夹▶] [展开][关闭] │
│              │   同步缩放的 1~4 宫格 FastStone 式对比视图  缩放比例%    │
└──────────────┴────────────────────────────────────────────────────────┘
```

- 所有分栏使用 `react-resizable-panels`，尺寸持久化到 localStorage。
- ComparePanel 有三态：`hidden` / `split`（与 Gallery 上下分栏）/ `full`（占满整个右侧区域，Gallery 隐藏）。
- 左栏上下两块也可拖拽调整比例。

---

## 4. 渲染规则（核心，必须严格实现）

### 4.1 key 分类

按数组 shape 和 dtype 判定 `kind`，前端据此选择卡片渲染器：

| 条件 | kind | 展示 |
| --- | --- | --- |
| key 名（小写）含 `gainmap` 且是图像形状 | `gainmap` | 特殊 clip 规则，见 4.3 |
| 3D，通道维 = 3 | `rgb` | linear RGB 图 |
| 3D，通道维 = 4 | `rgba` | linear RGB + alpha，棋盘格背景 |
| 3D，通道维 = 1，或 2D 且 max(H,W) > 9 | `gray` | 灰度图（mask 规则） |
| 3D，通道维 ∉ {1,3,4}（如 [16,H,W]） | `stack` | 通道堆栈，带 index 选择器，逐通道按灰度渲染 |
| 4D | 在 batch 维上切片后按上面规则再判定一次，kind 加 `batched` 标记 | 卡片上多一个 batch 选择器 |
| 0D 标量 | `scalar` | 直接显示数值 |
| 1D，长度 ≤ 256 | `table` | 列表数值 |
| 1D，长度 > 256 | `table` | 显示统计 + 前/后 32 个值，可展开 |
| 2D，且 H ≤ 9 且 W ≤ 9 | `table` | 矩阵表格 |
| 字符串 / object / 其他 | `raw` | 显示 repr（截断到 2KB） |

**通道轴判定（3D，shape = (a, b, c)）**：

1. `a ∈ {1,3,4}` 且 `c ∉ {1,3,4}` → CHW
2. `c ∈ {1,3,4}` 且 `a ∉ {1,3,4}` → HWC
3. 两者都在 {1,3,4} 内（如 (3,3,3)、(4,4,3)）→ **歧义，默认按 HWC**，卡片上提供 `CHW/HWC` 手动切换按钮
4. 两者都不在 → `stack`，通道轴取较小的那一维（默认 a），提供手动切换

**4D 判定**：`ndim == 4` 时第 0 维恒定视为 batch，剩余 3 维按上面规则处理。卡片提供 batch index 选择器（含「上一张/下一张」按钮）。

判定结果 `layout` 必须能被前端通过 query 参数覆盖并传回后端（`layout=auto|chw|hwc`、`channel_axis=`），后端不得自作主张忽略。

### 4.2 数值归一化

```python
arr = arr.astype(np.float32)
if dtype == uint8:   arr /= 255.0
elif dtype == uint16: arr /= 65535.0
elif dtype in (float16, float32, float64): pass   # 已是 linear 0~1 语义
```

### 4.3 RGB / RGBA 渲染管线

顺序**不可调换**：

1. 归一化（4.2）
2. 取通道，按 layout 转成 HWC
3. clip：
   - 普通图：`rgb = clip(rgb, 0, 1)`
   - gainmap：`rgb = clip(rgb, 0, 2) / 2`
4. 色域变换（仅当 `gamut=p3` 时）：`rgb_linear = rgb_linear @ M_2020_to_P3.T`，然后再次 `clip(0, 1)`
   - `gamut=bt2020` 时不做任何矩阵变换
   - **gainmap 默认不做色域变换**（它是比值图不是色度量），卡片上提供开关允许强制转换
5. gamma 编码：`out = rgb ** (1/2.2)`（纯 power function，不是 sRGB 分段曲线）
6. alpha 通道（若有）：只做 `clip(0,1)`，**不参与 gamma、不参与色域变换**
7. 量化：`uint8(round(out * 255))`，输出 PNG（RGBA 时输出 RGBA PNG，前端用 CSS 棋盘格垫底）

**色域矩阵不要硬编码**，用原色坐标推导，写在 `backend/app/color.py` 并加单元测试：

```python
# xy 原色 + D65 白点
BT2020 = dict(r=(0.708, 0.292), g=(0.170, 0.797), b=(0.131, 0.046), w=(0.3127, 0.3290))
P3D65  = dict(r=(0.680, 0.320), g=(0.265, 0.690), b=(0.150, 0.060), w=(0.3127, 0.3290))

def rgb_to_xyz(prim):   # 标准 Bruce Lindbloom 推导
    ...
M_2020_TO_P3 = inv(rgb_to_xyz(P3D65)) @ rgb_to_xyz(BT2020)
```

单元测试断言：矩阵约等于
```
[[ 1.3435, -0.2822, -0.0613],
 [-0.0653,  1.0758, -0.0105],
 [ 0.0028, -0.0196,  1.0169]]
```
容差 1e-3；且 `M @ [1,1,1] ≈ [1,1,1]`（白点保持）。

> **已知取舍**：因为输出不打 ICC tag，浏览器会当 sRGB 解释，所以在广色域屏上颜色是「近似」的。`config.embed_icc`（默认 `false`）预留为后续可选项，实现时在 render 函数里留好挂接点即可，本期不做。

### 4.4 灰度 / mask 渲染

1. 归一化（4.2）
2. `normalize=0`（默认）：`clip(v, 0, 1)`；`normalize=1`：`(v - vmin) / (vmax - vmin)`，vmin/vmax 取该数组实际值
3. **不做 gamma**
4. `colormap=none` → 单通道灰度 PNG；`colormap=viridis|magma|turbo` → 查表映射成 RGB PNG
5. 卡片上永远显示真实的 `min / max / mean`，不管有没有归一化

### 4.5 stack（多通道堆栈）

按选定 channel index 切出 2D，走 4.4 的灰度管线。

---

## 5. 后端设计

### 5.1 目录结构

```
backend/
├─ app/
│  ├─ main.py            # FastAPI app、CORS、静态文件挂载、启动参数
│  ├─ config.py          # Settings（pydantic-settings）+ roots.json 读写
│  ├─ models.py          # 所有 pydantic 响应模型
│  ├─ color.py           # 色域矩阵推导 + gamma
│  ├─ api/
│  │  ├─ roots.py  fs.py  npz.py  nav.py
│  └─ services/
│     ├─ dirindex.py     # 目录索引（20 万文件的分页来源）
│     ├─ npzio.py        # npz header 快速读取 + 数组惰性加载 + 内存 LRU
│     ├─ render.py       # 4.3~4.5 的渲染管线
│     └─ imgcache.py     # 渲染结果磁盘缓存 + LRU 淘汰
├─ tests/
└─ requirements.txt
```

### 5.2 配置

`roots.json`（放仓库根目录，可被用户随时手工编辑，后端每次读取前检查 mtime 并热重载）：

```json
{
  "roots": [
    { "id": "d-data", "name": "本地数据", "path": "D:/data/results" },
    { "id": "nas",    "name": "NAS",      "path": "/mnt/nas/exp" }
  ]
}
```

- 路径统一用 `pathlib.Path` 处理，内部/API 一律用**正斜杠 POSIX 风格字符串**，Windows 盘符形如 `D:/data`。
- 所有接收 `path` 的接口必须校验 `resolved_path` 位于某个 root 的 `resolve()` 之下，否则返回 403。符号链接要先 resolve 再校验。
- 启动参数：`--host --port(默认 8756) --roots-file --cache-dir --max-cache-gb(默认 8) --allow-pickle(默认 false)`。
- 缓存目录默认：Windows `%LOCALAPPDATA%/npz_view/cache`，Linux `~/.cache/npz_view`。

### 5.3 API 契约

所有响应 JSON 用 `ORJSONResponse`。所有 numpy 相关的重活必须走 `await asyncio.to_thread(...)`，**绝对不能阻塞事件循环**。

| Method | Path | Query / Body | 返回 |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ok, version}` |
| GET | `/api/roots` | — | `{roots:[{id,name,path,exists}]}` |
| POST | `/api/roots` | `{name, path}` | 新增并写回 roots.json |
| DELETE | `/api/roots/{id}` | — | 删除条目（不动磁盘文件） |
| GET | `/api/fs/dirs` | `path`（缺省=root 本身） | `{path, parent, dirs:[{name,path,has_children}]}` — **只返回一层**，树是懒加载 |
| POST | `/api/fs/refresh` | `{path}` | 清掉该目录的索引缓存与 npz header 缓存 |
| GET | `/api/npz/list` | `dir, page=1, page_size=50, sort=name\|mtime\|size, order=asc\|desc, q=` | `{total, page, page_size, pages, items:[{name,path,size,mtime}]}` |
| GET | `/api/npz/meta` | `path` | `{path,name,size,mtime,compressed,keys:[KeyMeta]}` |
| GET | `/api/npz/data` | `path,key,batch=` | 小数组的 JSON 值 + 统计 |
| GET | `/api/npz/stats` | `path,key,batch=` | `{min,max,mean,std,p1,p99,nan_count,inf_count}` |
| GET | `/api/npz/render` | 见下 | `image/png` 或 `image/webp` |
| GET | `/api/npz/thumb` | `path,key=,size=192,v=` | `image/webp` |
| GET | `/api/npz/pixel` | `path,key,x,y,batch=` | `{values:[...]}`（对比视图取值读数用） |
| GET | `/api/nav/sibling` | `path, scope=file\|folder, direction=next\|prev` | `{path,name,index,total}` 或 404 |
| GET | `/api/nav/locate` | `path` | `{path,name,index,total}` |
| GET | `/api/nav/at` | `path, index` | 该目录自然序第 `index` 个 npz（0 起）；越界 400 |
| POST | `/api/video/export` | 见 §6.6 | `{id,status,current,total}` |
| GET | `/api/video/jobs/{id}` | — | `{id,status,current,total,error,filename}` |
| POST | `/api/video/jobs/{id}/cancel` | — | 更新后的 job |
| GET | `/api/video/jobs/{id}/file` | — | `video/mp4` 下载；未完成 404 |

`KeyMeta`：
```ts
{
  name: string;
  shape: number[];
  dtype: string;
  kind: "rgb"|"rgba"|"gray"|"gainmap"|"stack"|"table"|"scalar"|"raw";
  layout: "chw"|"hwc"|null;      // 自动判定结果
  ambiguous: boolean;            // 通道轴歧义时为 true，前端要显示切换按钮
  batch: number|null;            // 4D 时的 batch 大小
  channels: number|null;
  height: number|null;
  width: number|null;
  nbytes: number;
}
```

`/api/npz/render` 完整参数：

```
path      必填
key       必填
gamut     bt2020 | p3          默认 bt2020（= 不做矩阵变换）
batch     int，4D 时的索引     默认 0
layout    auto | chw | hwc     默认 auto
channel   int，stack 的通道号   默认 0
normalize 0 | 1                默认 0，仅对 gray/stack 生效
colormap  none|viridis|magma|turbo  默认 none
gainmap_gamut 0|1              默认 0（gainmap 不做色域变换）
alpha     composite | rgb | alpha    默认 composite（输出 RGBA），rgb=丢弃 alpha，alpha=只输出 alpha 灰度图
max_size  int，长边上限，0=原尺寸   默认 0
format    png | webp           默认 png
v         缓存击穿用的版本串（前端传 `${mtime}_${size}`），后端忽略其值
```

响应头必须带 `ETag`（= 缓存 key 的 hash）和 `Cache-Control: public, max-age=31536000, immutable`，并正确处理 `If-None-Match` 返回 304。

**错误约定**：统一 `{"detail": {"code": "...", "message": "...", "hint": "..."}}`，HTTP 状态用 400/403/404/415/500。`code` 至少包含 `PATH_OUTSIDE_ROOT`、`FILE_NOT_FOUND`、`KEY_NOT_FOUND`、`UNSUPPORTED_KIND`、`NEEDS_PICKLE`、`BAD_PARAM`。

### 5.4 20 万文件的目录索引（关键）

`services/dirindex.py`：

- 用 `os.scandir()` 一次遍历，只收集 `.npz` 的 `(name, size, mtime)`，**不要用 `glob`/`Path.iterdir()` 后再 stat**（scandir 的 `DirEntry.stat()` 在 Windows 上是免费的）。
- 结果按请求的 sort 字段排序后缓存。文件名排序用**自然排序**（`img_2.npz` < `img_10.npz`）。
- 缓存三层：
  1. 进程内 `OrderedDict` LRU，最多 32 个目录
  2. 磁盘 `cache_dir/dirindex/<sha1(path)>.msgpack|json`，含 `dir_mtime` 字段
  3. 命中判定：磁盘 `dir_mtime` == 当前 `os.stat(dir).st_mtime` 才复用；否则重扫
- 显式刷新（`/api/fs/refresh` 或 UI 刷新按钮）无条件重扫。
- `q` 过滤在缓存好的列表上做子串匹配（大小写不敏感），再分页。
- 目标性能：20 万条目首次扫描 ≤ 5s，命中缓存的翻页 ≤ 50ms。

### 5.5 npz 元数据快速读取

**不要 `np.load()` 之后遍历所有 key**——那会解压全部数据。正确做法：

```python
with zipfile.ZipFile(path) as zf:
    for info in zf.infolist():
        with zf.open(info) as f:
            version = np.lib.format.read_magic(f)
            shape, fortran, dtype = np.lib.format._read_array_header(f, version)
```

只读每个成员的头部（约 128 字节）。压缩 npz 也可以这样读，`zf.open` 是流式的。

header 结果按 `(path, mtime, size)` 缓存到磁盘 JSON。

实际取数组时用 `np.load(path)[key]`（`NpzFile` 是按需解压的），并把解出来的 ndarray 放进按字节数计的内存 LRU（默认上限 2GB，可配）。

`allow_pickle` 默认 `False`；遇到 object 数组抛的异常要转成 `NEEDS_PICKLE` 错误码，前端提示「需以 --allow-pickle 启动」。

### 5.6 渲染缓存

- 缓存 key = `sha1(path | mtime | size | key | 所有渲染参数)`，文件落 `cache_dir/render/<前2位>/<hash>.<ext>`
- 后台 LRU 淘汰：超过 `max_cache_gb` 时按 atime 删除最旧的，检查频率不高于每 60s 一次
- 缩略图独立目录 `cache_dir/thumb/`，固定 WebP quality 80，长边 192

---

## 6. 前端设计

### 6.1 依赖

用包管理器安装最新稳定版，不要手写版本号猜测：
`react` `react-dom` `vite` `typescript` `tailwindcss`（v4，用 `@tailwindcss/vite` 插件 + CSS 里 `@import "tailwindcss"`）`react-resizable-panels` `zustand` `@tanstack/react-query` `@tanstack/react-virtual` `lucide-react` `clsx`

Vite dev 时把 `/api` proxy 到 `http://127.0.0.1:8756`。

### 6.2 目录结构

```
frontend/src/
├─ main.tsx  App.tsx  index.css
├─ lib/  api.ts  types.ts  paths.ts  format.ts
├─ store/  useAppStore.ts  useCompareStore.ts  useSettingsStore.ts
├─ hooks/  useHotkeys.ts  useSyncedViewport.ts  useLazyThumb.ts
└─ components/
   ├─ TopBar.tsx  RootManagerDialog.tsx  SettingsDialog.tsx
   ├─ FolderTree.tsx  FolderTreeNode.tsx
   ├─ NpzList.tsx  NpzListItem.tsx  Pagination.tsx
   ├─ NpzInfo.tsx  CopyButton.tsx
   ├─ CompareBar.tsx
   ├─ gallery/  GalleryGrid.tsx  GalleryCard.tsx  ImageCard.tsx  TableCard.tsx  StackCard.tsx  Lightbox.tsx
   └─ compare/  ComparePanel.tsx  CompareTile.tsx  CompareToolbar.tsx  NotFoundTile.tsx
```

### 6.3 状态

```ts
// useAppStore
rootId, currentDir, currentNpzPath, gamut: 'bt2020'|'p3',
autoOpen: { enabled: boolean, index: number },   // 选中文件夹后自动打开第 N 个 npz
list: { page, pageSize, sort, order, q }

// useCompareStore
mode: 'cross' | 'inside',
items: CompareItem[],        // 最多 4；CompareItem = {id, npzPath, npzName, key, batch, channel, label}
insideKeys: string[],        // inside 模式勾选的 key 名
layout: '1x2'|'2x1'|'2x2'|'1x1',
toggleIndex: number|null,    // 非 null 时进入 A/B 单图翻转模式
panel: 'hidden'|'split'|'full',
viewport: { scale, x, y }    // 所有 tile 共享

// useSettingsStore（持久化到 localStorage）
thumbPreferKeys: string[], thumbEnabled, pageSize, panelSizes, gamut, colormap, normalize
```

### 6.4 各组件要求

**TopBar** — root 下拉（含「管理 root」弹窗，可增删，调 `/api/roots`）；当前目录面包屑（可点击跳转）；色域 segmented control（BT.2020 / P3），切换后所有图片 URL 变化从而重新请求；设置按钮。

**FolderTree** — 懒加载一层一层展开，展开时才请求 `/api/fs/dirs`。顶部有刷新按钮（对当前选中目录调 `/api/fs/refresh` 并重新拉取）。底部是「☑ 自动打开第 [N] 个 npz」的 checkbox + 数字输入，勾选后每次切换文件夹自动选中该序号的 npz（越界则选最后一个）。

**NpzList** — **服务端分页**（20 万文件的硬性要求）。上方有搜索框（`q`，300ms debounce）、排序下拉、每页条数（25/50/100/200）。底部分页条：首页/上页/`第 X / Y 页`（可输入跳转）/下页/末页 + `共 N 个文件`。每行：缩略图（IntersectionObserver 懒加载，全局并发上限 4，设置里可整体关闭）、文件名、大小、mtime、复制路径按钮。当前选中项高亮。页内用 `@tanstack/react-virtual` 虚拟化。

**NpzInfo** — 文件名、完整路径（两者各带一键复制）、文件大小、mtime、key 数量、是否压缩。

**CompareBar** — 模式切换（跨文件 / 文件内）。
- 跨文件模式：显示已加入对比的 item chips（缩略图 + `npz名 / key` 标签 + 删除按钮），满 4 个后「加入对比」按钮禁用并提示。
- 文件内模式：列出当前 npz 所有可渲染 key 的 checkbox（含全选/全不选），勾选的 key 直接构成对比项；切换 npz 时**保留勾选的 key 名**。

**GalleryGrid / GalleryCard** — 每个 key 一张卡片，卡片头显示 key 名、shape、dtype、min/max/mean。卡片操作按钮：加入对比、全屏（Lightbox）、色域覆盖（跟随全局 / BT.2020 / P3）、CHW⇄HWC 切换（仅 `ambiguous` 时出现）、alpha 显示模式（仅 RGBA）、batch 选择器（仅 4D）、channel 选择器（仅 stack）、归一化与 colormap（仅 gray/stack）。图片懒加载，加载中显示骨架屏，失败显示错误码和 message。`table`/`scalar`/`raw` 用文本卡片渲染，数值保留 6 位有效数字，2D 矩阵用等宽表格。

**Lightbox** — 点击卡片放大到全屏，支持滚轮缩放、拖拽平移、`Esc` 关闭、`←/→` 在同一 npz 的图像 key 之间切换。

**ComparePanel（FastStone 式，最关键的交互）**
- 1~4 个 tile 按 `layout` 网格排布，**共享同一个 viewport transform**：任一 tile 内滚轮缩放（以光标位置为锚点）或拖拽平移，其余 tile 同步。
- 工具栏：缩放百分比读数、`适应窗口` / `100%` 按钮、布局切换、A/B toggle 开关、面板三态切换（隐藏 / 分栏 / 占满）、关闭按钮。
- A/B toggle：开启后只显示一个 tile，按 `空格` 在已选项之间循环切换，用于像素级闪烁对比。切换时**不重置 viewport**。
- 每个 tile 左上角显示标签 `npz文件名 / key`，右上角有单独移除按钮。
- 顶部导航：`◀ 上一个 npz / 下一个 npz ▶`（同目录内）、`◀ 上级文件夹 / 下级 ▶`（兄弟文件夹里相同序号的 npz）。
- **文件内模式跨文件跟随**：切到新 npz 后，用相同的 key 名重新构造 tile；如果新 npz 里没有这个 key，该位置渲染 `NotFoundTile` 占位（灰底 + `KEY NOT FOUND: <key>`），**不要塌陷布局**。
- 鼠标悬停时在工具栏显示当前像素坐标和原始数值（调 `/api/npz/pixel`，节流 100ms）。
- **序列栏（仅文件内对比）**：底部起止帧、播放、scrubber、导出。跨文件模式隐藏。详见 §6.6。

### 6.5 快捷键

| 键 | 行为 |
| --- | --- |
| `←` / `→` | 同目录上一个 / 下一个 npz |
| `↑` / `↓` | 兄弟文件夹中相同序号的 npz（上/下一个文件夹） |
| `空格` | A/B toggle 切换 |
| `P` | 文件内对比且已选起止帧时，播放/暂停序列；跨文件或未选区间时忽略 |
| `1`~`4` | 单独查看第 n 个 tile |
| `F` | 对比面板占满 / 还原 |
| `Ctrl+0` | 适应窗口 |
| `Ctrl+1` | 100% |
| `Esc` | 关闭 Lightbox；无 Lightbox 时收起对比面板 |
| `R` | 刷新当前目录 |

输入框聚焦时全部快捷键失效。

### 6.6 序列播放与宫格导出（仅文件内对比）

序列 = 当前 npz 所在目录里、按自然名排序的兄弟 `.npz`。对比格共用同一文件、key 不同。跨文件对比**不做**序列播放/导出；切到跨文件、清空勾选或关掉对比面板时停止播放并丢掉起止帧。

**播放**

- 必须先选起止帧（闭区间，0 起的目录序号），不默认跑整个文件夹。
- playhead 只改对比瓦片用的 path，**不** `jumpToFile`，文件列表保持原选中项。暂停后可「定位到当前帧」。
- 播放中可继续平移缩放；空格仍是 A/B。播到结束帧后停止，停在最后一帧；再按播放从起始帧重来。
- 仅播放中预取后续帧到内存；暂停或播完后停止。下一帧未就绪则等待（降低有效 fps），不跳帧、不盖加载转圈。
- 新文件没有某 key：该格 KEY NOT FOUND 占位，不塌布局。

**导出**

- 一条 MP4（H.264 / yuv420p / 无音轨），按当前宫格拼（含 auto 推导），格子标签为 `key` + 文件名。不烤覆盖层、不烤 A/B 闪烁。
- 两种裁剪：`full` 完整原图（等高跟随面板开关）；`viewport` 按对比面板当前缩放/平移裁，公式与像素读数一致：`effective = scale * scaleFactor`，`src = (-x/effective, -y/effective, tileW/effective, tileH/effective)`。
- 长边上限 1080 / 1920 / 2160（默认 1920）。FPS 默认 12，范围 1–60。
- 软上限 2000 帧（需 `confirm_large`），硬上限 10000。
- ffmpeg 经 `imageio-ffmpeg` 捆绑，不依赖系统安装。成品放 cache 目录，浏览器下载。

`POST /api/video/export` body：

```
path, keys:[{key, batch, layout, channel, normalize, colormap, alpha, gainmap_gamut}],
gamut, start, end, fps, layout, crop: full|viewport, max_size, equal_height,
confirm_large, viewport?: {scale,x,y,tile_width,tile_height,natural_sizes:[{width,height}]}
```

---

## 7. 性能要求

| 指标 | 目标 |
| --- | --- |
| 20 万文件目录首次索引 | ≤ 5s，之后翻页 ≤ 50ms |
| npz meta（列 key + shape） | ≤ 200ms（不解压数据体） |
| 2K 图渲染（冷缓存） | ≤ 400ms |
| 渲染命中磁盘缓存 | ≤ 30ms |
| 缩略图并发 | 全局 ≤ 4，滚出视口即取消请求（AbortController） |
| UI | 任何操作不得阻塞主线程 > 100ms |

---

## 8. 实施计划（按里程碑拆分，可分配给不同 agent）

每个里程碑结束时必须是**可运行、可验收**的状态。

### M0 — 脚手架
- 建 `backend/`（FastAPI + requirements.txt，pin 住版本）、`frontend/`（Vite + React + TS + Tailwind v4）
- Vite dev proxy `/api` → `127.0.0.1:8756`
- `scripts/make_sample_npz.py`：生成覆盖所有 kind 的测试数据（float32 CHW RGB、uint8 HWC RGBA、gainmap、C=1 mask、[H,W] 大二维、[16,H,W] stack、4D batch、1D 向量、3x3 矩阵、标量、字符串），支持 `--count N --out DIR` 以便造 20 万文件压测目录
- 根 `README.md`：安装与启动说明（Windows / Linux 两套命令）
- **验收**：`uvicorn` 起得来、`/api/health` 通、`npm run dev` 出白板页面、样例数据能生成

### M1 — 后端：配置 + 文件系统 + 分页
- `config.py`（roots.json 热重载）、路径越界校验、`/api/roots` CRUD、`/api/fs/dirs`、`/api/fs/refresh`
- `dirindex.py` 三层缓存 + 自然排序 + 搜索 + 分页，`/api/npz/list`
- **验收**：pytest 覆盖越界拦截、自然排序、分页边界；用 20 万空 npz 的压测目录验证 §7 的两项指标

### M2 — 后端：元数据 + 渲染 + 缓存
- `npzio.py` zip header 快速读取 + 内存 LRU + kind/layout 判定
- `color.py` 色域矩阵推导（含单元测试）
- `render.py` 实现 §4 全部管线；`imgcache.py` 磁盘缓存 + LRU 淘汰
- `/api/npz/meta` `/data` `/stats` `/render` `/thumb` `/pixel`，ETag + 304
- `/api/nav/sibling`
- **验收**：pytest 覆盖每种 kind 的渲染输出（比对已知像素值）、gainmap 的 clip 0-2÷2、mask 不做 gamma、色域矩阵、4D/歧义 layout 的判定与覆盖；ETag 命中返回 304

### M3 — 前端：骨架布局 + 浏览
- resizable panels 三区布局 + 尺寸持久化
- TopBar（root 下拉 + 管理弹窗 + 面包屑 + 色域切换）
- FolderTree（懒加载 + 刷新 + 自动打开第 N 个）
- NpzList（服务端分页 + 搜索 + 排序 + 虚拟化 + 懒加载缩略图 + 复制路径）
- NpzInfo
- **验收**：能从 root 一路点到某个 npz 并看到它的基础信息；20 万文件目录下翻页流畅

### M4 — 前端：Gallery
- GalleryGrid + 各类 Card + 全部卡片级控件（色域覆盖、layout 切换、batch/channel、alpha 模式、normalize、colormap）
- Lightbox
- **验收**：样例 npz 的每个 key 都能正确渲染；gainmap 和 mask 的显示明显区别于普通 RGB；4D 能切 batch

### M5 — 前端：对比
- CompareBar 两种模式
- ComparePanel + 同步 viewport + A/B toggle + 三态面板 + NotFoundTile + 像素读数
- `/api/nav/sibling` 接入的四向导航
- **验收**：跨文件加 4 张图能同步缩放；文件内模式勾 3 个 key 后连按 `→` 翻 npz，key 跟随、缺失时出占位

### M6 — 打磨
- 全局快捷键、localStorage 持久化、错误边界与友好错误提示、加载骨架、空状态
- 生产构建：FastAPI 挂载 `frontend/dist` 静态文件，单进程启动
- README 补齐使用说明与截图
- **验收**：`python -m app.main --port 8756` 一条命令即可用；断网/坏文件/权限不足都有可读的错误提示

---

## 9. 对实现 agent 的通用要求

1. **后端**：全量 type hints；所有响应用 pydantic 模型；numpy/IO 一律 `asyncio.to_thread`；不允许裸 `except:`；日志用 `logging` 并带 request 耗时。
2. **前端**：严格 TS（`strict: true`），不允许 `any`（第三方类型缺失时写 `.d.ts`）；服务端状态一律走 react-query，不要手写 `useEffect` + `fetch`；组件保持无副作用，副作用集中在 hooks。
3. **跨平台**：所有路径拼接用 `pathlib` / `path.posix`，禁止手写 `\\` 或 `/` 字符串拼接；文件名比较在 Windows 上大小写不敏感、Linux 上敏感，排序统一用 `casefold` 后的自然序做 key。
4. **测试**：后端 pytest 必须覆盖 §4 的每一条渲染规则和 §5.4 的缓存失效逻辑。前端至少对 `useSyncedViewport` 的缩放锚点数学写单测。
5. **不要**引入 UI 组件库（antd/MUI 等），全部用 Tailwind 手写，配 lucide-react 图标。
6. **不要**为了「更好」而擅自改动 §2 和 §4 的决策。
7. 每个里程碑完成后更新 README 的「已完成 / 待办」清单。

---

## 10. 我替你做的次要决策（如有异议请提出）

1. gainmap 默认**不**做 BT.2020→P3 色域变换，卡片上给开关。
2. gainmap 与 C=1 同时成立时（单通道 gainmap），按 gainmap 规则处理（clip 0-2 ÷2），但不做 gamma（沿用 mask 的线性规则）。
3. 界面语言：**中文**。
4. 1D 数组长度 ≤ 256 才完整列出，更长的折叠显示。
5. 2D「小矩阵」阈值：H ≤ 9 且 W ≤ 9（与你举的例子一致），做成配置项 `smallMatrixMax`。
6. 后端默认端口 8756，前端 dev 5173。
7. 渲染输出格式默认 PNG（对比时要像素精确），缩略图用 WebP。
8. 对比面板的像素数值读数是额外接口调用，如果觉得多余可以砍掉。
9. `allow_pickle` 默认关闭，需要时用启动参数打开（避免执行不可信 npz 里的 pickle）。

---

## 11. 变更记录

| 日期 | 变更 | 原因 |
| --- | --- | --- |
| 2026-08-12 | 初版 | — |
| 2026-08-27 | 文件内对比：序列播放 + 宫格 MP4 导出 | 跨文件序列明确不做 |
