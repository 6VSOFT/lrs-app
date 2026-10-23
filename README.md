# 狼人杀自动法官（12 人 · 预女猎白）PWA

12 位玩家各用手机加入同一个房间，由系统担任法官：随机发身份、自动主持夜晚、结算死亡、统计投票、判定胜负。无需真人法官和实体牌。

## 技术选型与说明
| 部分 | 方案 |
|---|---|
| 前端 | React + TypeScript + Vite + Tailwind CSS，`vite-plugin-pwa`（Manifest + Service Worker） |
| 认证 | Supabase 匿名登录（刷新后复用本地会话 => 恢复座位） |
| 可信后端 | Supabase **Edge Function `game`**（Deno）。所有操作都经它校验，客户端不能直接写任何表 |
| 规则引擎 | `supabase/functions/_shared/engine/`：纯 TypeScript 有限状态机，前后端/测试共用类型，Node 与 Deno 均可运行 |
| 并发控制 | Postgres 函数 `commit_state` 乐观锁（`version` CAS）+ 同一事务写入权威状态、公共视图、私人视图；冲突自动退避重试，避免重复结算 |
| 实时 | Supabase Realtime（`rooms`、`player_private`）+ 3 秒轮询兜底；Presence 显示在线/离线 |
| 部署 | **Supabase 本身不提供静态网站托管**，因此前端用 GitHub Pages（附 workflow），也可放到 Vercel/Netlify/Cloudflare Pages 任意静态托管 |

### 数据与安全（`supabase/migrations/20260101000000_init.sql`）
- `room_state`：完整权威状态（含所有身份）。**开启 RLS 且无任何策略**，客户端（anon/authenticated）无法读写，只有 Edge Function（service_role）能访问。
- `rooms`：公共视图，登录用户只读。夜晚统一显示为「黑夜」，不暴露谁在行动；身份仅在翻牌 / 开枪 / 游戏结束后出现。
- `player_private`：每人一行私人视图（自己的身份、狼队友、查验结果、女巫药剂/刀口、当前待办），RLS 只允许 `user_id = auth.uid()` 读取。
- `create_room` / `commit_state` 仅授权给 `service_role`。

## 本地运行
```bash
npm install
cp .env.example .env.local     # 填入 VITE_SUPABASE_URL 与 VITE_SUPABASE_ANON_KEY
npm run dev                    # http://localhost:5173
npm test                       # 规则引擎自动化测试
npm run build                  # 类型检查 + 生产构建（含 PWA）
```

## Supabase 配置（一次性）
1. 在 Supabase 控制台：**Authentication → Sign In / Providers → 开启 Anonymous sign-ins**。
2. 应用数据库结构（二选一）：SQL Editor 粘贴执行 `supabase/migrations/20260101000000_init.sql`；或 `supabase link --project-ref <ref>` 后 `supabase db push`。
3. 部署 Edge Function：
   ```bash
   supabase login
   supabase functions deploy game --project-ref <ref>
   ```
   `verify_jwt` 已在 `supabase/config.toml` 开启；`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` 由平台自动注入，无需手动设置。
4. 在 Project Settings → API 复制 URL 与 anon（publishable）key 填入环境变量。

## 前端部署（GitHub Pages）
仓库 Settings → Pages → Source 选 **GitHub Actions**；Settings → Secrets and variables → Actions → **Variables** 添加 `VITE_SUPABASE_URL`、`VITE_SUPABASE_ANON_KEY`。推送到 `main` 后 workflow 会跑测试、构建并发布。网址形如 `https://6vsoft.github.io/lrs-app/`，用手机浏览器打开后「添加到主屏幕」即可作为 PWA 使用。（使用 hash 路由与相对路径，子路径部署无需额外配置。）

## 实测步骤（12 人）
1. 创建者打开应用 → 输入昵称 → 创建房间，展示 QR Code；其余 11 人扫码或输入代码加入。
2. 12 人全部「准备」后创建者点「开始游戏」；每人点「查看身份」并「我已记住身份」。
3. 之后按手机提示操作：夜晚（狼人→预言家→女巫）→ 天亮 → 首日警长竞选 → 发言 → 归票/投票……直到结算页显示完整身份与记录。
4. 可在中途刷新或断网重连，进度与座位会恢复。

## 规则与默认约定（规则未明确处）
- **白痴**：规格中「翻牌免于放逐」与「翻牌后死亡」互相矛盾，本版本采用详细规则：被放逐后可选择翻牌（公开身份）或不翻牌，**两种选择均出局**，计入「屠神」。
- 猎人同夜既被刀又被毒 → 视为毒杀，不能开枪；被救者再被毒仍死亡。猎人开枪可选择不开枪、不能选自己。
- 胜负在每次死亡结算后立即检查（夜间、放逐、开枪、毒杀、翻牌）；若游戏已分胜负，猎人不再开枪。同时满足时**好人（狼全灭）优先**。
- 警长竞选：全员报名/不报名 → 候选人选择退水 → 最终候选人 ≥2 才投票；唯一候选人直接当选；**退水者不参与投票**，候选人可投其他候选人但不能投自己；允许弃票。平票时仅平票候选人参选，平票者不投票，再平票则无警长。
- 警长：警长出局时先结算猎人，再移交（或撕毁）警徽；归票后警长票 1.5，不归票为 1。警长选顺时针/逆时针发言（从警长下一位开始、警长最后发言）；无警长时按 1→12。
- 放逐投票：全员存活者一人一票、可投自己、可弃票；全部提交后才公布票型。平票 → 平票者依次发言（点「发言完毕」）→ 其余玩家重投；再平票本轮无人出局。
- 发言「跳过当前发言者」可由任一存活玩家触发，用于发言者离线时防止卡死；倒计时仅供参考。
- 状态机包含规格全部状态；`DAY_ANNOUNCEMENT`、`NIGHT_RESOLUTION`、`VICTORY_CHECK` 在同一事务内瞬时完成（无需玩家交互），额外加入 `SHERIFF_HANDOVER`。公共视图中夜晚各阶段统一显示为 NIGHT。
- 游戏结束后创建者可「再来一局」回到等待室。

## 自动化测试
`npm test`（Vitest，43 项）覆盖：加入/满员/开局校验、4狼4神4民分配、信息隔离、狼人刀口与平票、预言家、女巫（不可自救/不可双药/解药后不见刀口/只死一次）、猎人开枪条件、白痴翻牌、警长竞选与 1.5 票权重/平票/警徽移交与撕毁、放逐平票、屠神/屠民/狼全灭及优先级、非法请求（错阶段/非本角色/死亡/重复提交），以及 **300 局随机机器人整局模拟**（均能走到 GAME_OVER、无死锁）。

## 已知限制
- 引擎和前端已在本地构建/测试通过；**尚未用 12 台真实手机跑过一整局**，也需你在自己的 Supabase 项目里执行上面的配置步骤后才能联机。
- 匿名会话存于浏览器本地；清除浏览器数据或换浏览器后无法找回座位（等待室阶段可离开后重新加入）。
- 无超时机制：玩家离线时夜间/投票会等待其回来（设计如此，系统不替玩家决策）。
- 房间不会自动清理，可定期 `delete from rooms where updated_at < now() - interval '2 days';`（级联删除）。
- 无语音/文字聊天；发言在线下进行。
