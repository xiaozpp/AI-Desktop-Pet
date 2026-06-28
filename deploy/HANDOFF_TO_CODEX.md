# Neuro 后端部署 — 交接给 codex

## 目标

把 Neuro 桌宠后端部署到本机 k3d 集群，让 `curl http://www.aipanni.com/neuro/verify` 返回 `{"valid":false}` + HTTP 200，并能 `/register` 拿到 token。

## 背景

- 项目：`D:\work\desktop-pet`（FastAPI + ChromaDB + LLM/TTS/STT）
- 部署编排：`D:\work\aipanni-deploy\k8s\neuro\manifests.yaml`
- k3d 集群上下文：`k3d-downstream-1`，namespace `neuro`
- 本地 registry：docker 容器 `registry`，宿主映射 `0.0.0.0:5001`→容器内 `5000`
- 原 DEPLOY_PROMPT.md 说"imagePullPolicy: Never 直接拉本地"——**这个前提在 k3d 下不成立，整套部署此前从未真正成功过**

## 已有人(前一个 agent)做过的诊断和修复，不要重复

### 根因链（已全部摸清）

原 `DEPLOY_PROMPT.md` 的部署设计在 k3d 下有三处必然失败：

1. **镜像拉不到**：`imagePullPolicy: Never` + image `127.0.0.1:5001/...`。k3d 节点是独立 docker 容器（在 `k3d-downstream-1` 网络，网段 `172.23.0.x`），它的 `127.0.0.1` 指向自己，连不到宿主的 registry。`Never` 又禁止去拉。→ 永远 `ErrImageNeverPull`。

2. **containerd 拒收 HTTP registry**：即使节点能连到 registry，containerd 默认走 HTTPS，对 HTTP registry 报 `http: server gave HTTP response to HTTPS client`。

3. **pyautogui import 崩**：`backend/tools.py` 顶层 `import pyautogui`，`mouseinfo` 在模块顶层执行 `Display(os.environ['DISPLAY'])`，容器里没 `DISPLAY` 环境变量 → `KeyError: 'DISPLAY'`，整个后端启动崩溃。设 `DISPLAY=:99` 也不行，会变成 `DisplayConnectionError`（连不上 X server）。

### 已做的文件/环境改动（接手前请先核对现状）

**A. `D:\work\aipanni-deploy\k8s\neuro\manifests.yaml`** — 已改：
```yaml
image: registry:5000/neuro/backend:0.1.0      # 原 127.0.0.1:5001
imagePullPolicy: IfNotPresent                  # 原 Never
```

**B. registry 容器已加入 k3d 网络**（动态，重启 docker 会丢，需重连）：
```
docker network connect k3d-downstream-1 registry
# 之后 k3d 节点用 registry:5000 可达，已验证 wget 返回 {}
```

**C. 两个 k3d 节点已配 containerd insecure registry**（动态，节点容器重建会丢）：
- `k3d-downstream-1-server-0` 和 `k3d-downstream-1-agent-0`
- 文件：`/var/lib/rancher/k3s/agent/etc/containerd/certs.d/registry:5000/hosts.toml`
- 内容：
  ```toml
  server = "http://registry:5000"
  [host."http://registry:5000"]
    capabilities = ["pull", "resolve"]
    skip_verify = true
  ```
- k3s containerd 主 config 已有 `config_path = "/var/lib/rancher/k3s/agent/etc/containerd/certs.d"`，放 hosts.toml 即生效，改完需重启 containerd（`pgrep` 在节点里不存在，可用 `kill $(pidof containerd)` 让 k3s 拉起）。

**D. `D:\work\desktop-pet\backend\Dockerfile`** — 已改：
- base image pin 了 digest 绕过 docker hub 解析：`python:3.13-slim@sha256:c33f0bc4364a6881bed1ec0cc2665e6c53c87a43e774aaeab88e6f17af105e4f`
- runtime 阶段加了 `apt-get install -y --no-install-recommends xvfb`
- 加了 entrypoint 脚本，先 `Xvfb :99 &` 再起 uvicorn（满足 pyautogui import）

### 已验证的事实

- 镜像 `127.0.0.1:5001/neuro/backend:0.1.0` 旧版（无 xvfb）已 push 成功，registry 里有。
- 用旧镜像 + 修复 A/B/C 后，pod 成功拉到镜像，状态从 `ImagePullBackOff` → `Running`，但因 pyautogui DISPLAY 崩溃而 CrashLoop。
- 宿主到 registry 健康：`curl http://127.0.0.1:5001/v2/` 返回 200。

## 当前唯一卡点

**重新 build 新镜像（带 xvfb 修复）失败**：本机 IPv6 到 `auth.docker.io` 超时：
```
failed to fetch oauth token: Post "https://auth.docker.io/token": dial tcp [2a03:2880:f129:83:face:b00c:0:25de]:443: connectex: ... did not properly respond
```
即使 `--pull=false`，BuildKit 解析 base image tag 仍要拿 oauth token。已 pin digest（Dockerfile 里 `@sha256:c33f0bc4...`）试图绕过解析，但**这条还没验证**（build 被用户中途取消了）。

## 你要做的

### 1. 先确认环境现状（已做的改动是否还在）
```bash
docker network inspect k3d-downstream-1 --format '{{range .Containers}}{{.Name}} {{end}}'   # 应能看到 registry
docker exec k3d-downstream-1-server-0 cat /var/lib/rancher/k3s/agent/etc/containerd/certs.d/registry:5000/hosts.toml
kubectl --context k3d-downstream-1 -n neuro get pods
```
如果 registry 不在 k3d 网络里：`docker network connect k3d-downstream-1 registry`
如果 hosts.toml 不在：按上面 C 重新写入并重启节点 containerd。

### 2. 把 build 跑通（核心任务）
推荐顺序试：
1. 直接用已 pin digest 的 Dockerfile build：
   ```
   cd D:\work\desktop-pet\backend
   docker build -t 127.0.0.1:5001/neuro/backend:0.1.0 .
   ```
2. 若仍卡 docker hub 鉴权，强制走 IPv4 / 关 IPv6：给 docker daemon 加 `"iptables": true` 或在 hosts 把 `auth.docker.io`/`registry-1.docker.io` 指向 IPv4；也可配国内镜像加速 `registry-mirrors`。
3. 若以上都麻烦，**最低成本替代**：不动 base image 镜像源，改用本地已缓存的 `python:3.13-slim`（第一次成功 build 时已拉到本地）。BuildKit 离线可用 digest pin + 禁网络：`docker build --network=none`（pip install 阶段会失败，不推荐）；或导出本地基础镜像再 `FROM` 它。
4. 极端兜底：xvfb 也可以不装，改用更轻的修法——把 `backend/tools.py` 的 `import pyautogui` 改成**惰性 import**（移进 `capture_screen_base64` 函数体内），这样容器启动不触发它。但这会改后端源码（需确认 AGENTS.md 是否允许；那条边界是"不重写系统"，惰性化一行 import 属于最小修复，可接受）。

### 3. build 成功后（固定三步）
```bash
docker push 127.0.0.1:5001/neuro/backend:0.1.0
kubectl --context k3d-downstream-1 -n neuro rollout restart deploy/neuro-backend
kubectl --context k3d-downstream-1 -n neuro wait pod -l app=neuro-backend --for=condition=Ready --timeout=180s
```

### 4. 验证（必须全过）
```bash
curl -s -w "\nHTTP %{http_code}\n" http://www.aipanni.com/neuro/verify
# 期望 {"valid":false} + HTTP 200

curl -s -X POST http://www.aipanni.com/neuro/register \
  -H "Content-Type: application/json" \
  -d '{"username":"smoketest","password":"123456"}'
# 期望 {"user_id":"...","username":"smoketest","token":"..."}
```
如果 pod Running 但 /verify 非 200，看日志定位：
```bash
kubectl --context k3d-downstream-1 -n neuro logs deploy/neuro-backend --tail=50
```

## 持久化注意（重要）

改动 A（manifests）已落盘，持久。
改动 B/C（registry 联网、containerd hosts.toml）是**运行时动态改的，docker 或 k3d 重启后会丢**。如果想让它持久化：
- B：给 registry 容器加 `--network k3d-downstream-1` 重创，或在 `D:\work\aipanni-deploy` 的 docker-compose 里把 registry 接入。
- C：用 k3d 的 `--registry-create` 重建 cluster 内嵌 registry（最干净，但会重建 cluster），或把 hosts.toml 写进节点的持久化卷。
若你选择"先跑通交付"而非"持久化"，跑通后请明确告知用户哪些是临时改动，下次重启要重做。

## 边界（不要违反）

- 不打印 `.env` / API Key 内容。
- 不改 ingress host（保持 `www.aipanni.com` + `/neuro` 路径）。
- 不动其他 namespace（audit/diaocha/lhs/medi/aipanni/ops-stats）。
- 不重新打包前端 exe（已打好）。
- AGENTS.md 第8条：不重写记忆系统；惰性化 pyautogui import 属最小修复，可接受。

## 完成标准

1. `curl http://www.aipanni.com/neuro/verify` → `{"valid":false}` + 200
2. `/register` 能返回 token
3. pod Running 且 READY 1/1
4. 告诉用户结果，用户会用前端 exe 连这个地址做端到端验证
