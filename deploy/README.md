# Neuro 桌宠 - 部署与发布

## 架构

```
朋友电脑 (Neuro桌宠.exe)  ←→  panni-proxy(docker:80)  ←→  k3d ingress-nginx  ←→  neuro-backend pod
       Electron 前端                  catch-all 转发              host: neuro.aipanni.com         FastAPI + ChromaDB
       首次填后端地址                                              (k8s/neuro/manifests.yaml)      API Key 在 Secret 里
```

朋友只需要：下载 exe → 双击 → 填 `http://neuro.aipanni.com` → 注册 → 玩。
你负责：部署后端 + 承担 API 流量。

## k8s 清单位置

**主清单在 aipanni-deploy 仓库**（与其他项目统一管理）：
```
D:\work\aipanni-deploy\k8s\neuro\manifests.yaml
```

本目录只放 Dockerfile（镜像构建用）和本文档。

## 第一部分：你部署后端（一次性）

### 1. 构建并推送后端镜像到本地 registry

```bash
cd D:\work\desktop-pet\backend
docker build -t 127.0.0.1:5001/neuro/backend:0.1.0 .
docker push 127.0.0.1:5001/neuro/backend:0.1.0
```

### 2. 创建 namespace + Secret（API Key 不进 git）

```bash
kubectl --context k3d-downstream-1 create namespace neuro
kubectl --context k3d-downstream-1 -n neuro create secret generic neuro-secret \
  --from-env-file=D:/work/desktop-pet/backend/.env
```

### 3. 部署

```bash
kubectl --context k3d-downstream-1 apply -f D:/work/aipanni-deploy/k8s/neuro/manifests.yaml
```

### 4. DNS

不用加 DNS。用路径模式 `www.aipanni.com/neuro/*`，和 lhs(/lhs/)、audit(/audit/) 一样。`www.aipanni.com` 已经解析到公网 43.135.123.42，公网服务器反代到本地 panni-proxy，neuro 走同一条通道。

本机自测也不用改 hosts（www.aipanni.com 已经在 hosts 里指向 127.0.0.1）。

### 5. 验证后端

```bash
kubectl --context k3d-downstream-1 get pods -n neuro
# 等 neuro-backend pod Running

curl http://neuro.aipanni.com/verify
# 应返回 {"valid":false}（200 状态码）
```

## 第二部分：打包前端 exe

### 产物

```
D:\work\desktop-pet\frontend\release\Neuro桌宠 Setup 0.1.0.exe
```

### 重新打包（改了前端代码后）

```bash
cd D:\work\desktop-pet\frontend
npm run dist
```

### 朋友首次启动

1. 双击 `Neuro桌宠 Setup 0.1.0.exe` → 选安装目录 → 安装
2. 桌面出现「Neuro桌宠」快捷方式，双击启动
3. 首次启动弹窗：**"首次使用，请填写 Neuro 后端地址"**
   - 朋友填 `http://www.aipanni.com/neuro`（你给他的地址）
   - 点连接，页面刷新
4. 注册账号
5. 开始用

## 第三部分：发给朋友

把这两个文件发给朋友：
1. `Neuro桌宠 Setup 0.1.0.exe`
2. 一句话：**"装完打开，填这个地址：`http://www.aipanni.com/neuro`，注册个账号就能用"**

## 发版流程（改了后端代码后）

```bash
# 1. 改 tag（递增）
cd D:\work\desktop-pet\backend
docker build -t 127.0.0.1:5001/neuro/backend:0.2.0 .
docker push 127.0.0.1:5001/neuro/backend:0.2.0

# 2. 改 manifests.yaml 里 image tag 为 :0.2.0
# 3. apply + restart
kubectl --context k3d-downstream-1 apply -f D:/work/aipanni-deploy/k8s/neuro/manifests.yaml
kubectl --context k3d-downstream-1 -n neuro rollout restart deploy/neuro-backend
```

## 验证清单

后端部署后，你自己先验证：
- [ ] `curl http://www.aipanni.com/neuro/verify` 返回 `{"valid":false}`
- [ ] `curl -X POST http://www.aipanni.com/neuro/register -H "Content-Type: application/json" -d '{"username":"test","password":"123456"}'` 能注册
- [ ] 打开 exe，填 `http://www.aipanni.com/neuro`，注册，能进主界面
- [ ] 发消息能收到回复（LLM 通）
- [ ] 语音输入能识别（STT 通）
- [ ] AI 能说话（TTS 通）
- [ ] 记忆面板能看到事实/经历（记忆系统通）

## 成本提醒

朋友的对话流量走你的 API Key：
- **DeepSeek（LLM）**：按 token 计费，一次对话约 0.001-0.01 元
- **阿里云百炼（TTS）**：按字符计费
- **SiliconFlow（STT + Embedding）**：按秒/次计费

如果朋友多，建议给每个用户设用量上限（后端可加中间件）。先小范围发给 2-3 个朋友试。

## 故障排查

### 朋友启动后白屏
- 检查后端地址是否填对（`http://www.aipanni.com/neuro`，注意是 http 不是 https）
- 检查后端 pod：`kubectl --context k3d-downstream-1 get pods -n neuro`
- F12 打开开发者工具看 console 报错

### WebSocket 连不上
- ingress 已配 proxy-read/send-timeout 3600s
- panni-proxy 的 nginx 已透传 Upgrade/Connection 头
- 检查 panni-proxy 是否运行：`docker ps | grep panni-proxy`

### 记忆丢失
- 检查 PVC：`kubectl --context k3d-downstream-1 get pvc -n neuro`
- pod 重启后记忆应在（PVC 持久化）

### 更新 API Key
```bash
kubectl --context k3d-downstream-1 -n neuro delete secret neuro-secret
kubectl --context k3d-downstream-1 -n neuro create secret generic neuro-secret \
  --from-env-file=D:/work/desktop-pet/backend/.env
kubectl --context k3d-downstream-1 -n neuro rollout restart deploy/neuro-backend
```
