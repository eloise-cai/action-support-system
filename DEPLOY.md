# 发布/更新线上应用说明（给下次会话的 AI 助手）

## 目标应用（已存在，勿新建）

- **applicationId: `wbapp_25jmKgPG9pW6Mx4K5LxZTk`**
- 应用名: 任务番茄钟
- 保留域名: `https://task-pomodoro.app.workbuddy.host`（已绑定云服务，数据库里有用户数据，**绝不能新建应用**）
- 云服务: 已激活（endpoint 即保留域名，publicConfig 里带 publishableKey）

## 发布步骤

1. 用户在新对话里提出「把行动支持系统发布/更新到线上」。
2. 调用 `workbuddy_sites_deploy`，参数：
   - `directory`: 本仓库根目录（即本文件所在目录）
   - `appId`: `wbapp_25jmKgPG9pW6Mx4K5LxZTk`
   - `userAskedToPublish: true`（用户当轮明确说了发布）
   - `domainPrefix`: `task-pomodoro`
3. **验证返回的 shareLink 必须是 `https://task-pomodoro.app.workbuddy.host/...`（或至少不是 `task-pomodoro-02039` 这类带数字后缀的新域名）。** 如果返回了带后缀的新域名，说明路由又创建了一个新应用——立即停止，不要连续重试（每次重试都会反复发到同一个错误沙盒），向用户如实说明，并参考下面的「事故记录」。
4. 本目录下的 `.wbapp_25jmKgPG9pW6Mx4K5LxZTk.genie` 标记和 `.workbuddy/applications.yaml` 已经指向本目录 + 旧应用，**不要删除或改写它们**。

## 事故记录（2026-11-08，为什么有这段）

在会话 `2026-11-08-10-42-45` 中发布时，目录里的 genie 标记还是从 GitHub 克隆来的旧内容（localDir 指向另一台机器的路径 `C:\Users\Administrator\WorkBuddy\2026-10-29-14-52-27`，与本机不匹配），发布工具因此**新建了一个应用** `wbapp_bi2Mz8OZJn5bi6tHDBfEqz`（域名 `task-pomodoro-02039.app.workbuddy.host`，无云服务，无法登录，是个空壳）。

此后在同一会话内尝试了：改写本地 genie 标记（仓库内/工作区根）、换全新目录发布、往 `.workbuddy/applications.yaml` 注册旧应用、`workbuddy_cloud_service` activate(reuse) 旧应用后再带 appId 发布——**全部无效**，发布路由被会话级沙盒绑定锁死，总是发到新应用。结论：会话内无法纠正，必须换一个全新会话发布。

那个空壳新应用 `wbapp_bi2Mz8OZJn5bi6tHDBfEqz` 已提醒用户在「设置—数据管理—应用」中删除。

## 数据库迁移记录（已在线上旧应用库执行，均为增量、向后兼容）

- 2026-11-08: `tasks` + `shelved`/`revived_at`；`subtasks` + `bonus_applied`；`user_profiles` + `today_picks`；`abc_records` + `review`
- 旧版代码（线上正在跑的）不认识这些新列，不受影响。

## 验证发布成功

线上首页的赚分规则应包含「额外奖励：今日三件事内完成 +50%」字样；心理页 → ABC 记录的每条记录右上应有「复盘」按钮。
