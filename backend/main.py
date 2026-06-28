import asyncio
import time
import datetime
import uuid
import sqlite3
import sys
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from services import AIService
from memory import MemorySystem
from tools import ToolBox
from config import Config
import code_monitor
import personas
import auth
import db
from protocol import image_mime_type, normalize_brain_result, parse_client_packet
from presence import initial_care_delay
from turns import make_generation_send

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "null",  # Packaged Electron pages loaded from file:// have an opaque origin.
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# 启动时把旧源码目录的数据一次性迁移到持久数据目录（幂等，失败不阻断启动）。
# 必须在 db.init_db() 之前，否则空 users.db 会被先创建，导致旧库数据无法迁入。
try:
    import migrate as _migrate
    _migrate.migrate_legacy_data()
except Exception as _e:
    print(f"⚠️ 数据目录迁移失败（不影响启动）: {_e}")

db.init_db()  # 启动时建 users 表（init_db 内部确保数据目录存在）

# === 账号系统：注册/登录 HTTP 端点 ===
class Credentials(BaseModel):
    username: str
    password: str


@app.post("/register")
def register(creds: Credentials):
    """注册：用户名+密码 → 返回 token"""
    username = creds.username.strip()
    if not auth.is_password_acceptable(creds.password):
        raise HTTPException(400, "密码至少 6 位且不能超过 72 字节")
    if not username or len(username) > 64:
        raise HTTPException(400, "用户名不能为空且不能超过 64 个字符")
    user_id = uuid.uuid4().hex
    try:
        db.create_user(user_id, username, auth.hash_password(creds.password), int(time.time()))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "用户名已存在")
    return {"user_id": user_id, "username": username, "token": auth.create_access_token(user_id, username)}


@app.post("/login")
def login(creds: Credentials):
    """登录：校验密码 → 返回 token"""
    username = creds.username.strip()
    if not username or len(username) > 64 or not auth.is_password_acceptable(creds.password):
        raise HTTPException(401, "用户名或密码错误")
    row = db.get_user_by_username(username)
    if not row or not auth.verify_password(creds.password, row["password_hash"]):
        raise HTTPException(401, "用户名或密码错误")
    return {"user_id": row["user_id"], "username": row["username"], "token": auth.create_access_token(row["user_id"], row["username"])}


@app.get("/verify")
def verify_token(authorization: str | None = Header(None)):
    """校验 token 是否有效（前端启动时用）"""
    if not authorization or not authorization.startswith("Bearer "):
        return {"valid": False}
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = auth.decode_token(token)
        return {"valid": True, "user_id": payload["sub"], "username": payload["username"]}
    except Exception:
        return {"valid": False}

class NeuroBrain:
    def __init__(self, user_id: str = "guest"):
        self.user_id = user_id
        now = time.time()
        persisted_last_seen = db.get_last_seen(user_id)
        # 状态机
        self.state = "idle"          # idle, thinking, speaking
        self.last_interaction = now
        self.last_user_input_time = persisted_last_seen or now
        self.previous_user_input_time = self.last_user_input_time
        self.boredom_threshold = 45 * 60
        self.is_dnd_mode = False     # 勿扰模式
        self.current_threshold = initial_care_delay(persisted_last_seen, now)
        self.max_threshold = 6 * 60 * 60
        self.memory = MemorySystem(user_id)      # 按账号隔离记忆
        self.history = []            # 短期对话历史 (滑动窗口)
        # 编程监控：缓存最新状态，供状态推送读取
        self.last_code_status = code_monitor.poll()
        self.persona_id = personas.load_user_persona(user_id)

    def update_activity(self):

        self.last_interaction = time.time()
    def reset_boredom_time(self):
        self.previous_user_input_time = self.last_user_input_time
        self.last_user_input_time = int(time.time())
        db.set_last_seen(self.user_id, self.last_user_input_time)
        self.current_threshold=self.boredom_threshold
        self.update_activity()
    def increase_boredom_time(self):
        self.current_threshold=max(self.boredom_threshold, self.current_threshold*2)
        if(self.current_threshold>self.max_threshold):
            self.current_threshold=self.max_threshold
        print(f"下次主动对话将在{self.current_threshold}s后进行")

    def set_persona(self, persona_id: str | None):
        self.persona_id = personas.save_user_persona(self.user_id, persona_id)
        return personas.get_persona_catalog_payload(self.persona_id)

    def persona_payload(self):
        return personas.get_persona_catalog_payload(self.persona_id)

    async def build_system_prompt(self,user_input:str=None):
        now_str = datetime.datetime.now().strftime("%Y年%m月%d日 %H:%M")
        known_facts = self.memory.get_fact_context()
        longmemory = await self.memory.get_longmemory_context(user_input)
        persona_prompt = personas.build_persona_prompt(self.persona_id)
        # 计算距上次互动时长，让"想念"更真实
        last_active_ts = self.last_user_input_time if user_input is None else self.previous_user_input_time
        try:
            gap_str = self._humanize_gap(time.time() - last_active_ts)
        except Exception:
            gap_str = "未知"

        return {
            "role": "system",
            "content": f"""
            你叫 Neuro，一个可爱毒舌但内心很在乎主人的 AI 桌宠。
            当前时间: {now_str}。
            距离主人上次理你: {gap_str}。

            {persona_prompt}

            【你的记忆——这是你和主人之间真实的过往，请像真正的朋友那样使用它】
            你知道关于主人的事（事实/喜好/习惯，务必记住并在合适时自然提起）:
            {known_facts}

            {longmemory}

            【关于记忆的使用方式——非常重要】
            1. 你【记得】上面这些事，就像真正的朋友记得你们的过往。在对话中【主动、自然地】引用它们。
               - 例：主人提及时尚 → 你想起"上次你说喜欢某风格"
               - 例：主人很久没来 → 你说"你上次说要减肥，最近怎么样了"
               - 例：主人提到某个名字 → 你说"哦就是上次那个XX啊"
            2. 绝不装作忘记已知事实。如果主人问"你还记得吗"，结合记忆回答。
            3. 如果记忆和主人现在说的矛盾，要指出来："咦，你上次不是说XXX吗？怎么变了？"
               （如果事实区有【事实冲突】提示，必须在本次回复中自然询问，确认哪个对）
            4. 不要生硬地罗列记忆，要像聊天那样不经意地融入。
            5. 隔几天没见，可以主动提起旧事表达想念。
               （主动发言时若带了【突然想起的往事】，那是你很久没想起但重要的事，自然提起它）

            请针对用户的输入，返回一个 JSON 对象（严格遵守 JSON 格式）：
            {{
                "thought": "内心独白。分析用户意图，并思考：这次对话有没有值得记住的新信息？记忆里有没有可以自然引用的旧事？",
                "reply": "给主人的回复。口语化、符合人设，自然地融入你对他的记忆（让主人感受到'她记得我'）。",
                "emotion": "happy/neutral/bored/angry/sad/shy/love",
                "memory_operation": {{
                    "new_facts": {{ "key": "value" }} 或 null,
                    "new_episode": "这次对话的事件摘要（用于未来回忆）" 或 null,
                    "is_silence_requested": true/false
                }}
            }}

            规则：
            1. 只有当用户陈述了【新的、值得长期记住的】事实（喜好/习惯/重要人物/重要事件）才更新 new_facts。闲聊不要记。
            2. 每次有意义的对话都应在 new_episode 存一句话摘要（如"主人今天说他最近在学吉他"），这是未来回忆的素材。
            3. 如果用户说胡话（如我是秦始皇），在 reply 里拆穿，不要更新记忆。
            4. 让主人感觉到：你不是第一次见他，你们有共同的回忆。
            """
        }

    def _humanize_gap(self, seconds: float) -> str:
        """把秒数转成人类可读的时长"""
        if seconds < 60: return "刚刚"
        if seconds < 3600: return f"{int(seconds//60)} 分钟前"
        if seconds < 86400: return f"{int(seconds//3600)} 小时前"
        return f"{int(seconds//86400)} 天前"

# === 用户会话管理：一账号一连接，避免并发数据竞争 ===
import jwt as _jwt

_active_brains: dict[str, "NeuroBrain"] = {}   # user_id -> brain 实例
_active_conns: dict[str, WebSocket] = {}        # user_id -> 当前活跃 WS（用于踢旧连接）
_brains_lock = asyncio.Lock()


async def get_or_create_brain(user_id: str) -> "NeuroBrain":
    """获取或创建某用户的 brain（线程安全）。一账号一 brain 实例。"""
    async with _brains_lock:
        if user_id not in _active_brains:
            _active_brains[user_id] = NeuroBrain(user_id)
            print(f"🧠 为用户 {user_id} 创建 brain")
        return _active_brains[user_id]


def _kick_old_connection(user_id: str, new_ws: WebSocket):
    """如果该用户已有活跃连接，踢掉旧的（异地登录场景）"""
    old = _active_conns.get(user_id)
    if old and old is not new_ws:
        try:
            asyncio.create_task(old.close(code=4001, reason="账号在其他地方登录"))
            print(f"🚪 踢掉用户 {user_id} 的旧连接")
        except Exception:
            pass


# === WebSocket 路由（带鉴权）===
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(None)):
    # === 握手前校验 token ===
    if not token:
        await websocket.close(code=1008, reason="缺少 token")
        return
    try:
        payload = auth.decode_token(token)
        user_id = payload["sub"]
        username = payload["username"]
    except _jwt.PyJWTError:
        await websocket.close(code=1008, reason="token 无效或已过期")
        return

    # === 一账号一连接：踢旧 ===
    _kick_old_connection(user_id, websocket)

    await websocket.accept()
    _active_conns[user_id] = websocket
    print(f"⚡ 用户 {username} ({user_id}) 连接建立")

    brain = await get_or_create_brain(user_id)

    # 定义发送助手
    async def send_to_frontend(type_str, payload):
        try:
            await websocket.send_json({"type": type_str, "payload": payload})
        except Exception:
            pass

    turn_generation = 0
    turn_task = None
    transcribe_generation = 0
    transcribe_task = None

    def is_current_generation(value):
        return value == turn_generation

    def is_current_transcribe(value):
        return value == transcribe_generation

    def cancel_turn():
        if turn_task and not turn_task.done():
            print(f"⏹️ 取消上一轮对话 (gen={turn_generation})")
            turn_task.cancel()

    def cancel_transcribe():
        if transcribe_task and not transcribe_task.done():
            transcribe_task.cancel()

    async def run_text_turn(generation, text, image_b64=None, image_mime=None):
        guarded_send = make_generation_send(send_to_frontend, generation, is_current_generation)
        await handle_user_input(
            text,
            guarded_send,
            brain,
            image_b64=image_b64,
            image_mime=image_mime,
            is_current=lambda: is_current_generation(generation),
        )

    async def run_audio_turn(generation, audio_b64, audio_format):
        guarded_send = make_generation_send(send_to_frontend, generation, is_current_generation)
        text = await AIService.speech_to_text(audio_b64, audio_format)
        if text and is_current_generation(generation):
            await guarded_send("text_input", {"text": text})
            await handle_user_input(
                text,
                guarded_send,
                brain,
                is_current=lambda: is_current_generation(generation),
            )

    async def run_voice_transcribe(generation, audio_b64, audio_format):
        guarded_send = make_generation_send(send_to_frontend, generation, is_current_transcribe)
        text = await AIService.speech_to_text(audio_b64, audio_format)
        if text:
            await guarded_send("voice_transcript", {"text": text})

    # 启动主动意识循环 (后台任务)
    loop_task = asyncio.create_task(game_loop(send_to_frontend, brain))
    # 启动编程监控循环 (后台任务，每 10s 轮询一次)
    code_task = asyncio.create_task(code_monitor_loop(send_to_frontend, brain))
    await send_to_frontend("persona_state", brain.persona_payload())

    try:
        while True:
            data = await websocket.receive_text()
            try:
                packet_type, payload = parse_client_packet(data)
            except ValueError as exc:
                await send_to_frontend("error", {"info": str(exc)})
                continue

            # 收到消息第一件事：刷新活跃时间
            brain.update_activity()

            if packet_type == "text_input":
                text = payload.get("text", "")
                image_b64 = payload.get("image_base64")
                print(f"💬 收到文字: {text[:60]}")
                turn_generation += 1
                cancel_turn()
                turn_task = asyncio.create_task(run_text_turn(
                    turn_generation,
                    text,
                    image_b64=image_b64,
                    image_mime=payload.get("image_mime"),
                ))

            elif packet_type == "audio_input":
                audio_b64 = payload["audio_base64"]
                turn_generation += 1
                cancel_turn()
                turn_task = asyncio.create_task(
                    run_audio_turn(turn_generation, audio_b64, payload.get("format"))
                )

            elif packet_type == "voice_transcribe":
                audio_b64 = payload["audio_base64"]
                transcribe_generation += 1
                cancel_transcribe()
                transcribe_task = asyncio.create_task(
                    run_voice_transcribe(transcribe_generation, audio_b64, payload.get("format"))
                )

            elif packet_type == "persona_change":
                persona_id = payload["persona_id"]
                payload = brain.set_persona(persona_id)
                await send_to_frontend("persona_state", payload)
                print(f"🎭 persona_change({persona_id}) -> {payload['active_persona_id']}")

            elif packet_type == "interrupt":
                print("🛑 用户打断")
                turn_generation += 1
                cancel_turn()
                brain.state = "idle"
                await send_to_frontend("canceled", {})

    except WebSocketDisconnect:
        print(f"🔌 用户 {username} 连接断开")
    except Exception as e:
        print(f"❌ Main Loop Error: {e}")
    finally:
        loop_task.cancel()
        code_task.cancel()
        cancel_turn()
        cancel_transcribe()
        # 清理活跃连接记录（仅当当前 WS 还是注册的那个时才清，避免误清新连接）
        if _active_conns.get(user_id) is websocket:
            _active_conns.pop(user_id, None)


# === 核心逻辑（全部接收 brain 参数，不再用全局单例）===

async def handle_user_input(
    text: str,
    send_func,
    brain: NeuroBrain,
    image_b64: str | None = None,
    image_mime: str | None = None,
    is_current=None,
):
    """处理用户输入的主流程"""
    if is_current is None:
        is_current = lambda: True
    brain.state = "thinking"
    await send_func("state_update", {"state": "thinking"})
    brain.reset_boredom_time()
    user_time_str = datetime.datetime.now().strftime("[%H:%M:%S]")
    current_image_b64 = image_b64
    current_image_mime = image_mime_type(image_mime)
    vision_keywords = ["看看", "截图", "什么样", "屏幕", "image", "photo"]
    vision_configured = Config.VISION_API_KEY and not Config.VISION_API_KEY.startswith("your-")
    if not current_image_b64 and vision_configured and any(k in text for k in vision_keywords):
        print("📸 检测到视觉关键词，正在截图...")
        current_image_b64 = ToolBox.capture_screen_base64()
    try:
        sys_prompt = await brain.build_system_prompt(text)
        current_msg_block = {
            "role": "user",
            "content": f"{user_time_str} {text}"
        }

        if current_image_b64:
            current_msg_block["content"] += "\n(系统附图：用户上传的图片或当前屏幕截图)"

        messages = [sys_prompt] + brain.history + [current_msg_block]

        print("🧠 主脑思考中...")
        result_json = normalize_brain_result(
            await AIService.chat_with_neuro_brain(
                messages,
                image_base64=current_image_b64,
                image_mime=current_image_mime,
            )
        )
        if not is_current():
            return

        reply = result_json["reply"] or "（发呆中...）"
        emotion = result_json["emotion"]
        mem_op = result_json["memory_operation"]
        # 记忆更新（带本次情绪，存入元数据供未来日记/检索）
        if mem_op:
            await brain.memory.execute_updates(mem_op, emotion=emotion)
            if mem_op.get("is_silence_requested"):
                brain.is_dnd_mode = True
                print("🔕 进入勿扰模式")

        if brain.is_dnd_mode and not mem_op.get("is_silence_requested"):
            brain.is_dnd_mode = False

        # 更新历史
        if current_image_b64:
            text += " [已发送图片]"
        ai_time_str = datetime.datetime.now().strftime("[%H:%M:%S]")
        brain.history.append({
            "role": "user",
            "content": f"{user_time_str} {text}"
        })

        if reply:
            brain.history.append({
                "role": "assistant",
                "content": f"{ai_time_str} {reply}"
            })
        brain.history = brain.history[-10:]  # 滑动窗口

        # 说话
        await send_reply(reply, emotion, send_func, brain, is_current=is_current)

        # 桌宠已回复（可能已询问冲突），消费掉本次的事实冲突提示。
        # 下一轮若又有新冲突才会再次带上，避免反复问同一个。
        conflicts_consumed = brain.memory.consume_fact_conflicts()
        if conflicts_consumed:
            print(f"💡 已消费 {len(conflicts_consumed)} 条事实冲突提示")

    except Exception as e:
        print(f"❌ Handle Error: {e}")
        await send_func("state_update", {"state": "idle"})
    finally:
        if is_current():
            brain.state = "idle"
        brain.update_activity()


async def send_reply(text: str, emotion: str, send_func, brain: NeuroBrain, is_current=None):
    """合成语音并发送"""
    if is_current is None:
        is_current = lambda: True
    brain.state = "speaking"
    estimated_duration = len(text) * 0.25 + 1.0
    brain.last_interaction = time.time() + estimated_duration
    print(f"🔊 准备回复: {text[:60]}")
    audio_b64 = await AIService.text_to_speech(text, emotion)
    if not audio_b64:
        print("⚠️ TTS 返回空，前端将只显示文字无声音")
    if is_current():
        print("📤 发送 audio_chunk 给前端")
        await send_func("audio_chunk", {
            "text": text,
            "audio_base64": audio_b64,
            "audio_format": "audio/ogg",
            "expression": emotion
        })
    else:
        print("⏭️ 本轮已被新指令取代，跳过发送")


async def code_monitor_loop(send_func, brain: NeuroBrain):
    """编程监控循环：每 10s 轮询 Claude Code/Codex 日志，状态变化时推送给前端"""
    print("👁️ 编程监控启动")
    try:
        brain.last_code_status = code_monitor.poll()
        await send_func("code_status", brain.last_code_status)
    except Exception as e:
        print(f"⚠️ 编程监控初始推送失败: {e}")

    while True:
        await asyncio.sleep(10)
        try:
            new_status = code_monitor.poll()
            old = brain.last_code_status
            if new_status.get("state") != old.get("state") or new_status.get("tool") != old.get("tool"):
                brain.last_code_status = new_status
                print(f"🔧 编程状态变化: {old.get('state')}/{old.get('tool')} → {new_status.get('state')}/{new_status.get('tool')}")
                await send_func("code_status", new_status)
            else:
                if new_status.get("duration_min", 0) != old.get("duration_min", 0):
                    brain.last_code_status = new_status
                    await send_func("code_status", new_status)
        except Exception as e:
            print(f"⚠️ 编程监控轮询失败: {e}")


async def game_loop(send_func, brain: NeuroBrain):
    """自主意识循环"""
    print("🔄 自主意识启动")

    while True:
        await asyncio.sleep(1)
        now = time.time()

        if (not brain.is_dnd_mode) and \
           (brain.state == "idle") and \
           (now - brain.last_interaction > brain.current_threshold):

            print("🥱 触发主动发言")
            brain.increase_boredom_time()
            brain.state = "thinking"
            await send_func("state_update", {"state": "thinking"})
            brain.update_activity()

            try:
                sys_prompt = await brain.build_system_prompt()
                last_active_str = datetime.datetime.fromtimestamp(brain.last_user_input_time).strftime("%H:%M:%S")
                trigger_content = f"""
                (系统自动触发指令：
                1. 用户当前处于静默状态。
                2. 用户最后一次发言时间是：{last_active_str}。
                3. 请对比【当前系统时间】与【最后发言时间】：
                   - 如果时间差很短（连续对话）：请顺着上文继续聊，不要打断话题。或者如果当前话题无聊，可以主动找话题
                   - 如果时间差很长（长久冷落）：可以参考【记忆信息】里的随机往事，或者吐槽太安静了，或者主动找话题聊天。

                必须返回 JSON。)
                """

                msgs = [sys_prompt] + brain.history + [{
                    "role": "user",
                    "content": trigger_content
                }]

                print("🧠 主脑主动思考中...")
                result_json = normalize_brain_result(
                    await AIService.chat_with_neuro_brain(msgs)
                )

                reply = result_json["reply"]
                emotion = result_json["emotion"]

                if reply:
                    ai_time_str = datetime.datetime.now().strftime("[%H:%M:%S]")
                    brain.history.append({
                        "role": "assistant",
                        "content": f"{ai_time_str} {reply}"
                    })
                    brain.history = brain.history[-10:]

                    await send_reply(reply, emotion, send_func, brain)
                    brain.state = "idle"
                    await send_func("state_update", {"state": "idle"})
                else:
                    print("⚠️ 主动发言生成了空内容")
                    brain.state = "idle"
                    await send_func("state_update", {"state": "idle"})

            except Exception as e:
                print(f"❌ 主动发言失败: {e}")
                brain.state = "idle"
                await send_func("state_update", {"state": "idle"})


def _require_user(authorization: str | None) -> str:
    """从 Bearer token 解出 user_id。失败抛 HTTPException(401)。
    所有记忆/用户数据接口共用，保证只操作已验证用户自己的数据。"""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "未登录")
    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = auth.decode_token(token)
        return payload["sub"]
    except Exception:
        raise HTTPException(401, "token 无效或已过期")


async def _get_memory_for(authorization: str | None) -> "MemorySystem":
    """获取已验证用户的 MemorySystem 实例（复用 brain 缓存，避免重复初始化 Chroma）。"""
    user_id = _require_user(authorization)
    brain = await get_or_create_brain(user_id)
    return brain.memory


# === 记忆管理 API（架构文档第 8 节：用户控制）===
# 让用户查看/搜索/忘记/导出/清空自己的记忆。所有接口基于已验证 user_id，
# 不接受客户端传入的文件名/collection 名/任意路径。

@app.get("/memory/facts")
async def memory_list_facts(authorization: str | None = Header(None)):
    """列出当前用户的所有事实（喜好/习惯/重要人物）。"""
    mem = await _get_memory_for(authorization)
    return {"facts": mem.list_facts()}


@app.get("/memory/episodes")
async def memory_list_episodes(
    authorization: str | None = Header(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    topic: str | None = Query(None),
):
    """列出/搜索经历，按时间倒序。可按 topic 过滤。"""
    mem = await _get_memory_for(authorization)
    return {"episodes": mem.list_episodes(limit=limit, offset=offset, topic=topic), "limit": limit, "offset": offset}


@app.delete("/memory/episodes/{episode_id}")
async def memory_delete_episode(episode_id: str, authorization: str | None = Header(None)):
    """忘记单条经历。"""
    mem = await _get_memory_for(authorization)
    ok = mem.delete_episode(episode_id)
    if not ok:
        raise HTTPException(404, "记忆不存在或已删除")
    return {"deleted": episode_id}


@app.get("/memory/export")
async def memory_export(authorization: str | None = Header(None)):
    """导出当前用户全部记忆为 JSON（事实 + 经历）。"""
    mem = await _get_memory_for(authorization)
    return mem.export_all()


@app.delete("/memory/all")
async def memory_clear_all(authorization: str | None = Header(None), confirm: str = Query(None)):
    """清空当前用户全部记忆。需显式 confirm=yes 二次确认，防误触。"""
    if confirm != "yes":
        raise HTTPException(400, "需显式确认：传 confirm=yes 才能清空全部记忆")
    mem = await _get_memory_for(authorization)
    return mem.clear_all()


if __name__ == "__main__":
    import uvicorn
    # 启动服务器，监听 8000 端口
    uvicorn.run(app, host="127.0.0.1", port=8000)
