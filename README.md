# Payload Migration Studio

旧 API 对象 → 新 schema 的迁移工作台。用户组合 **重命名 / 移动 / 拆分 / 合并 / 表达式** 步骤，
用样例文档逐步预览中间结果，服务端把转换流水线带 revision 持久化。

```bash
npm install
npm run dev      # tsx watch API (4174) + vite UI (4173)
npm test         # vitest（引擎 15 例 + HTTP 5 例）
npm run build    # tsc 类型检查 + vite 构建
```

## 路径与值语义

- 路径：`$.user.name`、`$.items[0].id`、`$.items[*].zip`、`$["weird.key"]`。
- **缺失 ≠ null**：`$.a` 为 `null` 时可取用、可移动；`$.nope` 是 missing。
  表达式中分别用 `isNull(v)` / `isMissing(v)` 判断；穿过 null 的链式读取传播为 null。
- 数组映射：`source` 与 `target` 必须同时带 `[*]`，对每个元素求值，`index` 为元素下标；
  `[*]` 后的尾巴（`items[*].zip`）逐元素解析，缺失的尾巴向表达式暴露为 missing。
- 拆分：部分数量超过目标数报错；目标多于部分时，剩余目标写入**显式 null**。
- 合并：`join`（字符串）/ `concat`（数组连接）/ `object`（对象合并）。
- 目标已存在：`overwrite`（默认）/ `skip`（跳过并记 noop）/ `error`（中止）。
- 重命名只能在同一父级下；跨父级请用 move（move 可取消"删除源"变成复制）。

## 原子执行

`src/shared/engine.ts` 的每一步分两阶段：

1. **plan**：只读，完成源读取、通配符展开、表达式求值、目标可行性、冲突预检；
2. **commit**：重新解析目标（可创建中间容器）→ 全部冲突检查 → 统一写入 → 删源。

失败返回 `{index, stepId, code, sourcePath, preStatePath, preState}`，其中 `preState` 是
源子树的**有界**快照（2000 节点 / 6 层）。错误响应里没有 `output` 字段 —— 已应用的前若干步
只是"部分前状态"，不会被当作最终输出。

## 重排与重新验证

路径引用基于**前置步骤产出的结构**顺序校验（`src/shared/validate.ts`）。
拖动重排后：旧预览立即作废，前端对预览请求做了序号守卫（runSeq）+ AbortController，
旧 SSE 流的帧不会覆盖新顺序的结果；校验以 250ms 防抖重新跑一遍。

## 流式与按需展开（大样例）

- `POST /api/pipelines/:id/execute` 返回 SSE：`start` → 每步一个 `step`（只含根节点
  **摘要** `NodeSummary` + 变更列表）→ `done`；失败发 `error` 后结束，不发 `done`。
- 服务端不保存每一步的完整对象；执行会话只保留输入、步骤和摘要。
- `GET /api/executions/:eid/nodes?afterStep=&path=` 用输入**重放**到指定步后取节点，
  上限 5000 节点 / 8 层，missing 与 value 分开返回。前端只在用户展开时请求。
- 500 元素数组的整段 SSE 约 38KB，不含任何元素载荷。

## 并发保存

- `PUT /api/pipelines/:id` 必须带 `revision`；与当前版本不符返回 `409` + 当前文档。
- execute 可带 revision，流水线在别处保存过时返回 `409`，不会用旧步骤预览。
- 前端冲突时可选择"载入服务器版本"或"在服务器 revision 上重试本地修改"。

## 代码地图

```
src/shared/types.ts       共享类型（Step / SSE 事件 / 摘要）
src/shared/path.ts        路径解析、读写、通配符展开（missing vs null）
src/shared/expression.ts  沙箱表达式（无 eval/Function）
src/shared/engine.ts      两阶段原子执行 + 摘要 + 有界前状态
src/shared/validate.ts    按前置步骤结构顺序校验
src/server/store.ts       内存存储 + revision 乐观锁 + 种子流水线
src/server/execute.ts     SSE 流式执行 + 节点重放展开
src/server/index.ts       REST API
src/client/App.tsx        三栏工作台：列表 / 步骤编辑拖拽 / 流式时间线
```
