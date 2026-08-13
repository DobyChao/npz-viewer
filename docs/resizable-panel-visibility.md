# 对比面板：拖动收起与按钮状态

Gallery / 对比分栏用的是 `react-resizable-panels`。拖过分隔条把对比区收起、点按钮隐藏、按 `F` 占满，这三件事必须落到**同一份显隐状态**上，否则就会出现「画面已经没了，按钮还显示开着」或「按钮显示折叠，分隔条却被禁用拖不回来」。

实现在 `frontend/src/App.tsx`（`applyPanelLayout`、`onCompareResize`、`onGalleryResize`），状态在 `frontend/src/store/useCompareStore.ts` 的 `panel` 与 `splitComparePercent`。

## 问题本质：两套真理

| 来源 | 它以为自己管什么 |
| --- | --- |
| zustand `panel`: `hidden` / `split` / `full` | 按钮、快捷键、`F` |
| 库内部的像素尺寸 / `isCollapsed()` | 拖分隔条 |

两边各改各的，就会分叉。这不是这套库独有的，凡是「可拖分栏 + 外部显隐按钮」都会踩。VS Code 看起来顺，是因为它根本不允许这两套状态同时当主人。

## VS Code 实际怎么做

VS Code 不用 React，用自己的 `SerializableGrid`。布局服务里有布尔值（例如 `PANEL_HIDDEN`）：

1. **显隐只有一个源。** 按钮读它，拖分隔条过阈值也调同一个 `hide()` / `show()`。
2. **隐藏不是 resize 到 0。** `setViewVisible(false)` 把那一块从分割里拿掉，上次高度另外记着，打开再还回去。
3. **底部面板收起后，分隔条还在**，可以再拖回来展开（侧边栏 Explorer 则往往要点图标，两种都存在）。

本项目的对比区对标的是底部面板：拖过最小高度 = 隐藏；收起后分隔条仍可拖回。

`react-resizable-panels` 的作者也承认：折叠后用点击重新打开更省事；若允许拖回，库会做成「过了 `minSize` 才吸附弹开」，分隔条在折叠态下不会跟着鼠标一点点走。见 [discussion #269](https://github.com/bvaughn/react-resizable-panels/discussions/269)。v4 还删掉了 `onCollapse` / `onExpand`（旧版 **mount 时就会火**，一同步就乱），改口让你在 `onResize` 里自己比上一帧是不是 0。

## 试过但会坏的修法

| 做法 | 为什么不行 |
| --- | --- |
| 按钮改 store，effect 里 `collapse()`，不管拖动 | 拖收起时 store 不更新，按钮仍显示开着 |
| `onResize` 再写回 store，effect 再 `collapse()`/`expand()` | 双向同步，容易循环；第一次 mount 的 resize 会误伤 |
| 展开时若太矮就 `resize("45%")` | 用户故意拖矮再开关，会被弹回 |
| 收起后 `disabled` 分隔条 | 按钮对了，但再也拖不回来 |
| `hidden` 时把 `GalleryGrid` 卸掉再挂 | 按钮/尺寸好处理，gallery 滚动位置丢了 |
| 把库的 `expand()` 当「恢复上次高度」 | 若折叠时没记下展开尺寸，会停在 0 或 `minSize` 15%，对比区几乎打不开 |

## 本项目的约定

**`panel` 是显隐的唯一源。** 按钮 `active={panel !== "hidden"}` 只看它。库的尺寸是奴隶：由 store 落地到 collapse/expand，拖动过阈值再写回 store。

交互：

- 点「隐藏」或 `Esc` → `panel = hidden`
- 把对比区拖过 `minSize`（15%）→ 同样 `panel = hidden`
- 点「显示」→ `panel = split`，并把对比区 `resize` 到记下的 `splitComparePercent`
- 折叠后**不禁用分隔条**；往回拖过阈值 → `panel = split`，高度跟手走，不要再强制弹回 45%
- 把 gallery 拖到收起 → `panel = full`（等同 `F`）；再拖回来 → `split`

落地时只做差量，已经一致就什么都不做：

- `hidden`：对比区 collapsed，gallery 展开
- `full`：gallery collapsed，对比区展开
- `split`：**仅当对比区当前是 collapsed**（按钮打开）才 `expand` + `resize(splitComparePercent)`。若用户已经把分隔条拖开了，不要再 `resize`，否则会和拖动手势打架

`splitComparePercent` 只在 `panel === "split"` 且高度不是 0 时更新。折叠或占满时对比区会变成 0% / ~100%，那些值不能当「下次打开的分栏比」。

布局持久化（`useDefaultLayout`）加上：

- `onlySaveAfterUserInteractions: true`，程序化 collapse 不写 localStorage
- 含 0% 的 snapshot 直接丢掉，避免下次启动从「对比区高度 0」开始，`expand()` 找不到上次高度

Gallery 始终挂在树上（折叠对比区而不是卸载 `GalleryGrid`），滚动位置才能在显隐之间保持。对比区在高度接近 0 时不要 `fit`（`clientWidth/Height < 8` 直接 return），否则会把缩放写成 0，后面滚轮怎么转都到不了 1:1。

分隔条样式用 `aria-[orientation=…]` 而不是 `data-[orientation=…]`。这套库只设置 `aria-orientation`，用错属性分隔条会变成 0×0，看起来像「禁用了」。

## 吸附手感（不是 bug）

折叠之后分隔条几乎贴在底边。往回拖时，条子不会马上跟着鼠标走，要过大约 15% 的 `minSize` 才会弹开。这是库故意做成和 VS Code 一样的吸附，不是分隔条坏了。

## 以后不要做的事

1. 再给「是否折叠」加第二份布尔值，或让按钮去读 `isCollapsed()`。
2. 折叠后 `disabled` 分隔条。
3. 每次进入 `split` 都 `resize("45%")`。
4. 为了对齐按钮，把 gallery / 对比区在 `hidden` ↔ `split` 之间卸载重挂。
5. 把 `onResize` 的 mount 帧（`prev === undefined`）当成用户拖动。
