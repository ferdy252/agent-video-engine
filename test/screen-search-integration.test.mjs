import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createProject} from '../src/project.mjs';
import {renderProject} from '../src/render.mjs';
import {run, toolEnv} from '../src/media.mjs';

test('local Vision finds a silent screen label through MCP with its timestamp, cached image and original preview', {
  skip: process.platform !== 'darwin' || process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 180000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-screen-search-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const chart = await createProject(join(dir, 'chart'), {settings:{width:640,height:360,fps:10},
    overlays:[{id:'blank',type:'text',text:'Settings',start:0,end:4,style:{fontSize:52,top:15}},
      {id:'label',type:'text',text:'Back Tap',start:1.5,end:3.5,style:{fontSize:58,top:140}}]});
  const generated = join(dir, 'card.mp4'), source = join(dir, 'silent.mp4');
  await renderProject(chart, {outputPath:generated});
  await run('ffmpeg', ['-v','error','-i',generated,'-map','0:v:0','-c:v','copy',source]);
  const client = new Client({name:'screen-search-check',version:'1'});
  const transport = new StdioClientTransport({command:process.execPath, args:[join(import.meta.dirname,'../src/server.mjs')],
    env:{...toolEnv, VIDEO_ENGINE_RUNTIME:join(dir,'runtime')},stderr:'pipe'});
  try {
    await client.connect(transport);
    async function request(name, args) {
      const reply = await client.callTool({name, arguments:args});
      assert.ok(!reply.isError, reply.content[0].text);
      return reply;
    }
    const call = async (name, args) => (await request(name,args)).structuredContent;
    const projectDir = join(dir,'project');
    await call('project_create',{projectDir,name:'Screen recording'});
    const {asset} = await call('media_add',{projectDir,expectedRevision:0,path:source});
    assert.equal(asset.hasAudio,false);
    const options = {projectDir,assetId:asset.id,expectedRevision:1,screenText:true,intervalSeconds:1};
    async function finish(queued) {
      let job;
      const deadline = Date.now() + 100000;
      do {
        await delay(100);
        job = await call('job_get',{projectDir,jobId:queued.id,includePreview:false});
      } while (Date.now() < deadline && ['queued','running'].includes(job.status));
      assert.equal(job.status,'completed',JSON.stringify(job.error));
      return job.result;
    }
    const indexed = await finish(await call('media_index',options));
    const query = {projectDir, indexId:indexed.indexId, query:'back tap'};
    assert.equal((await call('media_search',query)).totalMatches,0);
    const reply = await request('media_search',{...query,mode:'screen'});
    assert.deepEqual(reply.structuredContent.matches.map(match=>match.sourceTime),[2,3]);
    assert.ok(reply.content.some(item=>item.type === 'image' && item.data.length > 100));
    assert.ok((await readdir(join(projectDir,'.engine/indexes',indexed.indexId))).every(file=>!file.endsWith('-ocr.jpg')));
    const hit = reply.structuredContent.matches[0];
    const still = await finish(await call('source_preview',hit.sourceStill));
    assert.deepEqual([still.width, still.height],[640,360]);
    const preview = await finish(await call('source_preview',{projectDir,expectedRevision:1,kind:'preview',...hit.sourcePreview}));
    assert.ok(preview.bytes > 0);
    assert.ok((await finish(await call('media_index',options))).cached);
    assert.equal((await call('project_inspect',{projectDir})).revision,1);
  } finally {await client.close(); await transport.close();}
});
