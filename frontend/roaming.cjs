const TICK_MS = 1000 / 30;

function clampToWorkArea(bounds, workArea) {
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - bounds.width),
    y: workArea.y + workArea.height - bounds.height,
  };
}

function chooseTargetX(currentX, workArea, windowWidth, random = Math.random) {
  const min = workArea.x;
  const max = workArea.x + workArea.width - windowWidth;
  if (max - min <= 80) return min;

  const candidates = [min, max].filter((x) => Math.abs(x - currentX) >= 80);
  if (!candidates.length) return Math.round(min + random() * (max - min));
  const side = candidates[Math.floor(random() * candidates.length)];
  const distance = side - currentX;
  const step = Math.sign(distance) * Math.max(80, Math.abs(distance) * (0.35 + random() * 0.65));
  return Math.round(Math.min(Math.max(currentX + step, min), max));
}

// 找窗口中心所在的显示器 id。bounds={x,y,width,height},displays=[{id,workArea}]。
// 若窗口中心不在任何显示器内（例如刚拔掉副屏），退回主显示器（数组第一个）。
function displayIdFor(bounds, displays) {
  if (!displays || !displays.length) return null;
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  for (const d of displays) {
    const a = d.workArea || d.bounds;
    if (!a) continue;
    if (cx >= a.x && cx < a.x + a.width && cy >= a.y && cy < a.y + a.height) {
      return d.id;
    }
  }
  // 中心不在任何屏内：挑面积重叠最大的，避免"窗口在屏外"时仍报错屏。
  let best = displays[0].id;
  let bestOverlap = -1;
  for (const d of displays) {
    const a = d.workArea || d.bounds;
    if (!a) continue;
    const ox = Math.max(0, Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x));
    const oy = Math.max(0, Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y));
    const overlap = ox * oy;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = d.id;
    }
  }
  return best;
}

// 启动时把持久化的 saved bounds 映射到当前可用显示器。
// saved: { x, y, width, height, displayId? } | null
// displays: [{id, workArea}]，displays[0] 视为主显示器。
// 返回 { x, y, displayId }：合法且 clamp 到某显示器 workArea 底部。
// 若 saved 记录的显示器已不在（断屏/换屏），退回主显示器右下角。
function resolveStartupBounds(saved, displays, { windowWidth = 300, windowHeight = 420 } = {}) {
  const primary = displays && displays[0];
  const primaryArea = primary ? (primary.workArea || primary.bounds) : { x: 0, y: 0, width: 0, height: 0 };

  const fallback = {
    x: primaryArea.x + Math.max(0, primaryArea.width - windowWidth - 20),
    y: primaryArea.y + Math.max(0, primaryArea.height - windowHeight - 20),
    displayId: primary ? primary.id : null,
  };

  if (!saved || !displays || !displays.length) return fallback;

  // 优先用 saved.displayId 找显示器；找不到则按 saved 坐标定位；再不行用主屏。
  let target = null;
  if (saved.displayId != null) {
    target = displays.find((d) => d.id === saved.displayId);
  }
  if (!target) {
    const id = displayIdFor(
      { x: saved.x, y: saved.y, width: saved.width || windowWidth, height: saved.height || windowHeight },
      displays,
    );
    target = displays.find((d) => d.id === id) || primary;
  }
  if (!target) return fallback;

  const area = target.workArea || target.bounds;
  const w = saved.width || windowWidth;
  const h = saved.height || windowHeight;
  const clamped = clampToWorkArea({ x: saved.x, y: saved.y, width: w, height: h }, area);
  return { x: clamped.x, y: clamped.y, displayId: target.id };
}

module.exports = { TICK_MS, clampToWorkArea, chooseTargetX, displayIdFor, resolveStartupBounds };
