import { useLayoutEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import * as PIXI from 'pixi.js'
import { Live2DModel } from 'pixi-live2d-display/cubism4'
import { pickClickReaction } from '../../clickReactions'

// 将 PIXI 暴露到 window 上
window.PIXI = PIXI;

const Live2DDisplay = forwardRef((props, ref) => {
  const pixiContainerRef = useRef(null)
  const appRef = useRef(null)
  const modelRef = useRef(null)
  const movementDirectionRef = useRef('right')
  // 点击反应：当前激活的反应及其参数过渡状态。
  const clickReactionRef = useRef(null)

  // 表情映射对象，使用中文作为 key，值对应 PinkFox 的参数 ID (key2~key17)
  const EXPRESSIONS = {
    '吐舌': 'key2',
    '黑脸': 'key3',
    '眼泪': 'key4',
    '脸红': 'key5',
    'nn眼': 'key6',
    '生气瘪嘴': 'key7',
    '死鱼眼': 'key8',
    '猫猫眼': 'key9',
    '咪咪眼': 'key10',
    '嘟嘴': 'key11',
    '钱钱眼': 'key12',
    '爱心': 'key16',
    '泪眼': 'key17'
  }

  // LLM 英文 emotion → 中文表情映射（解决前后端情绪断层）
  // 后端 system prompt 输出: happy/neutral/bored/angry/dizzy 等
  const EMOTION_MAP = {
    'happy': '咪咪眼',
    'neutral': '猫猫眼',
    'bored': '死鱼眼',
    'angry': '生气瘪嘴',
    'dizzy': '黑脸',
    'sad': '泪眼',
    'love': '爱心',
    'shy': '脸红',
    'surprised': '嘟嘴'
  }

  const resetExpressionParams = () => {
    const core = modelRef.current?.internalModel?.coreModel
    if (!core) return

    Object.values(EXPRESSIONS).forEach((expressionId) => {
      try {
        core.setParameterValueById(expressionId, 0)
      } catch {
        /* Some models may not expose every expression parameter. */
      }
    })
  }

  // 新增：随机表情方法
  // const randomExpression = () => {
  //   const expressions = Object.keys(EXPRESSIONS)
  //   const randomIndex = Math.floor(Math.random() * expressions.length)
  //   return expressions[randomIndex]
  // }

  // 调整模型大小和位置的函数
  // const adjustModel = (app, model) => {
  //   if (!app || !model) return;
    
  //   const scale = Math.min(
  //     app.view.width / model.width * 1.8,
  //     app.view.height / model.height * 1.8
  //   );
  //   model.scale.set(scale);
    
  //   model.x = app.view.width / 2;
  //   model.y = app.view.height * 0.9;
  // };

  // 暴露方法给父组件
  useImperativeHandle(ref, () => ({
    // expression 可以是中文名('吐舌')或英文 emotion('happy')
    showExpression: (expression, active = true) => {
      if (modelRef.current) {
        // 先查中文表情表，查不到再查英文 emotion 映射
        let expressionId = EXPRESSIONS[expression];
        if (!expressionId) {
          const mapped = EMOTION_MAP[expression];
          expressionId = mapped ? EXPRESSIONS[mapped] : null;
        }
        if (expressionId) {
          modelRef.current.internalModel.coreModel.setParameterValueById(
            expressionId, 
            active ? 1 : 0
          );
        } else {
          console.warn(`未知的表情: ${expression}`);
          return;
        }

        // 新增：设置定时器，在十秒后复位表情
        setTimeout(() => {
          if (modelRef.current && expressionId) {
            modelRef.current.internalModel.coreModel.setParameterValueById(
              expressionId, 
              0 // 将表情参数值重置为 0
            );
            console.log(`表情 ${expression} 已复位`);
          }
        }, 10000); // 10秒后执行复位操作
      }
    },

    resetExpression: resetExpressionParams,

    // 新增：设置跟踪功能
    setTracking: (enabled) => {
      if (modelRef.current) {
        modelRef.current.autoInteract = enabled;
        modelRef.current.internalModel.motionManager.settings.autoAddRandomMotion = enabled;
        console.log(`模型跟踪功能已${enabled ? '开启' : '关闭'}~`);
      }
    },

    // 缩放控制：factor 是缩放倍率（1.0=默认，0.5=一半大，2.0=两倍大）
    setScale: (factor) => {
      if (modelRef.current && appRef.current) {
        const baseScale = Math.min(
          appRef.current.view.width / modelRef.current.originalWidth * 0.85,
          appRef.current.view.height / modelRef.current.originalHeight * 0.85
        );
        const newScale = Math.max(0.3, Math.min(3.0, baseScale * factor));
        modelRef.current.scale.set(newScale);
      }
    },

    // 获取模型引用（供走动等高级控制用）
    getModel: () => modelRef.current,

    setMovementState: ({ direction }) => {
      const model = modelRef.current
      if (!model) return
      const core = model.internalModel.coreModel
      if (direction === 'left' || direction === 'right') movementDirectionRef.current = direction
      // 朝向翻转：朝左时 scale.x 取负（镜像）。
      model.scale.x = Math.abs(model.scale.x) * (movementDirectionRef.current === 'left' ? -1 : 1)

      // walk 的身体步态（起伏/重心/迈步）由 useWalkCycle 驱动，这里不重复写身体参数，
      // 避免和 walk cycle 的 ParamBodyAngleZ/HipAngleX 等打架。
      // 非 walking 状态：把 body 角度归零，让身体回到正中。
      try {
        core.setParameterValueById('ParamBodyAngleX', 0)
      } catch { /* Optional model parameter. */ }
    }
  }))

  useLayoutEffect(() => {
    // 确保清理之前的内容
    if (appRef.current) {
      appRef.current.destroy(true)
      appRef.current = null
    }
    if (pixiContainerRef.current) {
      while (pixiContainerRef.current.firstChild) {
        pixiContainerRef.current.removeChild(pixiContainerRef.current.firstChild)
      }
    }

    if (!pixiContainerRef.current) return

    // 滚轮缩放角色（提到外层，cleanup 才能引用到）
    const onWheel = (e) => {
      if (!modelRef.current || !appRef.current) return
      e.preventDefault()
      const baseScale = Math.min(
        appRef.current.view.width / modelRef.current.originalWidth * 0.85,
        appRef.current.view.height / modelRef.current.originalHeight * 0.85
      )
      const factor = e.deltaY < 0 ? 1.1 : 0.9
      const cur = modelRef.current.scale.x
      const newScale = Math.max(baseScale * 0.3, Math.min(baseScale * 3.0, cur * factor))
      modelRef.current.scale.set(newScale)
    }

    // 点击反应：从反应池随机选一个，在 duration 内按钟形权重把参数插值到目标再归零。
    // 多次点击会取消上一个反应、立即开始新反应。
    const playClickReaction = () => {
      const model = modelRef.current
      if (!model) return
      const core = model.internalModel?.coreModel
      if (!core) return
      const reaction = pickClickReaction()
      const setParam = (id, val) => {
        try { core.setParameterValueById(id, val) } catch { /* 参数不存在则忽略 */ }
      }

      // 取消上一个反应：归零其参数。
      const prev = clickReactionRef.current
      if (prev) {
        for (const id of Object.keys(prev.targets)) setParam(id, 0)
        if (prev.raf) cancelAnimationFrame(prev.raf)
      }

      const start = performance.now()
      const targets = { ...reaction.params }
      const state = { reaction, targets, raf: null }
      clickReactionRef.current = state

      const step = (now) => {
        if (clickReactionRef.current !== state) return // 已被新反应取代
        const t = Math.min(1, (now - start) / reaction.duration)
        const w = Math.sin(t * Math.PI) // 钟形：起止 0，中段最强
        for (const [id, target] of Object.entries(targets)) setParam(id, target * w)
        if (t < 1) {
          state.raf = requestAnimationFrame(step)
        } else {
          for (const id of Object.keys(targets)) setParam(id, 0)
          if (clickReactionRef.current === state) clickReactionRef.current = null
        }
      }
      state.raf = requestAnimationFrame(step)
    }

    const app = new PIXI.Application({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundAlpha: 0,
      // 不用 resizeTo: window，否则会用整个窗口高度覆盖输入区；手动处理 resize
      antialias: true,
    })
    app.ticker.maxFPS = 30
    appRef.current = app
    pixiContainerRef.current.appendChild(app.view)

    let isDestroyed = false

    ;(async function() {
      if (modelRef.current) return
      
      try {
        const model = await Live2DModel.from('./models/PinkFox/PinkFox.model3.json')
        // const model = await Live2DModel.from('/models/Hiyori/Hiyori.model3.json')
        // const model = await Live2DModel.from('/models/Haru/Haru.model3.json')

        // 如果组件已经被卸载，不要继续处理
        if (isDestroyed || !appRef.current) return
        
        console.log('Model loaded:', model)
        modelRef.current = model

        const parameterIds = (model.internalModel.coreModel._model?.parameters?.ids || [])
          .map((id) => id.getString?.() ?? id.s ?? String(id))
        const motions = Object.entries(model.internalModel.settings.motions || {})
          .flatMap(([group, items]) => items.map((item, index) => `${group}[${index}]:${item.file}`))
        console.info('[Live2D diagnostics]', { parameterIds, motions })
        
        // 设置模型的初始跟踪状态
        model.internalModel.motionManager.settings.autoAddRandomMotion = true
        model.autoInteract = true  // 初始状态设置为跟踪
        model.draggable = true

        // 记录原始尺寸（供 setScale 计算用）
        model.originalWidth = model.width
        model.originalHeight = model.height

        const scale = Math.min(
          app.view.width / model.width * 0.85,   /* 缩小到 canvas 的 85%，确保完整可见 */
          app.view.height / model.height * 0.85
        )
        model.scale.set(scale)

        model.x = app.view.width / 2
        model.y = app.view.height * 0.98  /* 底部锚点时尽量贴近桌面底线 */
        model.anchor.set(0.5, 1.0)        /* anchor 在脚底（底部中心），脚永远不被裁 */

        app.stage.addChild(model)

        if (model.internalModel.settings.motions?.Walk?.length) {
          console.info('[Live2D motion] Walk registered')
        }
        model.motion('Kuku', 0).then(() => {
          console.info('[Live2D motion] Kuku playback verified')
        }).catch((error) => {
          console.warn('[Live2D motion] Kuku playback failed', error)
        })

        // 滚轮缩放已在 useLayoutEffect 顶部定义 onWheel，这里注册
        window.addEventListener('wheel', onWheel, { passive: false })

        model.on('hit', (hitAreas) => {
          console.log('Hit:', hitAreas)
          playClickReaction()
        })
      } catch (error) {
        console.error('Error loading model:', error)
      }
    })()

    return () => {
      isDestroyed = true
      window.removeEventListener('wheel', onWheel)
      if (clickReactionRef.current) {
        if (clickReactionRef.current.raf) cancelAnimationFrame(clickReactionRef.current.raf)
        clickReactionRef.current = null
      }
      if (modelRef.current) {
        modelRef.current.destroy()
        modelRef.current = null
      }
      if (appRef.current) {
        appRef.current.destroy(true)
        appRef.current = null
      }
    }
  }, [])

  return <div ref={pixiContainerRef} className="live2d-container"></div>
})
// 添加这行给组件命名
Live2DDisplay.displayName = 'Live2DDisplay'
export default Live2DDisplay
