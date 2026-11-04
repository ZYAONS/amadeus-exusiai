import Sheet from './Sheet'
import { OPERATOR } from '../lib/operator'
import { rankOf } from '../lib/trust'
import type { Config } from '../lib/store'
import type { Health } from '../lib/api'

type Props = {
  open: boolean
  health: Health
  config: Config
  trust: number
  name: string
  hasModel: boolean
  onConfig: (patch: Partial<Config>) => void
  onResetVoice: () => void
  onClearHistory: () => void
  onSignOut: () => void
  onClose: () => void
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--po-line)] py-2.5">
      <span className="text-[13px]">{label}</span>
      {children}
    </div>
  )
}

function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      className={`relative h-5 w-9 rounded-full border transition ${
        on ? 'border-[var(--po-crimson)] bg-[var(--po-crimson-soft)]' : 'border-[var(--po-line)] bg-[rgba(23,24,26,0.06)]'
      }`}
    >
      <span
        className={`absolute top-[2px] h-3.5 w-3.5 rounded-full transition-all ${
          on ? 'left-[18px] bg-[var(--po-amber)]' : 'left-[2px] bg-[var(--po-muted)]'
        }`}
      />
    </button>
  )
}

const FACT: [string, string][] = [
  ['职业 / 分支', `${OPERATOR.klass} / ${OPERATOR.branch}`],
  ['标签', OPERATOR.tags.join(' · ')],
  ['种族 / 出身', `${OPERATOR.race} / ${OPERATOR.origin}`],
  ['所属势力', OPERATOR.faction],
  ['画师', OPERATOR.artist],
  ['CV', `中配 ${OPERATOR.cv} / 日配 ${OPERATOR.cvJp}`],
  ['特性', OPERATOR.trait],
  ['技能', OPERATOR.skills.join(' / ')],
  ['天赋', OPERATOR.talent],
]

export default function ConfigPanel({
  open,
  health,
  config,
  trust,
  name,
  hasModel,
  onConfig,
  onResetVoice,
  onClearHistory,
  onSignOut,
  onClose,
}: Props) {
  return (
    <Sheet
      open={open}
      title="终端设置"
      subtitle={health.configured ? `AMADEUS 已连接 · ${health.model}` : '本地人格模式（未配置模型）'}
      onClose={onClose}
    >
      <section>
        <h3 className="font-hud text-[11px] tracking-[0.24em] text-[var(--po-halo)]">对话</h3>
        <div className="mt-1">
          <Row label="语音播报">
            <Switch on={config.voice} onClick={() => onConfig({ voice: !config.voice })} label="语音播报" />
          </Row>
          <Row label="浏览器 TTS 兜底">
            <Switch on={config.tts} onClick={() => onConfig({ tts: !config.tts })} label="浏览器 TTS 兜底" />
          </Row>
          <Row label="闲置时主动说话">
            <Switch on={config.autoIdle} onClick={() => onConfig({ autoIdle: !config.autoIdle })} label="闲置时主动说话" />
          </Row>
          <Row label="舞台人物">
            <select
              value={hasModel ? config.stage : '2d'}
              disabled={!hasModel}
              onChange={(e) => onConfig({ stage: e.target.value as Config['stage'] })}
              aria-label="舞台人物"
              className="border border-[var(--po-line)] bg-[var(--po-card-2)] px-2 py-1 font-hud text-[11px] disabled:opacity-50"
            >
              <option value="3d">3D 模型</option>
              <option value="2d">官方立绘</option>
            </select>
          </Row>
          {!hasModel && (
            <p className="mt-1 border-l-2 border-[var(--po-line)] pl-2 text-[11px] leading-relaxed text-[var(--po-muted)]">
              没检测到模型文件。把 .glb 放进 <span className="text-[var(--po-halo)]">public/assets/model/</span>，
              或跑 <span className="text-[var(--po-halo)]">node tools/fetch-model.mjs 你的文件.glb</span>。
            </p>
          )}
          <Row label="配音与台词语言">
            <select
              value={config.lang}
              onChange={(e) => onConfig({ lang: e.target.value as Config['lang'] })}
              aria-label="配音与台词语言"
              className="border border-[var(--po-line)] bg-[var(--po-card-2)] px-2 py-1 font-hud text-[11px]"
            >
              <option value="zh">中文（蔡书瑾）</option>
              <option value="jp">日本語（石見舞菜香）</option>
            </select>
          </Row>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--po-muted)]">
          {health.configured
            ? '回复由大模型生成，情绪标签驱动立绘的光与名牌；模型配置见 service/ 的 .env。'
            : '没有配置大模型时，回复只从官方台词库里挑（不编造她的台词）。运行 npm run dev:api 并填好 .env 后即可自由对话。'}
        </p>
      </section>

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h3 className="font-hud text-[11px] tracking-[0.24em] text-[var(--po-halo)]">链接档案</h3>
          <span className="font-hud text-[10px] text-[var(--po-muted)]">{rankOf(trust)}</span>
        </div>
        <dl className="mt-1">
          <Row label="你">
            <span className="text-[13px] text-[var(--po-halo)]">{name}</span>
          </Row>
          {FACT.map(([k, v]) => (
            <div key={k} className="border-b border-[var(--po-line)] py-2 text-[12px] leading-relaxed">
              <dt className="font-hud text-[10px] tracking-[0.16em] text-[var(--po-muted)]">{k}</dt>
              <dd className="mt-0.5">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-6 space-y-2">
        <button
          type="button"
          onClick={onResetVoice}
          className="w-full border border-[var(--po-line)] px-3 py-2 text-[12px] transition hover:border-[var(--po-amber)]"
        >
          重试官方语音地址（清空缺席缓存）
        </button>
        <button
          type="button"
          onClick={onClearHistory}
          className="w-full border border-[var(--po-line)] px-3 py-2 text-[12px] transition hover:border-[var(--po-crimson)]"
        >
          清空对话记录
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="w-full border border-[var(--po-crimson)] px-3 py-2 text-[12px] text-[var(--po-crimson)] transition hover:bg-[var(--po-crimson-soft)]"
        >
          断开链接并清除本地数据
        </button>
      </section>

      <p className="mt-6 text-[11px] leading-relaxed text-[var(--po-muted)]">
        非官方同人项目，模仿 ai-poet/amadeus-system-new 的思路重做。立绘、语音、台词、档案数据著作权归上海鹰角网络科技有限公司所有。
      </p>
    </Sheet>
  )
}
