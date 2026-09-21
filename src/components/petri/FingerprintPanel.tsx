import { useState } from 'react';
import type { RunInfo } from '../../../shared/sim/types';
import { petriApi, type VerifyView } from '../../utils/petriApi';
import { CATEGORY_LABELS } from '../../../shared/types';
interface Props {
  run: RunInfo;
}

const CAT_KEYS = ['bacteria', 'fungi', 'virus', 'archaea'] as const;
const CAT_BAR = ['#00ffc8', '#b47cd4', '#ff6b5e', '#f1c40f'];

export function FingerprintPanel({ run }: Props) {
  const [verify, setVerify] = useState<VerifyView | null>(null);
  const [busy, setBusy] = useState(false);

  const speciesName = (id: number | null) =>
    id === null ? '全部灭绝' : run.species.find((s) => s.microbeId === id)?.name ?? `#${id}`;

  const onVerify = async () => {
    setBusy(true);
    try {
      setVerify(await petriApi.verify(run.runId));
    } catch (e) {
      setVerify({
        runId: run.runId,
        matched: false,
        journalIntact: false,
        expectedJournalTip: '',
        recomputedJournalTip: '',
        expectedTranscript: '',
        replayTranscript: (e as Error).message,
        expectedChainTip: '',
        replayChainTip: '',
        ticksCompared: 0,
        replayedAt: new Date().toISOString(),
      });
    } finally {
      setBusy(false);
    }
  };

  const fp = run.fingerprint;

  return (
    <div className="glass-card p-5 space-y-4 text-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-sm text-text-light">生态指纹 · Eco Fingerprint</h3>
        <button onClick={onVerify} disabled={busy} className="btn-primary-ghost !py-1 !px-3 !text-[11px]">
          {busy ? '重放中…' : '服务器复核'}
        </button>
      </div>

      {verify && (
        <div className="space-y-1">
          <div
            className={`rounded-lg px-3 py-2 border font-mono text-[11px] ${
              verify.matched
                ? 'border-glow-primary/40 bg-glow-primary/10 text-glow-primary'
                : 'border-glow-red/50 bg-glow-red/10 text-glow-red'
            }`}
          >
            {verify.matched
              ? `✓ 重放 ${verify.ticksCompared} 代，逐格计数与哈希链全部一致（${new Date(verify.replayedAt).toLocaleTimeString()}）`
              : '✗ 重放与存档不符，结果可能被篡改'}
          </div>
          <div
            className={`rounded-lg px-3 py-2 border font-mono text-[11px] ${
              verify.journalIntact
                ? 'border-glow-primary/30 bg-glow-primary/5 text-text-light'
                : 'border-glow-red/50 bg-glow-red/10 text-glow-red'
            }`}
          >
            {verify.journalIntact
              ? '✓ 科考日志哈希链完好：逐步留痕未被改动'
              : '✗ 科考日志哈希链断裂：存档被改动过'}
          </div>
        </div>
      )}

      <div className="space-y-1 font-mono text-[10px] text-text-muted break-all">
        <Row k="spec" v={`v${fp.specVersion}`} />
        <Row k="seed" v={fp.seed} />
        <Row k="inoculum" v={fp.inoculumHash.slice(0, 20) + '…'} />
        <Row k="transcript" v={fp.transcriptHash} highlight />
        <Row k="chain tip" v={fp.chainTip.slice(0, 24) + '…'} />
        <Row k="generations" v={`${fp.generations}（${run.maxCells} 峰值个体）`} />
        <Row
          k="结局"
          v={{ stable: '生态位稳定', extinct: '全部灭绝', 'max-ticks': '到达 900 代上限' }[fp.concluded]}
        />
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-text-muted mb-2">第 N 代 · 细胞数与四类占比</div>
        <div className="space-y-2">
          {fp.checkpoints.map((cp) => (
            <div key={cp.generation} className="flex items-center gap-2">
              <span className="w-12 font-mono text-text-muted">G{cp.generation}</span>
              <div className="flex-1 h-3 rounded overflow-hidden bg-white/5 flex">
                {CAT_KEYS.map((k, i) => (
                  <div
                    key={k}
                    style={{ width: `${cp.ratioPermille[k] / 10}%`, background: CAT_BAR[i] }}
                    title={`${CATEGORY_LABELS[k]} ${cp.composition[k]}`}
                  />
                ))}
              </div>
              <span className="w-10 text-right font-mono text-text-light">{cp.total}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">最终优势种</div>
          <div className="text-glow-primary">{speciesName(fp.dominantSpeciesId)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-text-muted mb-1">灭绝顺序</div>
          <div className="text-text-light">
            {fp.extinctionOrder.length === 0
              ? '无灭绝'
              : fp.extinctionOrder.map((id) => speciesName(id)).join(' → ')}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, highlight }: { k: string; v: string; highlight?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-text-muted/70">{k}</span>
      <span className={highlight ? 'text-glow-primary' : 'text-text-light'}>{v}</span>
    </div>
  );
}
