import { useEffect, useRef } from 'react';
import { walkCadence, walkParams, walkStageTransform, WALK_PARAM_KEYS } from '../walkCycle';

/**
 * 走路步态动画 - 在 Electron 窗口真实移动时让角色迈步起伏。
 * 与 useIdleAnimations 同构：RAF 驱动 Live2D 参数。
 *
 * 用法：
 *   const getModel = () => live2dRef.current?.getModel?.()
 *   useWalkCycle(getModel, movementState)
 *
 * 仅当 movementState.phase === 'walking' 时驱动步态；其它状态把步态参数归零，避免残留。
 * speed（px/s）来自 Electron main process 的 movementState.speed，用于调节步频。
 *
 * 与 useIdleAnimations 互斥：MainPage 在 walking 时传 enabled 给 idle=false，
 * 避免 idle 的呼吸/环顾和 walk 的身体起伏同时写参数打架。
 *
 * 实现注意：speed / direction 在 walking 期间会高频变化（每个 tick 一次），
 * 所以用 ref 转存，RAF 循环只依赖 walking 状态——否则每帧重建 RAF 会导致步态抖动。
 */
export function useWalkCycle(getModel, movementState) {
  const phase = movementState?.phase;
  const speed = movementState?.speed ?? 0;
  const walking = phase === 'walking';

  const speedRef = useRef(speed);
  const getModelRef = useRef(getModel);
  speedRef.current = speed;
  getModelRef.current = getModel;

  useEffect(() => {
    const resolveModel = () => getModelRef.current && getModelRef.current();
    if (!walking) {
      // 退出走路时把步态参数归零，防止身体留在歪着/抬腿的状态。
      const model = resolveModel();
      const core = model?.internalModel?.coreModel;
      if (model && model.__walkBaseY != null) {
        model.y = model.__walkBaseY;
        model.rotation = model.__walkBaseRotation || 0;
        delete model.__walkBaseY;
        delete model.__walkBaseRotation;
      }
      if (core) {
        for (const id of WALK_PARAM_KEYS) {
          try { core.setParameterValueById(id, 0); } catch { /* 参数不存在则忽略 */ }
        }
      }
      return;
    }

    let rafId = null;
    let lastTs = null;
    let gaitPhase = 0; // 步态相位 [0, 2π)

    const setParam = (core, id, val) => {
      try { core.setParameterValueById(id, val); } catch { /* 参数不存在则忽略 */ }
    };

    const tick = (ts) => {
      const model = resolveModel();
      if (!model) {
        rafId = requestAnimationFrame(tick);
        return;
      }
      const core = model.internalModel?.coreModel;
      if (!core) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      // 用 delta time 推进相位，让步频随窗口移动速度变化。
      // 经验映射：视频参考更像稳定巡游，步频随速度涨，但不过分小碎步。
      if (lastTs == null) lastTs = ts;
      const dt = Math.min(0.05, (ts - lastTs) / 1000); // 上限防卡顿后跳变
      lastTs = ts;
      gaitPhase += walkCadence(speedRef.current) * Math.PI * 2 * dt;
      if (gaitPhase >= Math.PI * 2) gaitPhase -= Math.PI * 2;

      // 方向从模型 scale.x 翻转状态推断（Live2DModel.setMovementState 已处理翻转），
      // 这里只读不写翻转。朝左时整体参数镜像。
      const facingLeft = model.scale && model.scale.x < 0;
      const params = walkParams(gaitPhase, facingLeft ? 'left' : 'right');
      for (const [id, val] of Object.entries(params)) {
        setParam(core, id, val);
      }
      if (model.__walkBaseY == null) {
        model.__walkBaseY = model.y;
        model.__walkBaseRotation = model.rotation || 0;
      }
      const transform = walkStageTransform(gaitPhase);
      model.y = model.__walkBaseY + transform.y;
      model.rotation = (model.__walkBaseRotation || 0) + (facingLeft ? -transform.rotation : transform.rotation);

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [walking]);
}
