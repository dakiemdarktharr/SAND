import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { TextInference } from '../../packages/studio/src/inference.js';
import { StudioRuntime } from '../../packages/studio/src/runtime.js';
import { createTemplate } from '../../packages/studio/src/schema.js';

// Actual local inference only: missing models/server fail the demo, never simulate success.
const started=performance.now();
await mkdir('.runtime',{recursive:true});
const directory=await mkdtemp(path.resolve('.runtime/studio-demo-'));
const file=path.join(directory,'studio.sqlite');
// The local demo deliberately does not use cloud credentials from the environment.
const inference=new TextInference({SAND_OLLAMA_ORIGIN:process.env.SAND_OLLAMA_ORIGIN});
const discovery=await inference.discover();
const models=discovery.models.filter(m=>m.provider==='ollama');
assert(models.length>=2,'Start Ollama and install at least two text/chat models before this multi-model demo.');
const selected=process.env.SAND_DEMO_MODELS?.split(',')??models.slice(0,2).map(m=>m.modelId);
assert(selected.length===2&&new Set(selected).size===2&&selected.every(id=>models.some(m=>m.modelId===id)),'SAND_DEMO_MODELS must contain two distinct locally discovered model IDs, separated by a comma.');
const definition=createTemplate();
definition.name='Local multi-model evidence demo';
let index=0;
for(const node of definition.nodes)if(node.kind==='agent'){
  node.model=selected[index++%2]!;
  node.maxOutputTokens=96;
  node.instructions=node.id==='analyst'?'Summarize the supplied project brief in two short English sentences. Do not invent facts.':node.id==='critic'?'Identify one missing requirement in the supplied brief. Answer in one short English sentence.':'Combine the upstream analysis and critique in at most three short English sentences. Distinguish facts from missing information. Do not invent facts.';
}
let runtime=new StudioRuntime(file,inference);
try {
  const saved=runtime.save(definition);
  const operationKey=crypto.randomUUID();
  const run=runtime.start(saved,'Example project brief for this demo: A museum curator wants volunteers to summarize public exhibit notes. A curator must approve each summary before it is published. No budget or deadline has been specified.',false,operationKey);
  let cursor=0;
  const deadline=Date.now()+540_000;
  while(true){
    const current=runtime.get(run.id);
    for(const event of current.events.filter(e=>e.sequence>cursor)){console.log(JSON.stringify({event:event.type,sequence:event.sequence,at:event.at,node:event.nodeId,...event.details}));cursor=event.sequence;}
    if(current.status==='waiting')break;
    assert.equal(current.status,'running','Inference failed; inspect events. No synthetic fallback is available.');
    assert(Date.now()<deadline,'Demo deadline exceeded');
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  const before=runtime.get(run.id);
  assert.equal(before.nodes.filter(n=>n.result).length,3);
  assert.throws(()=>runtime.artifact(run.id));
  assert.equal(runtime.start(saved,before.input,false,operationKey).id,run.id);
  runtime.close();
  runtime=new StudioRuntime(file,inference);
  const restored=runtime.get(run.id);
  assert.deepEqual(restored.events,before.events);
  assert.equal(restored.status,'waiting');
  console.log(JSON.stringify({event:'demo.restored',runId:run.id,preservedEvents:restored.events.length,providerCallsReplayed:0}));
  // This CLI demonstration explicitly approves its own non-sensitive example.
  runtime.review(run.id,'review',true);
  const completed=runtime.get(run.id);
  assert.equal(completed.status,'completed');
  assert.deepEqual(completed.nodes.filter(n=>n.result).map(n=>n.attempt),[1,1,1]);
  const audit=runtime.verify(run.id);assert(audit.valid);
  const summary={observedAt:new Date().toISOString(),platform:process.platform,node:process.version,runId:run.id,status:completed.status,models:selected,realProviderCalls:3,restoredEvents:restored.events.length,audit,elapsedMs:Math.round(performance.now()-started),steps:completed.nodes.filter(n=>n.result).map(n=>({id:n.id,attempt:n.attempt,...n.result,text:undefined})),cost:'Unknown; local electricity/hardware cost is not estimated',claims:'One real local run; not a quality, p95, crash/power-loss, or cloud benchmark'};
  await writeFile(path.join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n');
  await writeFile(path.join(directory,'audit.jsonl'),completed.events.map(e=>JSON.stringify(e)).join('\n')+'\n');
  await writeFile(path.join(directory,'report.md'),runtime.artifact(run.id));
  console.log(JSON.stringify({event:'demo.completed',...summary,directory}));
} finally {runtime.close();}
