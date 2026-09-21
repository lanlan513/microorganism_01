import { useMemo, useState } from 'react';
import type { CatalogEntryView } from '../../utils/petriApi';
import { CATEGORY_LABELS } from '../../../shared/types';
import type { InoculumItem, SimCategory } from '../../../shared/sim/types';

interface Props {
  catalog: CatalogEntryView[];
  onCreate: (seed: string, inoculum: InoculumItem[], name: string) => void;
  busy: boolean;
}

const CAT_ORDER: SimCategory[] = ['bacteria', 'fungi', 'virus', 'archaea'];
const CAT_DOT: Record<SimCategory, string> = {
  bacteria: 'bg-glow-primary',
  fungi: 'bg-glow-purple',
  virus: 'bg-glow-red',
  archaea: 'bg-glow-gold',
};

export function Inoculator({ catalog, onCreate, busy }: Props) {
  const [seed, setSeed] = useState('42');
  const [name, setName] = useState('');
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [filter, setFilter] = useState<SimCategory | 'all'>('all');

  const grouped = useMemo(() => {
    const m = new Map<SimCategory, CatalogEntryView[]>();
    for (const c of catalog) {
      const arr = m.get(c.category) ?? [];
      arr.push(c);
      m.set(c.category, arr);
    }
    return m;
  }, [catalog]);

  const chosen: InoculumItem[] = Object.entries(counts)
    .map(([id, count]) => ({ microbeId: Number(id), count }))
    .filter((i) => i.count > 0);
  const total = chosen.reduce((s, i) => s + i.count, 0);

  const setCount = (id: number, v: number) => {
    const clamped = Math.max(0, Math.min(60, Math.floor(v || 0)));
    setCounts((prev) => ({ ...prev, [id]: clamped }));
  };

  const presets: Array<{ label: string; apply: () => void }> = [
    {
      label: '经典演替',
      apply: () => setCounts({ 1: 30, 11: 6, 24: 8 }),
    },
    {
      label: 'T4 猎菌',
      apply: () => setCounts({ 1: 40, 15: 6, 9: 8 }),
    },
    {
      label: '耐药者生存',
      apply: () => setCounts({ 2: 24, 4: 12, 11: 8, 23: 8 }),
    },
    {
      label: '青霉压制',
      apply: () => setCounts({ 2: 36, 11: 10 }),
    },
  ];

  return (
    <div className="glass-card p-5 space-y-4">
      <div>
        <h2 className="text-lg text-text-light mb-1">接种培养皿</h2>
        <p className="text-xs text-text-muted">
          勾选任意几种标本与接种量，选定种子后开皿。推进在服务器执行，前端只负责播放。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-text-muted space-y-1">
          种子（可复现凭证）
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            className="w-full mt-1 bg-background-deep border border-glow-primary/25 rounded-lg px-3 py-2 text-text-light font-mono"
            placeholder="数字或任意字符串"
          />
        </label>
        <label className="text-xs text-text-muted space-y-1">
          皿名（可选）
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full mt-1 bg-background-deep border border-glow-primary/25 rounded-lg px-3 py-2 text-text-light"
            placeholder="未命名培养皿"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={p.apply}
            className="text-[11px] font-mono px-3 py-1 rounded-full border border-glow-primary/25 text-text-muted hover:text-glow-primary hover:border-glow-primary/60 transition"
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setCounts({})}
          className="text-[11px] font-mono px-3 py-1 rounded-full border border-white/10 text-text-muted hover:text-text-light transition"
        >
          清空
        </button>
      </div>

      <div className="flex gap-1 flex-wrap">
        <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>全部</FilterChip>
        {CAT_ORDER.map((c) => (
          <FilterChip key={c} active={filter === c} onClick={() => setFilter(c)}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${CAT_DOT[c]}`} />
            {CATEGORY_LABELS[c]}
          </FilterChip>
        ))}
      </div>

      <div className="max-h-64 overflow-y-auto pr-1 space-y-3">
        {CAT_ORDER.filter((c) => filter === 'all' || filter === c).map((cat) => {
          const list = grouped.get(cat) ?? [];
          if (list.length === 0) return null;
          return (
            <div key={cat}>
              <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">
                {CATEGORY_LABELS[cat]}
              </div>
              <div className="space-y-1">
                {list.map((m) => (
                  <label
                    key={m.microbeId}
                    className="flex items-center justify-between gap-2 text-xs text-text-light bg-white/[0.02] rounded-lg px-2 py-1.5"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${CAT_DOT[cat]}`} />
                      <span className="truncate">{m.name}</span>
                      <span className="italic text-text-muted truncate hidden sm:inline">{m.scientificName}</span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={60}
                      value={counts[m.microbeId] ?? ''}
                      onChange={(e) => setCount(m.microbeId, Number(e.target.value))}
                      placeholder="0"
                      className="w-14 bg-background-deep border border-glow-primary/20 rounded px-2 py-0.5 text-right font-mono"
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <button
        disabled={busy || chosen.length === 0 || total > 200}
        onClick={() => onCreate(seed, chosen, name)}
        className="btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy ? '服务器推进中…' : `接种并开皿（${chosen.length} 种 / ${total} 只）`}
      </button>
      {total > 200 && <p className="text-[11px] text-glow-red">接种总量上限 200</p>}
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`text-[11px] font-mono px-2.5 py-1 rounded-full border transition ${
        active
          ? 'text-glow-primary border-glow-primary/60 bg-glow-primary/10'
          : 'text-text-muted border-white/10 hover:text-text-light'
      }`}
    >
      {children}
    </button>
  );
}
