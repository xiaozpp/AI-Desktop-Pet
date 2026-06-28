import { useEffect, useRef } from 'react'
import {
  pickIdleMicroAction,
  nextMicroActionDelay,
} from '../idleActions'

/**
 * 程序化待机动画 - 让角色"活过来"
 * 驱动 Live2D 参数实现：自然眨眼、呼吸、头部环顾、偶尔伸懒腰，
 * 外加微动作轮播（歪头/看远方/轻摆/眯眼…），避免静止时单调。
 *
 * 用法：const model = live2dRef.current?.getModel?.()
 *       useIdleAnimations(model)
 *
 * 参数说明（PinkFox cdi3.json 确认存在）：
 *   ParamEyeLOpen/ParamEyeROpen - 左右眼开闭（眨眼）
 *   ParamBreath                 - 呼吸
 *   HeadAngleX / HeadAngleY / HeadAngleZ - 头部左右/上下/侧转
 *   ParamBodyAngleX / ParamBodyAngleZ    - 身体旋转
 *   EyeSquint                   - 眯眼
 *
 * @param microInterval [min,max]ms 可选，微动作触发间隔。不传时用 idleActions 默认 8~20s。
 *        由活力档位传入：quiet=30~60s，lively=4~10s 等。变化时重启 RAF 生效。
 */
// 由 [min,max] 区间算下一次微动作延迟（毫秒）；非法区间返回 null，调用方回落到默认。
function microDelayFromInterval(interval, random = Math.random) {
  if (!Array.isArray(interval) || interval.length < 2) return null;
  const lo = Number(interval[0]);
  const hi = Number(interval[1]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < 0) return null;
  if (lo === hi) return Math.floor(lo);
  return Math.floor(lo + random() * (hi - lo));
}

export function useIdleAnimations(getModel, enabled = true, microInterval = null) {
  const rafRef = useRef(null)
  const stateRef = useRef({
    nextBlink: 0,        // 下次眨眼时间戳
    blinkPhase: 0,       // 眨眼动画进度（0=睁开，正在闭/开时为正）
    headTargetX: 0,      // 头部目标角度X
    headTargetY: 0,      // 头部目标角度Y
    nextHeadChange: 0,   // 下次换头部朝向的时间
    nextStretch: 0,      // 下次伸懒腰的时间
    stretchPhase: 0,     // 伸懒腰进度
    // 微动作轮播
    nextMicro: 0,        // 下次触发微动作的时间
    micro: null,         // 当前激活的微动作对象
    microStart: 0,       // 当前微动作开始时间
    microTargets: null,  // 当前微动作的参数目标（缓存）
    microLast: '',       // 上一个微动作 name（避免连续重复）
    microCurrent: {},    // 微动作参数的当前值（用于平滑插值）
  })

  useEffect(() => {
    if (!enabled) return
    const s = stateRef.current
    const now0 = performance.now()
    s.nextBlink = now0 + 2000 + Math.random() * 3000
    s.nextHeadChange = now0 + 1500
    s.nextStretch = now0 + 15000 + Math.random() * 15000
    s.nextMicro = now0 + (microDelayFromInterval(microInterval) ?? nextMicroActionDelay())

    const setParam = (core, id, val) => {
      try { core.setParameterValueById(id, val) } catch { /* 参数不存在则忽略 */ }
    }

    const tick = () => {
      const model = getModel && getModel()
      if (!model) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const core = model.internalModel?.coreModel
      if (!core) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      const now = performance.now()

      // === 1. 自然眨眼 ===
      if (s.blinkPhase > 0) {
        // 眨眼中：phase 0→1 闭眼，1→2 睁眼
        s.blinkPhase += 0.18
        const open = s.blinkPhase < 1 ? (1 - s.blinkPhase) : (s.blinkPhase - 1)
        setParam(core, 'ParamEyeLOpen', Math.max(0, open))
        setParam(core, 'ParamEyeROpen', Math.max(0, open))
        if (s.blinkPhase >= 2) {
          s.blinkPhase = 0
          setParam(core, 'ParamEyeLOpen', 1)
          setParam(core, 'ParamEyeROpen', 1)
          s.nextBlink = now + 2500 + Math.random() * 3500
        }
      } else if (now >= s.nextBlink) {
        s.blinkPhase = 0.01  // 触发眨眼
      }

      // === 2. 呼吸（正弦波，缓慢起伏）===
      setParam(core, 'ParamBreath', (Math.sin(now / 1800) + 1) / 2)

      // === 3. 头部环顾（缓慢朝随机方向看）===
      if (now >= s.nextHeadChange) {
        s.headTargetX = (Math.random() - 0.5) * 24   // -12 ~ 12
        s.headTargetY = (Math.random() - 0.5) * 16   // -8 ~ 8
        s.nextHeadChange = now + 2500 + Math.random() * 3000
      }
      // 平滑插值到目标角度（用当前值，若无则从0开始）
      const curHX = (core.getParameterValueById?.('HeadAngleX')) || 0
      const curHY = (core.getParameterValueById?.('HeadAngleY')) || 0
      setParam(core, 'HeadAngleX', curHX + (s.headTargetX - curHX) * 0.02)
      setParam(core, 'HeadAngleY', curHY + (s.headTargetY - curHY) * 0.02)

      // === 4. 偶尔伸懒腰/歪头（身体轻扭）===
      if (s.stretchPhase > 0) {
        s.stretchPhase += 0.012
        // 钟形曲线：0→1→0
        const bell = Math.sin(Math.min(1, s.stretchPhase) * Math.PI)
        setParam(core, 'ParamBodyAngleZ', bell * 8)
        if (s.stretchPhase >= 1) {
          s.stretchPhase = 0
          setParam(core, 'ParamBodyAngleZ', 0)
          s.nextStretch = now + 20000 + Math.random() * 20000
        }
      } else if (now >= s.nextStretch) {
        s.stretchPhase = 0.001
      }

      // === 5. 微动作轮播（歪头/看远方/轻摆/眯眼…）===
      if (s.micro) {
        const elapsed = now - s.microStart
        const t = Math.min(1, elapsed / s.micro.duration)
        // 钟形权重：开始和结束为 0，中段最强，动作有"做一下再收回"的感觉。
        const w = Math.sin(t * Math.PI)
        for (const [id, target] of Object.entries(s.microTargets)) {
          const nextVal = target * w
          s.microCurrent[id] = nextVal
          setParam(core, id, nextVal)
        }
        if (t >= 1) {
          // 微动作结束，归零其参数
          for (const id of Object.keys(s.microTargets)) {
            setParam(core, id, 0)
            s.microCurrent[id] = 0
          }
          s.microLast = s.micro.name
          s.micro = null
          s.microTargets = null
          s.nextMicro = now + (microDelayFromInterval(microInterval) ?? nextMicroActionDelay())
        }
      } else if (now >= s.nextMicro) {
        s.micro = pickIdleMicroAction(s.microLast)
        s.microStart = now
        s.microTargets = { ...s.micro.params }
        s.microCurrent = {}
      }

      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [getModel, enabled, microInterval])
}
