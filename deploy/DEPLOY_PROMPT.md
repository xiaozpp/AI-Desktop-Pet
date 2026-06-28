# Neuro 桌宠后端部署提示词（给 zcode 用）

## 你的任务

把 Neuro 桌宠后端部署到本机 k3d 集群，让 `http://www.aipanni.com/neuro/verify` 能返回 `{"valid":false}`。前端 exe 已经打好了，朋友只要填这个地址就能用。

## 背景

- 项目：D:\work\desktop-pet（Neuro AI 桌宠，FastAPI + ChromaDB + LLM/TTS/STT）
- 部署体系：D:\work\aipanni-deploy（中央编排，所有业务跑在 k3d-downstream-1 集群，参考 lhs/diaocha 模式）
- 前端 exe 已打包：D:\work\desktop-pet\frontend\release\Neuro桌宠 Setup 0.1.0.exe
- 用路径模式 `www.aipanni.com/neuro/*`（不用加 DNS，和 lhs/audit 一样）

## 当前状态（已完成，不要重复）

| 步骤 | 状态 |
|---|---|
| namespace neuro | ✅ 已建 |
| secret neuro-secret（12 个 API key from backend/.env）| ✅ 已建 |
| PVC neuro-data（2Gi）| ✅ 已建 |
| Deployment/Service/Ingress | ✅ 已 apply（路径模式 www.aipanni.com/neuro, rewrite-target /$2, imagePullPolicy Never, WebSocket timeout 3600）|
| `curl http://www.aipanni.com/neuro/verify` | HTTP 502（路由通，pod 没镜像）|

## 你要做的

### 1. 构建并推送后端镜像

```bash
cd D:\work\desktop-pet\backend
docker build -t 127.0.0.1:5001/neuro/backend:0.1.0 .
docker push 127.0.0.1:5001/neuro/backend:0.1.0
```

**注意**：
- chromadb 依赖很大，pip install 慢，build 可能要 15-20 分钟，正常
- 本地 registry 跑在 0.0.0.0:5001（docker 容器 `registry`），push 直接成功
- Dockerfile 在 `D:\work\desktop-pet\backend\Dockerfile`（多阶段，python:3.13-slim，不含 .env）

### 2. 重启 deployment 拉新镜像

```bash
kubectl --context k3d-downstream-1 -n neuro rollout restart deploy/neuro-backend
```

**注意**：manifests.yaml 里 `imagePullPolicy: Never`，所以必须先 push 再 restart。

### 3. 等 pod Ready

```bash
kubectl --context k3d-downstream-1 -n neuro wait pod -l app=neuro-backend --for=condition=Ready --timeout=180s
kubectl --context k3d-downstream-1 -n neuro get pods
```

### 4. 验证（必须全过）

```bash
# 健康检查
curl -s -w "\nHTTP %{http_code}\n" http://www.aipanni.com/neuro/verify
# 期望：{"valid":false} + HTTP 200

# 注册
curl -s -X POST http://www.aipanni.com/neuro/register \
  -H "Content-Type: application/json" \
  -d '{"username":"smoketest","password":"123456"}'
# 期望：{"user_id":"...","username":"smoketest","token":"..."}

# WebSocket（可选，手动测）
# wscat -c "ws://www.aipanni.com/neuro/ws?token=<上面返回的token>"
```

## 关键文件

| 文件 | 作用 |
|---|---|
| `D:\work\desktop-pet\backend\Dockerfile` | 镜像构建（多阶段，不含 .env）|
| `D:\work\desktop-pet\backend\.env` | API Key（LLM/Vision/SiliconFlow/DashScope），**不要打印内容**，secret 已从此文件生成 |
| `D:\work\aipanni-deploy\k8s\neuro\manifests.yaml` | k8s 清单（namespace/configmap/pvc/deployment/service/ingress）|
| `D:\work\desktop-pet\deploy\README.md` | 完整部署文档 |

## k8s 清单关键配置（已在 manifests.yaml，不用改）

- image: `127.0.0.1:5001/neuro/backend:0.1.0`
- imagePullPolicy: `Never`（本地 registry，不拉远程）
- envFrom: configMapRef(neuro-backend-config) + secretRef(neuro-secret)
- NEURO_DATA_DIR: `/app/data`（PVC 挂载，存 ChromaDB + facts）
- Ingress: host `www.aipanni.com`, path `/neuro(/|$)(.*)`, rewrite-target `/$2`
- WebSocket: proxy-read/send-timeout 3600s, proxy-buffering off
- 健康探针: httpGet `/verify` port 8000

## 集群信息

- 集群上下文：`k3d-downstream-1`
- 入口：panni-proxy(docker :80) → k3d ingress-nginx(192.168.65.254:9180) → 各 namespace service
- 本地 registry：docker 容器 `registry`，0.0.0.0:5001
- `www.aipanni.com` 已解析到公网 43.135.123.42，公网服务器反代到本地 panni-proxy
- 本机 hosts 已有 `127.0.0.1 www.aipanni.com`（本机自测用）

## 如果 build 失败

常见坑：
1. **chromadb 装不上**：requirements.txt 里有 `chromadb>=0.4.14`，实际装 1.5.x。确保 Dockerfile 的 builder 阶段完整跑 `pip install -r requirements.txt`。
2. **pyautogui 在容器里报错**：Dockerfile 用 `python:3.13-slim`，pyautogui import 时可能缺 X11 依赖。但后端只在 `tools.py` 的 `capture_screen_base64` 用到，运行时若没屏幕截图需求不会触发。如果 import 失败导致启动崩，在 Dockerfile 加 `RUN apt-get update && apt-get install -y scrot python3-tk python3-dev`。
3. **.env 不在镜像里**：这是设计，API Key 经 k8s Secret 注入，不在镜像里。secret 已从 .env 生成。

## 如果 pod 起不来

```bash
# 看 pod 日志
kubectl --context k3d-downstream-1 -n neuro logs deploy/neuro-backend --tail=50

# 看 pod 事件
kubectl --context k3d-downstream-1 -n neuro describe pod -l app=neuro-backend
```

常见：
- `ErrImageNeverPull`：镜像没 push 到 registry，先 `docker push 127.0.0.1:5001/neuro/backend:0.1.0`
- `CrashLoopBackOff`：看日志，多半是 import 错误或 secret 没注入。检查 `kubectl get secret neuro-secret -n neuro` 是否存在且 DATA=12

## 如果 /verify 返回非 200

- 502：pod 没起来，看 pod 状态
- 404：ingress path 没匹配，检查 `kubectl get ingress -n neuro`
- 503：service 没找到后端 pod，检查 pod labels 和 service selector

## 完成标准

1. `curl http://www.aipanni.com/neuro/verify` 返回 `{"valid":false}` + HTTP 200
2. `curl -X POST http://www.aipanni.com/neuro/register ...` 能注册返回 token
3. pod Running 且 READY 1/1
4. 把结果告诉我（用户），我（用户）会用前端 exe 连这个地址做端到端验证

## 不要做的事

- 不要打印 .env 内容
- 不要改 manifests.yaml 的 ingress host（保持 www.aipanni.com + /neuro 路径）
- 不要加 DNS（路径模式不需要）
- 不要动其他 namespace（audit/diaocha/lhs/medi/aipanni/ops-stats）
- 不要重新打包前端 exe（已经打好了）
