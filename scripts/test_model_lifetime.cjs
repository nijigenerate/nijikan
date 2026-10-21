const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');const assert=require('node:assert/strict');
const [appUrl, modelA, modelB, output='test-output/lifetime'] = process.argv.slice(2);
if (!appUrl || !modelA || !modelB) throw new Error('Usage: node scripts/test_model_lifetime.cjs APP_URL MODEL_A_URL MODEL_B_URL [OUTPUT_DIR]');
fs.mkdirSync(output,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});try{
const page=await browser.newPage({viewport:{width:1100,height:900},serviceWorkers:'block'});const logs=[];page.on('console',m=>logs.push(m.type()+': '+m.text()));page.on('pageerror',e=>logs.push('ERROR '+e.message));
const expectedRevision=process.env.NICXLIVE_EXPECTED_REVISION;
const artifactChecks=[];let buildInfo;
if(expectedRevision){
 const response=await page.request.get(new URL('wasm/build-info.json',appUrl).href);
 assert(response.ok(),'WASM build provenance unavailable');
 buildInfo=JSON.parse((await response.text()).replace(/^\uFEFF/,''));
 assert.equal(buildInfo.revision,expectedRevision,'Unexpected nicxlive revision');
 assert.equal(buildInfo.sourceModified,false,'WASM built from modified source');
 page.on('response',response=>{
  const file=new URL(response.url()).pathname.split('/').pop();
  if(file==='nicxlive.js'||file==='nicxlive.wasm'){
   const checked=response.body().then(body=>({file,sha256:require('node:crypto').createHash('sha256').update(body).digest('hex')}));
   artifactChecks.push(checked);
  }
 });
}
await page.addInitScript(()=>{window.audit={draws:0,errors:[],sets:{}};for(const kind of ['Texture','Buffer','Framebuffer','Program','VertexArray']){const set=new Set();window.audit.sets[kind]=set;const p=WebGL2RenderingContext.prototype,c=p['create'+kind],d=p['delete'+kind];p['create'+kind]=function(...a){const o=c.apply(this,a);if(o)set.add(o);return o};p['delete'+kind]=function(o){set.delete(o);return d.call(this,o)}};for(const name of ['drawElements','drawArrays']){const orig=WebGL2RenderingContext.prototype[name];WebGL2RenderingContext.prototype[name]=function(...a){orig.apply(this,a);window.audit.draws++;const e=this.getError();if(e)window.audit.errors.push(e)}}});
await page.addInitScript(()=>{
 window.lifetimeAudit={instances:0,unloads:[],destroyed:0,allocations:new Set(),callbacks:new Set(),memory:null,module:null};
 const remember=(result,imports)=>{const inst=result.instance||result;window.lifetimeAudit.instances++;window.lifetimeAudit.memory=Object.values(inst.exports).find(x=>x instanceof WebAssembly.Memory)||Object.values(imports||{}).flatMap(x=>Object.values(x)).find(x=>x instanceof WebAssembly.Memory);return result};
 for(const name of ['instantiate','instantiateStreaming']){const orig=WebAssembly[name];WebAssembly[name]=async function(...args){return remember(await orig.apply(this,args),args[1])};}
 window.addEventListener('nicx-runtime-ready',()=>{
  const m=window.Module,a=window.lifetimeAudit;a.module=m;a.initialMemory=a.memory;
  for(const [create,remove,set] of [['_malloc','_free',a.allocations],['addFunction','removeFunction',a.callbacks]]){
   const c=m[create],d=m[remove];m[create]=function(...args){const p=c.apply(this,args);if(p)set.add(p);return p};m[remove]=function(p){set.delete(p);return d.call(this,p)};
  }
  const unload=m._njgUnloadPuppet;m._njgUnloadPuppet=function(...args){const r=unload.apply(this,args);a.unloads.push(r);return r};
  const destroy=m._njgDestroyRenderer;m._njgDestroyRenderer=function(...args){const r=destroy.apply(this,args);a.destroyed++;return r};
 });
});
await page.goto(appUrl);
const urls=[modelA,modelB,modelA,modelB,modelA,modelB,modelA];const results=[];
for(let i=0;i<urls.length;i++){
 const before=await page.evaluate(()=>window.audit.draws);
 await page.evaluate(u=>{const e=document.querySelector('#modelCombo');e.value=u;e.dispatchEvent(new Event('change'))},urls[i]);
 await page.waitForFunction(n=>window.audit.draws>n+500,before,{timeout:60000});
 await page.evaluate(()=>document.querySelector('#stop').click());await page.waitForTimeout(100);
 await page.screenshot({path:output+'/visible-'+i+'.png'});
 results.push(await page.evaluate(()=>({draws:window.audit.draws,errors:window.audit.errors,resources:Object.fromEntries(Object.entries(window.audit.sets).map(([k,v])=>[k,v.size])),params:[...document.querySelectorAll('#paramPanel code')].map(e=>e.textContent)})));
 await page.evaluate(()=>document.querySelector('#hideModel').click());
 await page.waitForTimeout(100);
 await page.screenshot({path:output+'/hidden-'+i+'.png'});
 const hidden=await page.evaluate(()=>({draws:window.audit.draws,errors:window.audit.errors,resources:Object.fromEntries(Object.entries(window.audit.sets).map(([k,v])=>[k,v.size])),params:document.querySelectorAll('#paramPanel code').length}));
 assert(Object.values(hidden.resources).every(v=>v===0),JSON.stringify(hidden));
 assert.equal(hidden.params,0);assert.equal(hidden.errors.length,0);
 const lifetime=await page.evaluate(()=>{const a=window.lifetimeAudit;return {instances:a.instances,sameModule:window.Module===a.module,sameMemory:!!a.memory&&a.memory===a.initialMemory,heapCapacity:window.Module.HEAPU8.byteLength,liveHostAllocations:a.allocations.size,liveCallbacks:a.callbacks.size,unloads:a.unloads,destroyed:a.destroyed}});
 assert.equal(lifetime.instances,1);assert(lifetime.sameModule);assert(lifetime.sameMemory);
 assert.equal(lifetime.liveHostAllocations,0);assert.equal(lifetime.liveCallbacks,0);
 assert.equal(lifetime.unloads.length,i+1);assert(lifetime.unloads.every(x=>x===0));assert.equal(lifetime.destroyed,i+1);
 results.push({hidden,lifetime});

}
assert(!logs.some(x=>/ERROR|frame error|GL_INVALID/.test(x)),logs.join('\n'));
const loadedArtifacts=await Promise.all(artifactChecks);
if(expectedRevision){
 for(const file of ['nicxlive.js','nicxlive.wasm']){
  const matches=loadedArtifacts.filter(x=>x.file===file);
  assert(matches.length>0,'Browser did not load '+file);
  for(const actual of matches)assert.equal(actual.sha256,buildInfo.sha256[file].toLowerCase(),'Loaded artifact differs from build: '+file);
 }
}
fs.writeFileSync(output+'/result.json',JSON.stringify({buildInfo,loadedArtifacts,results,logs},null,2));console.log(JSON.stringify({results,logs}));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
