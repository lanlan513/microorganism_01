import { useMemo, useState } from 'react';
import type { Microbe } from '../../shared/types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../../shared/types';
import { FlaskConical, Plus, Minus } from 'lucide-react';

interface Props {
  specimens: Microbe[];
  selected: Map<number, number>;
  onChange: (next: Map<number, number>) => void;
  disabled?: boolean;
}

export function InoculumPicker({ specimens, selected, onChange, disabled }: Props) {
  const [filter, setFilter] = useState<string>('all');
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    return specimens.filter((m) => {
      if (filter !== 'all' && m.category !== filter) return false;
      if (query && !m.name.includes(query) && !m.scientificName.toLowerCase().includes(query.toLowerCase()))
        return false;
      return true;
    });
  }, [specimens, filter, query]);

  const setCount = (id: number, delta: number) => {
    const next = new Map(selected);
    const cur = next.get(id) ?? 0;
    const v = Math.max(0, Math.min(500, cur + delta));
    if (v === 0) next.delete(id);
    else next.set(id, v);
    onChange(next);
  };

  const total = [...selected.values()].reduce((a, b) => a + b, 0);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-3">
        <FlaskConical className="w-4 h-4 text-glow-primary" />
        <h3 className="font-display text-lg text-text-light">接种清单</h3>
        <span className="ml-auto font-mono text-xs text-text-muted">共 {selected.size} 种 / {total} 个体</span>
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索标本…"
        disabled={disabled}
        className="w-full mb-2 px-3 py-1.5 rounded-lg bg-background-deep/70 border border-glow-primary/15 text-sm font-mono
                   text-text-light placeholder:text-text-muted/50 focus:outline-none focus:border-glow-primary/50 disabled:opacity-50"
      />
      <div className="flex gap-1 mb-2 flex-wrap">
        {['all', 'bacteria', 'fungi', 'virus', 'archaea'].map((c) => (
          <button
            key={c}
            disabled={disabled}
            onClick={() => setFilter(c)}
            className={`px-2.5 py-0.5 rounded-full text-[11px] font-mono border transition-colors disabled:opacity-50 ${
              filter === c
                ? 'border-glow-primary/60 text-glow-primary bg-glow-primary/10'
                : 'border-white/10 text-text-muted hover:text-text-light'
            }`}
          >
            {c === 'all' ? '全部' : CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS]}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto pr-1 space-y-1.5 petri-scroll">
        {list.map((m) => {
          const count = selected.get(m.id) ?? 0;
          const active = count > 0;
          const color = CATEGORY_COLORS[m.category];
          return (
            <div
              key={m.id}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border transition-colors ${
                active ? 'border-glow-primary/40 bg-glow-primary/5' : 'border-white/5 bg-background-deep/40'
              }`}
            >
              <span className="w-1.5 h-8 rounded-full shrink-0" style={{ background: color }} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-text-light truncate">{m.name}</div>
                <div className="text-[10px] text-text-muted italic truncate">{m.scientificName}</div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  disabled={disabled}
                  onClick={() => setCount(m.id, -10)}
                  className="w-6 h-6 rounded-md border border-white/10 text-text-muted hover:text-glow-primary hover:border-glow-primary/40 disabled:opacity-40"
                >
                  <Minus className="w-3 h-3 mx-auto" />
                </button>
                <span className={`w-9 text-center font-mono text-sm ${active ? 'text-glow-primary' : 'text-text-muted'}`}>
                  {count}
                </span>
                <button
                  disabled={disabled}
                  onClick={() => setCount(m.id, 10)}
                  className="w-6 h-6 rounded-md border border-white/10 text-text-muted hover:text-glow-primary hover:border-glow-primary/40 disabled:opacity-40"
                >
                  <Plus className="w-3 h-3 mx-auto" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
