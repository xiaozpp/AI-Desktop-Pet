# Neuro 后端 Dockerfile
# 多阶段构建：builder 装依赖（利用 pip cache layer），runtime 只复制装好的 site-packages + 源码。
# 镜像不含 .env（AGENTS.md 第1条：不提交 API Key）。Key 经 k8s Secret 注入。
# pin digest 避免 build 时再去 auth.docker.io 解析 tag（本机 IPv6 到 docker hub 不稳）。
FROM python:3.13-slim@sha256:c33f0bc4364a6881bed1ec0cc2665e6c53c87a43e774aaeab88e6f17af105e4f AS builder

WORKDIR /build
# 先复制 requirements 单独装，利用 Docker layer cache：源码改了不用重装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.13-slim@sha256:c33f0bc4364a6881bed1ec0cc2665e6c53c87a43e774aaeab88e6f17af105e4f AS runtime

WORKDIR /app

# 从 builder 复制装好的依赖
COPY --from=builder /install /usr/local

# 复制后端源码（不含 .env、tests、__pycache__）
COPY main.py memory.py services.py config.py tools.py code_monitor.py \
     personas.py auth.py db.py protocol.py presence.py migrate.py ./

# 数据目录：k8s 用 PVC 挂载到 /app/data，config.py 的 Config.DATA_DIR 解析它。
# 开发期 NEURO_DATA_DIR 不设时回落到 %LOCALAPPDATA%\Neuro，容器内无意义，所以生产必须设。
ENV NEURO_DATA_DIR=/app/data

EXPOSE 8000

# host 0.0.0.0 让 Kubernetes Service 能转发进来。
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
