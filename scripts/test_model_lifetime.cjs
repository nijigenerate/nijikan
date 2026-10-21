const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');const assert=require('node:assert/strict');
const [appUrl, modelA, modelB, output='test-output/lifetime'] = process.argv.slice(2);
if (!appUrl || !modelA || !modelB) throw new Error('Usage: node scripts/test_model_lifetime.cjs APP_URL MODEL_A_URL MODEL_B_URL [OUTPUT_DIR]');
fs.mkdirSync(output,{recursive:true});
(async()=>{const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});try{
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
await page.goto(appUrl);
const urls=[modelA,modelB,modelA,modelB,modelA,modelB,modelA];const results=[];
for(let i=0;i<urls.length;i++){
 await page.evaluate(u=>{const e=document.querySelector('#modelCombo');e.value=u;e.dispatchEvent(new Event('change'))},urls[i]);
 await page.waitForFunction(()=>!document.querySelector('#start').disabled&&!document.querySelector('#stop').disabled&&document.querySelectorAll('#paramPanel code').length>0,{},{timeout:60000});
 await page.waitForTimeout(500);
 await page.evaluate(()=>document.querySelector('#stop').click());
 await page.waitForFunction(()=>document.querySelector('#stop').disabled);
 await page.screenshot({path:output+'/visible-'+i+'.png'});
 const result=await page.evaluate(()=>({params:[...document.querySelectorAll('#paramPanel code')].map(e=>e.textContent),width:document.querySelector('#cv').width,height:document.querySelector('#cv').height}));
 assert(result.width>0&&result.height>0);
 assert.equal(await page.locator('#hideModel').count(),0,'Unrequested UI remains');
 results.push(result);
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
