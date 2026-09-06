import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import Editor from '@monaco-editor/react';
import { ArrowRight, Braces, Check, ChevronDown, ChevronRight, Circle, Command, FileCode2, Files, FolderOpen, GitBranch, GitCompareArrows, History, Layers3, LoaderCircle, Moon, Play, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Square, Sun, Unplug, Workflow, X } from 'lucide-react';
import type { DocumentFile, GitStatus, Repository, Run, RunEvent } from '../shared';
import { language } from './editor';
import { applyReplay } from './replay';

type View = 'files' | 'git' | 'runs' | 'models' | 'policy';
type Tab = DocumentFile & { dirty: boolean };
const titles: Record<View, string> = { files: 'Explorer', git: 'Source control', runs: 'Run history', models: 'Model registry', policy: 'Trust & capabilities' };
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

export function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [repo, setRepo] = useState<Repository | null>(null);
  const [view, setView] = useState<View>('files');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState('');
  const [filter, setFilter] = useState('');
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitError, setGitError] = useState('');
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [palette, setPalette] = useState(false);
  const [commandFilter, setCommandFilter] = useState('');
  const [online, setOnline] = useState(false);
  const [connectionError, setConnectionError] = useState('Checking control-plane connection…');
  const [projects, setProjects] = useState<Record<string, unknown>[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const eventCursor = useRef(0); const eventHistory = useRef<RunEvent[]>([]);
  const [models, setModels] = useState<Record<string, unknown>[]>([]); const [modelsLoading, setModelsLoading] = useState(false); const modelRequest = useRef(0);
  const [capabilities, setCapabilities] = useState<Record<string, unknown>[]>([]);
  const [auditResult, setAuditResult] = useState('Not verified in this session');
  const [startup] = useState(() => Math.round(performance.now()));
  const [panelLatency, setPanelLatency] = useState<number | null>(null);
  const [sideWidth, setSideWidth] = useState(250);
  const current = tabs.find(tab => tab.path === active);

  const refreshGit = useCallback(async () => {
    const result = await window.sand.repository.status();
    if (result.ok) { setGit(result.value); setGitError(''); } else { setGit(null); setGitError(result.error.message); }
  }, []);
  const openRepository = useCallback(async () => {
    if (tabs.some(tab => tab.dirty)) { setError('Save your open changes before opening another repository.'); return; }
    setBusy('Opening repository'); setError('');
    const result = await window.sand.repository.open();
    if (result.ok && result.value) { setRepo(result.value); setTabs([]); setActive(''); setDiff(null); setView('files'); await refreshGit(); }
    else if (!result.ok) setError(result.error.message);
    setBusy('');
  }, [tabs, refreshGit]);
  const openFile = async (file: string) => {
    setDiff(null); if (tabs.some(tab => tab.path === file)) { setActive(file); return; }
    setBusy('Reading file'); const result = await window.sand.repository.read(file);
    if (result.ok) { setTabs(previous => [...previous.filter(t => t.path !== file), { ...result.value, dirty: false }]); setActive(file); setError(''); }
    else setError(result.error.message);
    setBusy('');
  };
  const save = useCallback(async () => {
    if (!current || !current.dirty || busy) return;
    setBusy('Saving file'); setError(''); const snapshot = current;
    const result = await window.sand.repository.save({ repositoryId: snapshot.repositoryId, path: snapshot.path, content: snapshot.content, expectedHash: snapshot.hash, operationId: crypto.randomUUID() });
    if (result.ok) { setTabs(previous => previous.map(tab => tab.path === snapshot.path ? { ...tab, hash: result.value.hash, dirty: tab.content !== snapshot.content } : tab)); setNotice('Saved · recovery copy retained'); await refreshGit(); }
    else setError(result.error.message);
    setBusy('');
  }, [current, busy, refreshGit]);
  const refreshModels = useCallback(async () => {
    const request = ++modelRequest.current; setModelsLoading(true);
    const result = await window.sand.control.models();
    if (request !== modelRequest.current) return;
    if (result.ok) setModels(result.value); else setError(result.error.message);
    setModelsLoading(false);
  }, []);
  const connect = useCallback(async () => {
    const result = await window.sand.control.overview();
    if (!result.ok) { setOnline(false); setConnectionError(result.error.message); return; }
    setOnline(true); setConnectionError(''); setCapabilities(Array.isArray(result.value.capabilities) ? result.value.capabilities as Record<string, unknown>[] : []);
    const [projectResult, runResult] = await Promise.all([window.sand.control.projects(), window.sand.control.runs(), refreshModels()]);
    if (projectResult.ok) setProjects(projectResult.value); else setError(projectResult.error.message);
    if (runResult.ok) setRuns(runResult.value); else setError(runResult.error.message);
  }, [refreshModels]);
  useEffect(() => { void connect(); }, [connect]);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setPalette(p => !p); setCommandFilter(''); }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void openRepository(); }
      if (event.key === 'Escape') setPalette(false);
    };
    document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener);
  }, [save, openRepository]);
  useEffect(() => {
    if (!selectedRun || !online) return;
    let disposed = false; let pending = false;
    const poll = async () => {
      if (pending) return; pending = true;
      const result = await window.sand.control.events(selectedRun.id, eventCursor.current);
      if (!disposed && result.ok) {
        try {
          const previousCursor = eventCursor.current; const replayed = applyReplay({ cursor: eventCursor.current, events: eventHistory.current }, selectedRun.id, result.value);
          eventCursor.current = replayed.cursor; eventHistory.current = replayed.events; setEvents(replayed.events);
          if (replayed.events.some(event => event.sequence > previousCursor && event.type === 'registry.refreshed')) void refreshModels();
        } catch (error) { setError(error instanceof Error ? error.message : 'Timeline replay failed.'); }
        const runResult = await window.sand.control.runs();
        if (!disposed && runResult.ok) { setRuns(runResult.value); setSelectedRun(previous => runResult.value.find(run => run.id === previous?.id) || previous); }
      } else if (!disposed && !result.ok) { setConnectionError(result.error.message); setOnline(false); }
      pending = false;
    };
    void poll(); const interval = setInterval(() => void poll(), 2000);
    return () => { disposed = true; clearInterval(interval); };
  }, [selectedRun?.id, online, refreshModels]);
  const selectRun = (run: Run) => { eventCursor.current = 0; eventHistory.current = []; setEvents([]); setSelectedRun(run); setView('runs'); };
  const launch = async () => {
    const projectId = projects[0]?.id; if (typeof projectId !== 'string') { setError('No control-plane project is available. Configure the local project first.'); return; }
    setBusy('Submitting durable run');
    const result = await window.sand.control.create(projectId, crypto.randomUUID());
    if (result.ok) { setRuns(previous => [result.value, ...previous.filter(run => run.id !== result.value.id)]); selectRun(result.value); }
    else setError(result.error.message);
    setBusy('');
  };
  const cancel = async () => {
    if (!selectedRun) return; const result = await window.sand.control.cancel(selectedRun.id, crypto.randomUUID());
    if (result.ok) setSelectedRun(result.value); else setError(result.error.message);
  };
  const navigate = (next: View) => { const begin = performance.now(); setView(next); setDiff(null); if (next === 'models' && online) void refreshModels(); window.requestAnimationFrame(() => setPanelLatency(Math.round(performance.now() - begin))); };
  const showDiff = async (file: string) => { const result = await window.sand.repository.diff(file); if (result.ok) { setActive(file); setDiff(result.value); } else setError(result.error.message); };
  const closeTab = (file: string) => { const tab = tabs.find(t => t.path === file); if (tab?.dirty) { setError('Save this file before closing it. Your edits are retained.'); return; } setTabs(previous => previous.filter(t => t.path !== file)); if (active === file) setActive(tabs.find(t => t.path !== file)?.path || ''); };
  const commands = [
    { label: 'Open repository', shortcut: 'Ctrl Shift O', action: () => void openRepository() },
    { label: 'Save current file', shortcut: 'Ctrl S', action: () => void save() },
    { label: 'View source control', shortcut: '', action: () => navigate('git') },
    { label: 'View run history', shortcut: '', action: () => navigate('runs') },
    { label: 'View model registry', shortcut: '', action: () => navigate('models') },
    { label: 'Reconnect control plane', shortcut: '', action: () => void connect() },
    { label: 'Use ' + (theme === 'light' ? 'dark' : 'light') + ' theme', shortcut: '', action: () => setTheme(theme === 'light' ? 'dark' : 'light') }
  ];

  return <div className="app" style={{ '--sidebar-width': sideWidth + 'px' } as CSSProperties}>
    <header className="topbar"><div className="brand" aria-label="SAND"><span className="brand-mark">s</span><strong>SAND</strong><span className="preview-label">PREVIEW</span></div><div className="breadcrumb">Workbench <ChevronRight size={13}/><span>{repo?.name || 'Your workspace'}</span></div><button className="command-trigger" onClick={() => { setPalette(true); setCommandFilter(''); }}><Search size={14}/><span>Search commands</span><kbd>Ctrl K</kbd></button><div className="top-actions"><span className="local-pill"><span/>Local development</span><button className="icon-button" aria-label={'Use ' + (theme === 'light' ? 'dark' : 'light') + ' theme'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? <Moon size={16}/> : <Sun size={16}/>}</button></div></header>
    <nav className="activity" aria-label="Workbench views">{([{ id: 'files', icon: Files }, { id: 'git', icon: GitBranch }, { id: 'runs', icon: Workflow }, { id: 'models', icon: Layers3 }, { id: 'policy', icon: ShieldCheck }] as const).map(item => <button key={item.id} className={'activity-button ' + (view === item.id ? 'active' : '')} title={titles[item.id]} aria-label={titles[item.id]} aria-current={view === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}><item.icon size={20}/>{item.id === 'git' && !!git?.entries.length && <span className="nav-count">{git.entries.length}</span>}</button>)}<div className="activity-bottom"><span className="avatar" title="Local user">L</span></div></nav>
    <aside className="sidebar"><div className="panel-heading"><h2>{titles[view]}</h2><button className="icon-button" aria-label="Refresh current view" onClick={() => { if (view === 'git') void refreshGit(); else if (view === 'files' && repo) void window.sand.repository.list().then(result => result.ok ? setRepo(result.value) : setError(result.error.message)); else void connect(); }}><RefreshCw size={14}/></button></div>
      {view === 'files' && <><button className="repository-button" onClick={() => void openRepository()}><FolderOpen size={16}/><span>{repo?.name || 'Open repository'}</span><ChevronDown size={13}/></button>{repo ? <><label className="filter"><Search size={13}/><input aria-label="Filter files" placeholder="Filter files by name…" value={filter} onChange={e => setFilter(e.target.value)}/></label><div className="tree-caption"><span>FILES</span><span>{repo.files.length}{repo.truncated ? '+' : ''}</span></div><div className="file-tree" role="list" aria-label="Repository files">{repo.files.filter(file => file.toLowerCase().includes(filter.toLowerCase())).map(file => <button role="listitem" title={file} key={file} className={'file-row ' + (active === file ? 'selected' : '')} onClick={() => void openFile(file)}><FileCode2 size={14}/><span>{file}</span>{tabs.find(t => t.path === file)?.dirty && <i className="dirty-dot"/>}</button>)}</div><div className="sidebar-note"><ShieldCheck size={14}/><span>Metadata, credential files and links are excluded.</span></div></> : <div className="sidebar-empty"><FolderOpen size={28}/><p>A place for your code.</p><span>Choose a local folder to browse and edit real files.</span></div>}</>}
      {view === 'git' && <>{git ? <><div className="branch-card"><GitBranch size={15}/><strong>{git.branch}</strong><span>local</span></div><div className="tree-caption"><span>CHANGES</span><span>{git.entries.length}</span></div><div className="file-tree">{git.entries.map(entry => <button className="file-row" key={entry.path} onClick={() => void showDiff(entry.path)}><span className="git-code">{entry.status.trim()}</span><span>{entry.path}</span></button>)}{!git.entries.length && <p className="muted small inset">Working tree is clean.</p>}</div><div className="sidebar-note"><ShieldCheck size={14}/><span>Status and unstaged diff only. Commit and remote operations are unavailable in this slice.</span></div></> : <div className="sidebar-empty"><GitBranch size={28}/><p>Git is unavailable</p><span>{gitError || 'Open a repository to inspect its changes.'}</span></div>}</>}
      {view === 'runs' && <><div className="tree-caption"><span>PERSISTED RUNS</span><span>{runs.length}</span></div><div className="run-list">{runs.map(run => <button className={'run-row ' + (selectedRun?.id === run.id ? 'selected' : '')} key={run.id} onClick={() => selectRun(run)}><div><Workflow size={15}/><strong>Registry refresh</strong></div><span>{run.id.slice(0, 8)} · {time(run.createdAt)}</span><span className={'state ' + run.status}>{run.status.replaceAll('_', ' ')}</span></button>)}{!runs.length && <div className="sidebar-empty"><History size={28}/><p>No runs loaded</p><span>{online ? 'Launch model discovery to create a persisted workflow.' : 'Connect the control plane to load durable history.'}</span></div>}</div></>}
      {view === 'models' && <div className="sidebar-empty"><Layers3 size={28}/><p>Live, with evidence.</p><span>Models are discovered from configured provider APIs. Unknown pricing stays unknown.</span><button className="text-button" disabled={!online || !!busy} onClick={() => void launch()}>Refresh discovery <ArrowRight size={14}/></button></div>}
      {view === 'policy' && <div className="sidebar-empty"><ShieldCheck size={28}/><p>Explicit authority.</p><span>Repository access starts with your native folder selection. Agent execution remains unavailable.</span><div className="policy-tag">desktop-user-selected-v1</div></div>}
      <div className="sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" tabIndex={0} onKeyDown={e => { if (e.key === 'ArrowRight') setSideWidth(w => Math.min(420, w + 10)); if (e.key === 'ArrowLeft') setSideWidth(w => Math.max(190, w - 10)); }} onPointerDown={e => { const element = e.currentTarget; element.setPointerCapture(e.pointerId); const move = (event: PointerEvent) => setSideWidth(Math.max(190, Math.min(420, event.clientX - 58))); const end = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); }; element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); }}/>
    </aside>
    <main className="workspace"><div className="editor-tabs" role="tablist" aria-label="Open editors"><button role="tab" aria-selected={!active} className={'editor-tab ' + (!active ? 'active' : '')} onClick={() => { setActive(''); setDiff(null); }}><Braces size={14}/>Overview</button>{tabs.map(tab => <div className={'editor-tab ' + (active === tab.path ? 'active' : '')} key={tab.path}><button role="tab" aria-selected={active === tab.path} onClick={() => { setActive(tab.path); setDiff(null); }}><FileCode2 size={13}/>{tab.path.split('/').pop()}{tab.dirty && <span className="dirty-dot"/>}</button><button className="close-tab" aria-label={'Close ' + tab.path} onClick={() => closeTab(tab.path)}><X size={12}/></button></div>)}<span className="tab-spacer"/><button className="icon-button" aria-label="Open another repository" onClick={() => void openRepository()}><Plus size={15}/></button></div>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={14}/></button></div>}
      {view === 'models' ? <section className="content-page"><div className="eyebrow">INTELLIGENCE / REGISTRY</div><h1>Your models. Their sources.</h1><p className="page-lead">Discovery records from your control plane. No model or price is assumed.</p><div className="section-divider"/>{modelsLoading && <div className="loading" role="status"><LoaderCircle className="spin" size={16}/>Refreshing model records from the control plane…</div>}{models.length ? <div className="model-list">{models.map((model, index) => <article className="model-card" key={String(model.modelId || index)}><Layers3 size={20}/><div><strong>{String(model.displayName || model.modelId || 'Unnamed discovery record')}</strong><p>{String(model.provider || 'Unknown provider')}</p><span className="mono">{String(model.modelId || '')}</span><p>Source: {String(model.source || 'Unknown')}<br/>Observed: {model.observedAt ? new Date(String(model.observedAt)).toLocaleString() : 'Unknown'}</p><span>Pricing: {model.pricing ? 'Source metadata available; cost routing unavailable' : 'Unknown'}</span></div></article>)}</div> : modelsLoading ? null : <div className="blank-panel"><Layers3 size={34}/><h3>No models have been discovered</h3><p>Configure provider credentials in the trusted worker process and run a registry refresh. Inference and cost routing are unavailable in this preview.</p><button className="primary" disabled={!online || !!busy} onClick={() => void launch()}><RefreshCw size={15}/>Refresh registry</button></div>}</section>
      : view === 'policy' ? <section className="content-page"><div className="eyebrow">TRUST / CAPABILITIES</div><h1>Know what has authority.</h1><p className="page-lead">Capabilities reflect the connected service. Unavailable actions cannot run.</p><div className="capability-row"><span><FolderOpen size={18}/>Local repository broker</span><span className="state completed">User-selected access</span></div><div className="capability-row"><span><ShieldCheck size={18}/>Desktop audit</span><span className="muted">Local hash-chained ledger</span></div>{capabilities.map((cap, index) => <div className="capability-row" key={String(cap.id || index)}><span>{String(cap.id)}</span><span className={'state ' + (cap.status === 'available' ? 'completed' : '')} title={String(cap.reason || '')}>{String(cap.status)}</span></div>)}<div className="unavailable-list"><strong>Not available in this slice</strong><p>Terminal & PTY · LSP · GitHub App · Agent code execution · MCP · Browser automation · Production identity · Signed updates</p><span>These features require their own implementation and verification gates.</span></div><div className="audit-card"><div><ShieldCheck size={20}/><strong>Control-plane audit integrity</strong></div><p aria-live="polite">{auditResult}</p><button className="secondary" disabled={!online} onClick={() => void window.sand.control.verify().then(result => result.ok ? setAuditResult(result.value.valid ? 'Verified ' + String(result.value.checked) + ' records. External anchor is not configured.' : 'Integrity verification failed.') : setError(result.error.message))}>Verify ledger</button></div></section>
      : view === 'runs' && selectedRun ? <section className="content-page timeline-page"><div className="eyebrow">EXECUTION / DURABLE HISTORY</div><div className="title-row"><h1>Registry refresh</h1><span className={'state ' + selectedRun.status}>{selectedRun.status.replaceAll('_', ' ')}</span></div><p className="mono muted small">{selectedRun.id}</p><div className="run-meta"><div><span>WORKFLOW</span><strong>registry.refresh</strong></div><div><span>DELIVERY</span><strong>Persisted REST replay</strong></div><div><span>CURSOR</span><strong>{eventCursor.current}</strong></div></div><div className="section-title"><h2>Run timeline</h2>{!terminalStatuses.has(selectedRun.status) && <button className="secondary" onClick={() => void cancel()} disabled={selectedRun.status === 'cancellation_requested'}><Square size={12}/>Request cancellation</button>}</div><div className="timeline">{events.map(event => <article className="event" key={event.id}><div className="event-dot"><Circle size={10}/></div><div className="event-body"><div><strong>{event.type}</strong><time>{time(event.at)}</time></div><span>Sequence {event.sequence} · schema v{event.schemaVersion}</span><pre>{JSON.stringify(event.payload, null, 2)}</pre></div></article>)}{!events.length && <p className="muted">{online ? 'Waiting for persisted events…' : 'Reconnect to replay from the last verified cursor.'}</p>}</div></section>
      : diff !== null ? <section className="diff-view"><div className="editor-path"><GitCompareArrows size={14}/>{active}<span>Unstaged diff</span></div>{diff ? <pre>{diff.split('\n').map((line, i) => <div key={i} className={line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : line.startsWith('@@') ? 'diff-hunk' : ''}>{line || ' '}</div>)}</pre> : <div className="blank-panel"><GitCompareArrows size={30}/><h3>No unstaged diff</h3><p>Untracked and staged-only files do not have an unstaged patch.</p></div>}</section>
      : current ? <section className="editor-surface"><div className="editor-path"><FileCode2 size={13}/><span>{current.path}</span><span className="editor-path-right">{current.dirty ? 'Unsaved changes' : 'Saved on disk'}<button className="save-button" disabled={!current.dirty || !!busy} onClick={() => void save()}><Check size={13}/>Save</button></span></div><Editor path={current.path} language={language(current.path)} value={current.content} onChange={value => setTabs(previous => previous.map(tab => tab.path === active ? { ...tab, content: value ?? '', dirty: true } : tab))} theme={theme === 'light' ? 'sand-light' : 'sand-dark'} loading={<div className="loading"><LoaderCircle size={18}/>Loading local editor…</div>} options={{ editContext: false, automaticLayout: true, minimap: { enabled: false }, fontSize: 13, lineHeight: 22, fontFamily: "'Cascadia Code', 'Consolas', monospace", padding: { top: 20, bottom: 20 }, scrollBeyondLastLine: false, renderLineHighlight: 'line', tabSize: 2, wordWrap: 'off', ariaLabel: 'Editor content ' + current.path, quickSuggestions: false, unicodeHighlight: { ambiguousCharacters: true }, stickyScroll: { enabled: false } }}/></section>
      : <section className="welcome"><div className="welcome-top"><span className="eyebrow">AN ENGINEERING WORKBENCH, WITH A MEMORY</span><span className="version">FOUNDATION / 01</span></div><div className="welcome-hero"><div className="hero-mark" aria-hidden="true"><span/><span/><span/><span/><span/></div><div className="eyebrow">MAKE ROOM FOR GOOD WORK.</div><h1>Build with<br/>a clear trail.</h1><p>Your code in focus. Every run in context.<br/>A workspace designed for work you can verify.</p><button className="primary" onClick={() => void openRepository()} disabled={!!busy}><FolderOpen size={16}/>{repo ? 'Open another repository' : 'Open a repository'}<ArrowRight size={15}/></button><span className="hero-shortcut">or <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>O</kbd></span></div><div className="welcome-features"><div><span className="feature-number">01</span><FileCode2 size={20}/><h3>Start with your source.</h3><p>Local files, a real editor, and conflict-aware saves with recovery copies.</p><button onClick={() => { if (repo) navigate('files'); else void openRepository(); }}>Explore repository <ArrowRight size={13}/></button></div><div><span className="feature-number">02</span><History size={20}/><h3>Keep the whole story.</h3><p>Connect durable workflows and replay the events your client has missed.</p><button onClick={() => navigate('runs')}>Open run history <ArrowRight size={13}/></button></div><div><span className="feature-number">03</span><ShieldCheck size={20}/><h3>See the boundaries.</h3><p>Understand what can run, what is unavailable, and what needs verification.</p><button onClick={() => navigate('policy')}>Inspect capabilities <ArrowRight size={13}/></button></div></div><div className="welcome-footer"><span className="tiny-dot"/>Local repository slice · no repository code runs automatically<span>SAND / ENGINEERING WITH EVIDENCE</span></div></section>}
    </main>
    <aside className="control-room"><div className="panel-heading"><h2><Workflow size={15}/>Control room</h2><span className="outline-pill">LOCAL</span></div><div className="control-content"><div className="section-title"><span className="eyebrow">CONNECTION</span><button className="icon-button" aria-label="Reconnect control plane" onClick={() => void connect()}><RefreshCw size={13}/></button></div><div className={'connection-card ' + (online ? 'connected' : '')}><div><span className={'connection-dot ' + (online ? 'online' : '')}/><strong>{online ? 'Control plane connected' : 'Control plane unavailable'}</strong></div><p>{online ? 'Development identity · loopback connection. Run state is read from the service.' : connectionError}</p>{!online && <button className="text-button" onClick={() => void connect()}>Reconnect <ArrowRight size={13}/></button>}</div><div className="section-title room-divider"><span className="eyebrow">NEW RUN</span><span className="mono muted">01</span></div><div className="run-launch"><div className="launch-icon"><Layers3 size={22}/></div><h3>Refresh model registry</h3><p>Discover models from your configured providers through a persisted workflow.</p><div className="key-value"><span>Project</span><strong>{projects[0] ? String(projects[0].name) : 'Unavailable'}</strong></div><div className="key-value"><span>Worker</span><strong>{online ? 'Temporal queue' : 'Unavailable'}</strong></div><div className="key-value"><span>Inference</span><strong>Not available</strong></div><button className="primary full" disabled={!online || !projects.length || !!busy} onClick={() => void launch()}><Play size={13}/>Start discovery<ArrowRight size={14}/></button><div className="inline-note"><ShieldCheck size={12}/>No repository content is submitted.</div></div><div className="section-title room-divider"><span className="eyebrow">COST & PROVENANCE</span><SlidersHorizontal size={13}/></div><div className="cost-card"><span>Usage cost</span><strong>Unknown <span>—</span></strong><p>No priced inference has been recorded. Source and observation time are required before showing a cost.</p></div></div><div className="control-footer"><Unplug size={14}/><span>Agent execution is unavailable.<br/>This is a development preview.</span></div></aside>
    <footer className="statusbar"><div><span className="status-brand">S</span>{git ? <span><GitBranch size={12}/>{git.branch}</span> : <span><FolderOpen size={12}/>{repo?.name || 'No repository'}</span>}<span className="status-separator"/><span>{busy ? <><LoaderCircle className="spin" size={12}/>{busy}</> : notice ? <><Check size={12}/>{notice}</> : <><ShieldCheck size={12}/>Local file policy active</>}</span></div><div><span><span className={'connection-dot ' + (online ? 'online' : '')}/>{online ? 'Service online' : 'Service offline'}</span><span title="Renderer initialization elapsed time; not a production startup benchmark">UI {startup} ms</span>{panelLatency !== null && <span>Panel {panelLatency} ms</span>}<span>UTF-8</span><button aria-label="Open command palette" onClick={() => setPalette(true)}><Command size={12}/></button></div></footer>
    {palette && <div className="palette-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setPalette(false); }}><div className="palette" role="dialog" aria-modal="true" aria-label="Command palette"><div className="palette-input"><ChevronRight size={18}/><input autoFocus aria-label="Search commands" placeholder="What would you like to do?" value={commandFilter} onChange={e => setCommandFilter(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { const command = commands.find(c => c.label.toLowerCase().includes(commandFilter.toLowerCase())); if (command) { setPalette(false); command.action(); } } if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); const items = e.currentTarget.closest('[role="dialog"]')?.querySelectorAll<HTMLElement>('input,button'); items?.[items.length - 1]?.focus(); } }}/><kbd>Esc</kbd></div><div className="palette-caption">WORKBENCH COMMANDS</div>{commands.filter(command => command.label.toLowerCase().includes(commandFilter.toLowerCase())).map((command, index, array) => <button key={command.label} onClick={() => { setPalette(false); command.action(); }} onKeyDown={e => { if (e.key === 'Tab' && !e.shiftKey && index === array.length - 1) { e.preventDefault(); e.currentTarget.closest('[role="dialog"]')?.querySelector('input')?.focus(); } }}><span>{command.label}</span>{command.shortcut ? <kbd>{command.shortcut}</kbd> : <ArrowRight size={13}/>}</button>)}<div className="palette-footer"><Command size={12}/>Type to filter · Enter to run · Escape to close</div></div></div>}
  </div>;
}





