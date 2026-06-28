import './CodeStatusBar.css'

// 编程状态映射：图标 + 文案 + 颜色
const STATUS_MAP = {
  coding:     { icon: '⚡', label: '编码中',   cls: 'coding' },
  thinking:   { icon: '💭', label: '思考中',   cls: 'thinking' },
  idle_recent:{ icon: '🍵', label: '刚歇下',   cls: 'recent' },
  idle:       { icon: '😴', label: '摸鱼中',   cls: 'idle' },
}

// 时长格式化：分钟 → "42min" 或 "1h20min"
function fmtDuration(min) {
  if (!min || min < 1) return ''
  if (min < 60) return `${min}min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h${m}min` : `${h}h`
}

export default function CodeStatusBar({ codeStatus }) {
  // 没有数据（没装 Claude/Codex）就不显示
  if (!codeStatus || !codeStatus.tool) return null

  const info = STATUS_MAP[codeStatus.state] || STATUS_MAP.idle
  const dur = fmtDuration(codeStatus.duration_min)

  return (
    <div className={`code-status-bar ${info.cls}`}>
      <span className="cs-icon">{info.icon}</span>
      <span className="cs-tool">{codeStatus.tool}</span>
      <span className="cs-sep">·</span>
      <span className="cs-label">{info.label}</span>
      {dur && <>
        <span className="cs-sep">·</span>
        <span className="cs-dur">{dur}</span>
      </>}
    </div>
  )
}
