import { useEffect, useState, useCallback } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  FileText,
  GitBranch,
  Layers3,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Square,
  X,
  Pause,
} from 'lucide-react';
import {
  createTemplate,
  definitionSchema,
  type Definition,
  type StudioNode,
  type StudioRun,
} from '../../../../packages/studio/src/schema';
import type { ModelRecord, ProviderOutcome } from '../../../../packages/providers/src/types';
import type { Result } from '../shared';
import './studio.css';
import { Connections } from './Connections';
import type { Approval } from '../../../../packages/tools/src/journal';

const statusName: Record<string, string> = {
  pending: 'Chờ',
  running: 'Đang chạy',
  waiting: 'Cần bạn duyệt',
  paused: 'Tạm dừng',
  completed: 'Hoàn tất',
  failed: 'Có lỗi',
  cancelled: 'Đã hủy',
  interrupted: 'Bị gián đoạn',
};
const help: Record<string, string> = {
  AWAITING_TOOL_APPROVAL:
    'Kiểm tra tham số trong hộp duyệt tool. Không có tool nào được chạy trước khi bạn cấp quyền.',
  TOOL_OUTCOME_UNKNOWN:
    'Tool có thể đã tạo tác động. SAND chặn retry tự động; kiểm tra hệ thống đích trước khi tạo run mới.',
  TOOL_BINDING_CHANGED:
    'Mở lại đúng repository hoặc kết nối MCP với manifest cũ; nếu đã thay đổi thì tạo run mới.',
  TOOL_UNAVAILABLE: 'Chọn lại repository hoặc kết nối MCP trước khi tiếp tục.',
  INVALID_TOOL_PROTOCOL:
    'Model trả JSON không đúng schema. Kiểm tra tool protocol và khả năng của model.',
  TOOL_PROVIDER_UNAVAILABLE:
    'Chọn Ollama/OpenAI/OpenRouter cho bước dùng tools; Anthropic/Gemini hiện hỗ trợ text.',
  CLOUD_CONSENT_REQUIRED:
    'Bật đồng ý gửi dữ liệu cloud khi tạo lần chạy mới, hoặc dùng model local.',
  PROVIDER_UNCONFIGURED:
    'Đặt credential trong môi trường của desktop rồi khởi động lại. Không nhập API key vào chỉ dẫn.',
  NETWORK_UNAVAILABLE:
    'Kiểm tra Ollama/Internet. Request có thể đã được provider nhận; thử lại có thể tính phí.',
  INVALID_PROVIDER_RESPONSE:
    'Model không trả được text hợp lệ. Chọn model chat khác hoặc giảm đầu vào.',
  CONTEXT_LIMIT: 'Giảm độ dài tài liệu hoặc đầu ra của các bước trước.',
  SECRET_IN_OUTPUT: 'Đầu ra có chuỗi giống credential và đã bị chặn.',
  PROCESS_INTERRUPTED: 'Checkpoint được giữ. Xác nhận trước khi gọi lại bước bị gián đoạn.',
};
const label = (value: string) => statusName[value] ?? value;
export function WorkflowStudio({ onOpenIDE }: { onOpenIDE: () => void }) {
  const [definition, setDefinition] = useState<Definition>(createTemplate);
  const [saved, setSaved] = useState<Definition[]>([]);
  const [selected, setSelected] = useState('analyst');
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [providers, setProviders] = useState<ProviderOutcome[]>([]);
  const [input, setInput] = useState('');
  const [allowCloud, setAllowCloud] = useState(false);
  const [run, setRun] = useState<StudioRun | null>(null);
  const [runs, setRuns] = useState<
    { id: string; name: string; status: string; createdAt: string }[]
  >([]);
  const [tab, setTab] = useState<'design' | 'run'>('design');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [tools, setTools] = useState<{ name: string; description: string; scope: string }[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const refreshTools = useCallback(() => {
    void window.sand.studio.tools().then((r) => {
      if (r.ok) setTools(r.value);
    });
  }, []);
  useEffect(() => refreshTools(), [refreshTools]);
  useEffect(() => {
    setApprovals([]);
    if (!run) return;
    let live = true;
    const read = () =>
      void window.sand.studio.approvals(run.id).then((r) => {
        if (live && r.ok) setApprovals(r.value);
      });
    read();
    const timer = setInterval(read, 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [run?.id]);
  const unwrap = <T,>(result: Result<T>): T => {
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const action = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Thao tác thất bại.');
    } finally {
      setBusy('');
    }
  };
  const refresh = useCallback(async () => {
    const result = await window.sand.studio.runs();
    if (result.ok) setRuns(result.value);
  }, []);
  const discover = async () =>
    action('Đang tìm model', async () => {
      const result = unwrap(await window.sand.studio.discover());
      setModels(result.models.filter((m) => result.inferenceProviders.includes(m.provider)));
      setProviders(result.outcomes);
      setNotice('Danh sách lấy trực tiếp từ provider. Model/giá chưa biết không được suy đoán.');
    });
  useEffect(() => {
    let live = true;
    void window.sand.studio.definitions().then((result) => {
      if (live && result.ok) {
        setSaved(result.value);
        if (result.value[0]) {
          setDefinition(result.value[0]);
          setSelected(result.value[0].nodes[0]!.id);
        }
      }
    });
    void refresh();
    return () => {
      live = false;
    };
  }, [refresh]);
  useEffect(() => {
    if (!run) return;
    let live = true;
    const timer = setInterval(() => {
      void window.sand.studio.get(run.id).then((result) => {
        if (live && result.ok) setRun(result.value);
      });
      void refresh();
    }, 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [run?.id, refresh]);
  const update = (change: Partial<Definition>) => {
    setDefinition((d) => ({ ...d, ...change }));
    setDirty(true);
  };
  const node = definition.nodes.find((n) => n.id === selected);
  const updateNode = (changes: Partial<StudioNode>) =>
    update({ nodes: definition.nodes.map((n) => (n.id === selected ? { ...n, ...changes } : n)) });
  const validation = definitionSchema.safeParse(definition);
  const runnable =
    validation.success &&
    definition.nodes.some((n) => n.kind === 'output') &&
    definition.nodes.every(
      (n) => n.kind !== 'agent' || Boolean(n.model.trim() && n.instructions.trim()),
    );
  const save = async () => {
    const value = unwrap(await window.sand.studio.save(definition));
    setDefinition(value);
    setSaved(unwrap(await window.sand.studio.definitions()));
    setDirty(false);
    setNotice('Đã lưu phiên bản ' + value.revision);
    return value;
  };
  const start = () =>
    action('Đang bắt đầu', async () => {
      const value = dirty || definition.revision === 0 ? await save() : definition;
      setRun(
        unwrap(
          await window.sand.studio.start({
            definition: value,
            input,
            allowCloud,
            key: crypto.randomUUID(),
          }),
        ),
      );
      setTab('run');
      setRetryConfirmed(false);
      await refresh();
    });
  const switchDefinition = (value: Definition) => {
    if (dirty) {
      setError('Lưu bản đang chỉnh trước khi đổi workflow.');
      return;
    }
    setDefinition(value);
    setSelected(value.nodes[0]!.id);
    setTab('design');
    setNotice('');
  };
  const add = (kind: StudioNode['kind']) => {
    const id = 'step_' + crypto.randomUUID().slice(0, 8);
    update({
      nodes: [
        ...definition.nodes,
        {
          id,
          name:
            kind === 'agent' ? 'Agent mới' : kind === 'review' ? 'Điểm duyệt mới' : 'Kết quả mới',
          kind,
          instructions: '',
          provider: 'ollama',
          model: '',
          dependsOn: node ? [node.id] : [],
          maxOutputTokens: 512,
        },
      ],
    });
    setSelected(id);
  };
  const suggest = () => {
    const local = models.filter((m) => m.provider === 'ollama');
    const choices = local.length ? local : models;
    let index = 0;
    update({
      nodes: definition.nodes.map((n) =>
        n.kind === 'agent' && !n.model && choices.length
          ? {
              ...n,
              provider: choices[index % choices.length]!.provider as StudioNode['provider'],
              model: choices[index++ % choices.length]!.modelId,
            }
          : n,
      ),
    });
  };
  const graph = tab === 'run' && run ? run.definition : definition;
  const levels = new Map<string, number>();
  for (let pass = 0; pass < graph.nodes.length; pass++)
    for (const n of graph.nodes)
      if (n.dependsOn.every((dep) => levels.has(dep)))
        levels.set(
          n.id,
          n.dependsOn.length ? Math.max(...n.dependsOn.map((d) => levels.get(d)!)) + 1 : 0,
        );
  const rows = new Map<number, number>();
  const positions = new Map(
    graph.nodes.map((n) => {
      const level = levels.get(n.id) ?? 0;
      const row = rows.get(level) ?? 0;
      rows.set(level, row + 1);
      return [n.id, { x: 32 + level * 270, y: 32 + row * 145 }];
    }),
  );
  const graphWidth = Math.max(750, 300 + Math.max(0, ...levels.values()) * 270),
    graphHeight = Math.max(330, 80 + Math.max(1, ...rows.values()) * 145);
  const pickedExecution = run?.nodes.find((n) => n.id === selected);
  const totalTokens = run?.events
    .filter(
      (e) =>
        e.type === 'model.turn_completed' ||
        (e.type === 'agent.completed' &&
          !run.events.some((t) => t.type === 'model.turn_completed' && t.nodeId === e.nodeId)),
    )
    .reduce(
      (sum, e) => sum + (typeof e.details.outputTokens === 'number' ? e.details.outputTokens : 0),
      0,
    );
  return (
    <div className="studio">
      <header className="studio-header">
        <div className="studio-brand">
          <span>S</span>
          <strong>SAND</strong>
          <small>WORKFLOW STUDIO</small>
        </div>
        <span className="studio-subtitle">Chuyên môn của bạn. Đội ngũ AI của bạn.</span>
        <button
          className="secondary"
          onClick={() => {
            if (dirty) {
              setError('Lưu workflow trước khi chuyển sang IDE.');
              return;
            }
            onOpenIDE();
          }}
        >
          <FileText size={15} />
          Mở IDE
        </button>
      </header>
      <aside className="studio-library">
        <div className="studio-section">
          <span className="eyebrow">WORKSPACE LOCAL</span>
          <h2>Workflow của bạn</h2>
          <button
            className="primary full"
            onClick={() => {
              if (dirty) {
                setError('Lưu workflow hiện tại trước khi tạo mới.');
                return;
              }
              const next = createTemplate();
              setDefinition(next);
              setSelected('analyst');
              setDirty(true);
              setTab('design');
            }}
          >
            <Plus size={15} />
            Tạo từ mẫu
          </button>
          <p className="studio-caption">
            Hai góc nhìn → tổng hợp → duyệt → báo cáo. Bạn sửa mọi bước.
          </p>
          {saved.map((item) => (
            <button
              className={'studio-list-item ' + (item.id === definition.id ? 'chosen' : '')}
              key={item.id}
              onClick={() => switchDefinition(item)}
            >
              <GitBranch size={14} />
              <span>
                {item.name}
                <small>Phiên bản {item.revision}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="studio-section">
          <div className="studio-row">
            <h3>Model kết nối</h3>
            <button
              className="icon-button"
              aria-label="Tìm model"
              disabled={!!busy}
              onClick={() => void discover()}
            >
              <RefreshCw size={15} />
            </button>
          </div>
          <p className="studio-caption">
            Ollama local hoặc OpenAI, OpenRouter, Anthropic, Gemini qua main process.
          </p>
          {providers.map((p) => (
            <div className="studio-provider" key={p.provider}>
              <span title={p.source}>
                {p.provider}
                <small className="studio-observed">{new Date(p.observedAt).toLocaleString()}</small>
              </span>
              <small>
                {p.status === 'available'
                  ? p.modelCount + ' model'
                  : p.status === 'unconfigured'
                    ? 'Chưa cấu hình'
                    : p.errorCode}
              </small>
            </div>
          ))}
          {!providers.length && (
            <button className="secondary full" disabled={!!busy} onClick={() => void discover()}>
              Kết nối / tìm model
            </button>
          )}
          <details>
            <summary>Hướng dẫn kết nối</summary>
            <p className="studio-caption">
              Ollama: chạy server trên 127.0.0.1:11434 và tải model trước. Cloud: đặt
              OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY hoặc GEMINI_API_KEY trong môi
              trường desktop rồi mở lại SAND. Không nhập secret vào ô tài liệu/chỉ dẫn. Tool loop
              hiện hỗ trợ Ollama/OpenAI/OpenRouter; model cần hỗ trợ native tool calling.
            </p>
          </details>
        </div>
        <Connections onToolsChanged={refreshTools} />
        <div className="studio-section">
          <button
            className="secondary full"
            disabled={!!busy}
            onClick={() =>
              void action('Mở workspace cho tools', async () => {
                const result = unwrap(await window.sand.repository.open());
                if (result) {
                  refreshTools();
                  setNotice('Workspace tools: ' + result.name);
                }
              })
            }
          >
            Chọn repository cho agent
          </button>
        </div>
        <div className="studio-section">
          <h3>Lịch sử thực thi</h3>
          {runs.map((r) => (
            <button
              key={r.id}
              className={'studio-list-item ' + (r.id === run?.id ? 'chosen' : '')}
              onClick={() =>
                void action('Tải lần chạy', async () => {
                  setRun(unwrap(await window.sand.studio.get(r.id)));
                  setTab('run');
                  setRetryConfirmed(false);
                })
              }
            >
              <Layers3 size={14} />
              <span>
                {r.name}
                <small>
                  {label(r.status)} · {new Date(r.createdAt).toLocaleTimeString()}
                </small>
              </span>
            </button>
          ))}
          {!runs.length && (
            <p className="studio-caption">
              Chưa có lần chạy. Không tạo dữ liệu mẫu thay cho kết quả.
            </p>
          )}
        </div>
      </aside>
      <main className="studio-main">
        <div className="studio-title">
          <div>
            <span className="eyebrow">LOW-CODE / MULTI-MODEL</span>
            <h1>Thiết kế đội ngũ AI của bạn</h1>
            <p>Mỗi bước có một nhiệm vụ rõ ràng. Mỗi kết quả đều có dấu vết.</p>
          </div>
          <span className="outline-pill">LOCAL MVP</span>
        </div>
        {(error || notice || busy) && (
          <div
            className={'studio-message ' + (error ? 'is-error' : '')}
            role={error ? 'alert' : 'status'}
          >
            {busy ? (
              <>
                <LoaderCircle size={14} className="spin" />
                {busy}
              </>
            ) : (
              error || notice
            )}
            <button
              className="icon-button"
              aria-label="Đóng thông báo"
              onClick={() => {
                setError('');
                setNotice('');
              }}
            >
              <X size={14} />
            </button>
          </div>
        )}
        <div className="studio-toolbar">
          <div className="studio-tabs">
            <button className={tab === 'design' ? 'active' : ''} onClick={() => setTab('design')}>
              Thiết kế
            </button>
            <button
              className={tab === 'run' ? 'active' : ''}
              disabled={!run}
              onClick={() => setTab('run')}
            >
              Lần chạy {run ? '· ' + label(run.status) : ''}
            </button>
          </div>
          {tab === 'design' ? (
            <>
              <button
                className="secondary"
                disabled={!!busy || !validation.success}
                onClick={() =>
                  void action('Đang lưu', async () => {
                    await save();
                  })
                }
              >
                <Save size={14} />
                Lưu {dirty ? '*' : ''}
              </button>
              <button
                className="primary"
                disabled={!!busy || !runnable || !input.trim()}
                onClick={() => void start()}
              >
                <Play size={14} />
                Chạy workflow
              </button>
            </>
          ) : (
            run && (
              <>
                <button
                  className="secondary"
                  disabled={!!busy || run.status !== 'completed'}
                  onClick={() =>
                    void action('Xuất báo cáo', async () => {
                      const file = unwrap(await window.sand.studio.export(run.id));
                      if (file) setNotice('Đã xuất: ' + file);
                    })
                  }
                >
                  <Download size={14} />
                  Xuất Markdown
                </button>
                <button
                  className="secondary"
                  disabled={!!busy || ['completed', 'cancelled'].includes(run.status)}
                  onClick={() =>
                    void action('Hủy lần chạy', async () =>
                      setRun(unwrap(await window.sand.studio.command(run.id, 'cancel'))),
                    )
                  }
                >
                  <Square size={13} />
                  Hủy
                </button>
              </>
            )
          )}
        </div>
        <div className="studio-canvas" aria-label="Sơ đồ workflow">
          <div style={{ width: graphWidth, height: graphHeight, position: 'relative' }}>
            <svg
              className="studio-wires"
              width={graphWidth}
              height={graphHeight}
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="studio-arrow"
                  markerWidth="8"
                  markerHeight="8"
                  refX="6"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L0,6 L6,3 z" fill="currentColor" />
                </marker>
              </defs>
              {graph.nodes.flatMap((n) =>
                n.dependsOn.map((dep) => {
                  const from = positions.get(dep),
                    to = positions.get(n.id);
                  if (!from || !to) return null;
                  return (
                    <path
                      key={dep + '-' + n.id}
                      d={
                        'M' +
                        (from.x + 225) +
                        ',' +
                        (from.y + 50) +
                        ' C' +
                        (from.x + 260) +
                        ',' +
                        (from.y + 50) +
                        ' ' +
                        (to.x - 30) +
                        ',' +
                        (to.y + 50) +
                        ' ' +
                        to.x +
                        ',' +
                        (to.y + 50)
                      }
                      markerEnd="url(#studio-arrow)"
                    />
                  );
                }),
              )}
            </svg>
            {graph.nodes.map((n, index) => {
              const state =
                tab === 'run' ? run?.nodes.find((s) => s.id === n.id)?.state : undefined;
              return (
                <button
                  key={n.id}
                  aria-label={'Chọn bước ' + n.name}
                  className={
                    'studio-node ' + (selected === n.id ? 'selected ' : '') + (state ?? '')
                  }
                  style={{ left: positions.get(n.id)!.x, top: positions.get(n.id)!.y }}
                  onClick={() => setSelected(n.id)}
                >
                  <span className="studio-node-label">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    {n.kind === 'agent' ? 'AGENT' : n.kind === 'review' ? 'BẠN DUYỆT' : 'ARTIFACT'}
                    {state && <em>{label(state)}</em>}
                  </span>
                  <strong>{n.name}</strong>
                  <small>
                    {n.kind === 'agent'
                      ? n.model || 'Chọn model để chạy'
                      : n.kind === 'review'
                        ? 'Dừng lại để bạn quyết định'
                        : 'Kết quả có provenance'}
                  </small>
                </button>
              );
            })}
          </div>
        </div>
        {tab === 'design' ? (
          <section className="studio-input">
            <div className="studio-row">
              <h2>Dữ liệu & mục tiêu</h2>
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() =>
                  void action('Nhập tài liệu', async () => {
                    const document = unwrap(await window.sand.studio.importText());
                    if (document) {
                      setInput(document.text);
                      setNotice('Đã nhập ' + document.name);
                    }
                  })
                }
              >
                <FileText size={14} />
                Nhập .txt / .md / .csv
              </button>
            </div>
            <textarea
              aria-label="Tài liệu đầu vào"
              placeholder="Dán tài liệu hoặc mô tả bài toán của bạn. Các agent chỉ nhận nội dung này và kết quả từ những bước được nối vào."
              value={input}
              maxLength={16000}
              onChange={(e) => setInput(e.target.value)}
            />
            <div className="studio-row">
              <span className="studio-caption">
                {input.length.toLocaleString()} / 16.000 ký tự · Không nhập credential hay dữ liệu
                chưa được phép chia sẻ.
              </span>
            </div>
            {definition.nodes.some((n) => n.kind === 'agent' && n.provider !== 'ollama') && (
              <label className="studio-consent">
                <input
                  type="checkbox"
                  checked={allowCloud}
                  onChange={(e) => setAllowCloud(e.target.checked)}
                />
                Tôi đồng ý gửi nội dung và kết quả liên quan tới các provider cloud đã chọn cho lần
                chạy này.
              </label>
            )}
            <p className="studio-caption">
              Chi phí: chưa biết nếu provider không báo. Token được ghi sau mỗi bước. Không tự đổi
              model hoặc tự retry request bị gián đoạn.
            </p>
            {!runnable && (
              <p className="studio-validation">
                {!validation.success
                  ? validation.error.issues[0]?.message
                  : 'Chọn model và chỉ dẫn cho từng agent, đồng thời giữ ít nhất một bước xuất kết quả.'}
              </p>
            )}
          </section>
        ) : (
          run && (
            <section className="studio-input">
              <div className="studio-row">
                <h2>Kết quả & kiểm soát</h2>
                <span className="state">{label(run.status)}</span>
              </div>
              <p className="studio-caption">
                {run.id} · Snapshot v{run.definition.revision} · {totalTokens} output tokens đã được
                provider báo
                {run.nodes.some(
                  (n) => n.state === 'completed' && n.result && n.result.outputTokens === null,
                )
                  ? ' (có bước chưa có usage)'
                  : ''}
              </p>
              <div className="studio-actions">
                {run.status === 'running' && (
                  <button
                    className="secondary"
                    onClick={() =>
                      void action('Tạm dừng', async () =>
                        setRun(unwrap(await window.sand.studio.command(run.id, 'pause'))),
                      )
                    }
                  >
                    <Pause size={14} />
                    Dừng nhận bước mới
                  </button>
                )}
                {['paused', 'failed', 'interrupted'].includes(run.status) && (
                  <>
                    <label className="studio-consent">
                      <input
                        type="checkbox"
                        checked={retryConfirmed}
                        onChange={(e) => setRetryConfirmed(e.target.checked)}
                      />
                      Tôi xác nhận tiếp tục; bước bị gián đoạn có thể gọi provider và tính phí lại.
                    </label>
                    <button
                      className="primary"
                      disabled={!retryConfirmed || !!busy}
                      onClick={() =>
                        void action('Tiếp tục', async () => {
                          setRun(unwrap(await window.sand.studio.command(run.id, 'resume')));
                          setRetryConfirmed(false);
                        })
                      }
                    >
                      <Play size={14} />
                      Tiếp tục từ checkpoint
                    </button>
                  </>
                )}
              </div>
              {approvals
                .filter((a) => a.state === 'pending')
                .map((a) => (
                  <div className="studio-review" key={a.id}>
                    <h3>Tool cần duyệt: {a.tool}</h3>
                    <p className="studio-caption">
                      Scope: một lần gọi · {a.nodeId} · {a.createdAt}. Kiểm tra đường dẫn, URL và
                      nội dung trước khi cấp quyền. Tool có thể sửa file hoặc gọi server bên ngoài.
                    </p>
                    <pre>{JSON.stringify(a.arguments, null, 2)}</pre>
                    <p className="studio-caption">
                      Arguments SHA-256: {a.argumentHash}
                      <br />
                      Manifest: {a.manifestHash}
                    </p>
                    <div className="studio-actions">
                      <button
                        className="primary"
                        disabled={!!busy || !['waiting', 'running', 'paused'].includes(run.status)}
                        onClick={() =>
                          void action('Duyệt tool', async () =>
                            setRun(
                              unwrap(await window.sand.studio.approveTool(run.id, a.id, true)),
                            ),
                          )
                        }
                      >
                        Cho phép đúng lần gọi này
                      </button>
                      <button
                        className="secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void action('Từ chối tool', async () =>
                            setRun(
                              unwrap(await window.sand.studio.approveTool(run.id, a.id, false)),
                            ),
                          )
                        }
                      >
                        Chặn tool
                      </button>
                    </div>
                  </div>
                ))}
              {run.nodes
                .filter(
                  (n) =>
                    n.state === 'waiting' &&
                    run.definition.nodes.find((d) => d.id === n.id)?.kind === 'review',
                )
                .map((n) => (
                  <div className="studio-review" key={n.id}>
                    <h3>
                      <ShieldCheck size={18} />
                      Cần bạn duyệt: {run.definition.nodes.find((s) => s.id === n.id)?.name}
                    </h3>
                    <pre>{n.output}</pre>
                    <div className="studio-actions">
                      <button
                        className="primary"
                        disabled={!!busy}
                        onClick={() =>
                          void action('Duyệt kết quả', async () =>
                            setRun(unwrap(await window.sand.studio.review(run.id, n.id, true))),
                          )
                        }
                      >
                        <Check size={14} />
                        Duyệt và tiếp tục
                      </button>
                      <button
                        className="secondary"
                        disabled={!!busy}
                        onClick={() =>
                          void action('Từ chối', async () =>
                            setRun(unwrap(await window.sand.studio.review(run.id, n.id, false))),
                          )
                        }
                      >
                        Từ chối
                      </button>
                    </div>
                  </div>
                ))}
              {pickedExecution && (
                <div className="studio-output">
                  <h3>{graph.nodes.find((n) => n.id === pickedExecution.id)?.name}</h3>
                  {pickedExecution.error && (
                    <p role="alert">
                      {pickedExecution.error}:{' '}
                      {help[pickedExecution.error] ??
                        'Kiểm tra cấu hình/model. Kết quả đã hoàn tất được giữ nguyên khi retry.'}
                    </p>
                  )}
                  {pickedExecution.result?.truncated && (
                    <p className="studio-validation">
                      Model đã chạm giới hạn output; nội dung có thể chưa đầy đủ.
                    </p>
                  )}
                  <pre>{pickedExecution.output ?? 'Chưa có kết quả ở bước này.'}</pre>
                  {pickedExecution.result && (
                    <p className="studio-caption">
                      {pickedExecution.result.provider} / {pickedExecution.result.requestedModel} ·
                      model báo: {pickedExecution.result.reportedModel ?? 'không có'} ·{' '}
                      {pickedExecution.result.durationMs} ms · chi phí{' '}
                      {pickedExecution.result.costUsd === null
                        ? 'chưa biết'
                        : pickedExecution.result.costUsd + ' USD (provider báo)'}{' '}
                      · {new Date(pickedExecution.result.observedAt).toLocaleString()}
                      {pickedExecution.result.costSource
                        ? ' · nguồn: ' + pickedExecution.result.costSource
                        : ''}
                    </p>
                  )}
                </div>
              )}
              {run.events.some((e) => e.type === 'tool.completed') && (
                <div className="studio-output">
                  <h3>Bằng chứng thực thi từ hệ thống</h3>
                  <p className="studio-caption">
                    Các receipt bên dưới đến từ tool broker; phần diễn giải của model vẫn cần kiểm
                    tra.
                  </p>
                  {run.events
                    .filter((e) => e.type === 'tool.completed')
                    .map((e) => (
                      <p key={e.sequence}>
                        <strong>{String(e.details.tool)}</strong> · đã lưu receipt · {e.at}
                        <br />
                        {e.details.resource
                          ? String(e.details.resource) +
                            ' · SHA-256 ' +
                            String(e.details.resultingFileHash)
                          : e.details.source
                            ? String(e.details.source)
                            : 'Output SHA-256 ' + String(e.details.outputHash)}
                      </p>
                    ))}
                </div>
              )}
              <details className="studio-events">
                <summary>Timeline & audit ({run.events.length})</summary>
                <button
                  className="secondary"
                  onClick={() =>
                    void action('Kiểm tra audit', async () => {
                      const result = unwrap(await window.sand.studio.verify(run.id));
                      setNotice(
                        result.valid
                          ? 'Hash chain hợp lệ: ' +
                              result.checked +
                              ' events. Chưa có external trust anchor.'
                          : 'Audit không hợp lệ.',
                      );
                    })
                  }
                >
                  Verify ledger
                </button>
                {run.events.map((e) => (
                  <div className="studio-event" key={e.sequence}>
                    <strong>
                      #{e.sequence} {e.type}
                    </strong>
                    <time>{new Date(e.at).toLocaleTimeString()}</time>
                    <code>{JSON.stringify(e.details)}</code>
                  </div>
                ))}
              </details>
            </section>
          )
        )}
      </main>
      <aside className="studio-inspector">
        {tab === 'design' ? (
          <>
            <span className="eyebrow">THIẾT LẬP WORKFLOW</span>
            <label>
              Tên workflow
              <input
                aria-label="Tên workflow"
                value={definition.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </label>
            <label>
              Số agent song song
              <select
                value={definition.concurrency}
                onChange={(e) => update({ concurrency: Number(e.target.value) })}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
            <div className="studio-add">
              <button disabled={definition.nodes.length >= 12} onClick={() => add('agent')}>
                <Plus size={13} />
                Agent
              </button>
              <button disabled={definition.nodes.length >= 12} onClick={() => add('review')}>
                <Plus size={13} />
                Duyệt
              </button>
              <button disabled={definition.nodes.length >= 12} onClick={() => add('output')}>
                <Plus size={13} />
                Output
              </button>
            </div>
            {node && (
              <>
                <div className="studio-inspector-divider" />
                <span className="eyebrow">BƯỚC ĐANG CHỌN</span>
                <label>
                  Tên bước
                  <input
                    aria-label="Tên bước"
                    value={node.name}
                    onChange={(e) => updateNode({ name: e.target.value })}
                  />
                </label>
                {node.kind === 'agent' && (
                  <>
                    <label>
                      Tool protocol
                      <select
                        aria-label="Tool protocol"
                        value={node.toolProtocol ?? 'native'}
                        onChange={(e) =>
                          updateNode({ toolProtocol: e.target.value as 'native' | 'json' })
                        }
                      >
                        <option value="native">Native tool calling</option>
                        <option value="json">Ollama JSON có schema kiểm tra</option>
                      </select>
                    </label>
                    <fieldset>
                      <legend>Công cụ được phép đề xuất</legend>
                      <p className="studio-caption">
                        Mặc định không có quyền. Mỗi lần gọi vẫn dừng để bạn duyệt tham số. Tối đa 6
                        model turns/agent và 24 tools/run.
                      </p>
                      {tools.map((t) => (
                        <label key={t.name} title={t.description} className="studio-consent">
                          <input
                            type="checkbox"
                            checked={node.tools?.includes(t.name) ?? false}
                            onChange={(e) =>
                              updateNode({
                                tools: e.target.checked
                                  ? [...(node.tools ?? []), t.name]
                                  : (node.tools ?? []).filter((x) => x !== t.name),
                              })
                            }
                          />
                          {t.name}
                        </label>
                      ))}
                      {node.tools
                        ?.filter((name) => !tools.some((t) => t.name === name))
                        .map((name) => (
                          <p className="studio-validation" key={name}>
                            {name}: unavailable — kết nối lại server/workspace.
                          </p>
                        ))}
                    </fieldset>
                    <label>
                      Model
                      <select
                        aria-label="Model của agent"
                        value={node.provider + '::' + node.model}
                        onChange={(e) => {
                          const [provider, ...model] = e.target.value.split('::');
                          updateNode({
                            provider: provider as StudioNode['provider'],
                            model: model.join('::'),
                          });
                        }}
                      >
                        <option value={node.provider + '::'}>Chọn model từ discovery</option>
                        {node.model &&
                          !models.some(
                            (m) => m.provider === node.provider && m.modelId === node.model,
                          ) && (
                            <option value={node.provider + '::' + node.model}>
                              {node.provider} / {node.model} (chưa kiểm tra kết nối)
                            </option>
                          )}
                        {models.map((m) => (
                          <option
                            key={m.provider + '::' + m.modelId}
                            value={m.provider + '::' + m.modelId}
                          >
                            {m.provider} / {m.modelId}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className="text-button" disabled={!models.length} onClick={suggest}>
                      Điền model cho các agent còn trống <ArrowRight size={13} />
                    </button>
                    <label>
                      Vai trò & chỉ dẫn
                      <textarea
                        aria-label="Chỉ dẫn agent"
                        value={node.instructions}
                        maxLength={8000}
                        onChange={(e) => updateNode({ instructions: e.target.value })}
                      />
                    </label>
                    <label>
                      Giới hạn output tokens
                      <input
                        aria-label="Giới hạn output"
                        type="number"
                        min={32}
                        max={4096}
                        value={node.maxOutputTokens}
                        onChange={(e) => updateNode({ maxOutputTokens: Number(e.target.value) })}
                      />
                    </label>
                  </>
                )}
                <fieldset>
                  <legend>Nhận kết quả từ bước nào?</legend>
                  {definition.nodes
                    .filter((n) => n.id !== node.id)
                    .map((n) => (
                      <label className="studio-dependency" key={n.id}>
                        <input
                          type="checkbox"
                          checked={node.dependsOn.includes(n.id)}
                          onChange={(e) =>
                            updateNode({
                              dependsOn: e.target.checked
                                ? [...node.dependsOn, n.id]
                                : node.dependsOn.filter((id) => id !== n.id),
                            })
                          }
                        />
                        {n.name}
                      </label>
                    ))}
                </fieldset>
                <p className="studio-caption">
                  Không nối đầu vào = đọc tài liệu gốc độc lập. Có kết nối = nhận thêm kết quả từ
                  đúng các bước đã chọn.
                </p>
                <button
                  className="studio-delete"
                  disabled={definition.nodes.length === 1}
                  onClick={() => {
                    update({
                      nodes: definition.nodes
                        .filter((n) => n.id !== node.id)
                        .map((n) => ({
                          ...n,
                          dependsOn: n.dependsOn.filter((id) => id !== node.id),
                        })),
                    });
                    setSelected(definition.nodes.find((n) => n.id !== node.id)!.id);
                  }}
                >
                  Xóa bước
                </button>
              </>
            )}
          </>
        ) : (
          <>
            <span className="eyebrow">PROVENANCE</span>
            <h2>Mỗi bước đều có dấu vết</h2>
            <p className="studio-caption">
              Chọn một node để xem nội dung thực tế, model, usage và lỗi. Prompt/output là dữ liệu,
              không phải quyền chạy tool.
            </p>
            <div className="studio-inspector-divider" />
            <ShieldCheck size={26} />
            <h3>Quyền có giới hạn</h3>
            <p className="studio-caption">
              Agent chỉ được đề xuất tools bạn đã chọn. Mỗi lần gọi cần duyệt đúng tham số; receipts
              và audit xác nhận tác động thật. Chưa có shell sandbox hoặc browser automation.
            </p>
            <button className="text-button" onClick={() => setTab('design')}>
              <ArrowLeft size={14} />
              Sửa workflow cho lần chạy mới
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
