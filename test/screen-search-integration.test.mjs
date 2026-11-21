import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readdir, rm, writeFile, cp, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createProject} from '../src/project.mjs';
import {renderProject} from '../src/render.mjs';
import {run, toolEnv} from '../src/media.mjs';

test('local Vision finds and underlines a screen label and word-timed graphics follow narration edits in the exported MP4', {
  skip: process.platform !== 'darwin' || process.env.AGENT_VIDEO_INTEGRATION !== '1', timeout: 180000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'engine-screen-search-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const chart = await createProject(join(dir, 'chart'), {settings:{width:640,height:360,fps:10},
    overlays:[{id:'blank',type:'text',text:'Settings',start:0,end:4,style:{fontSize:52,top:15}},
      {id:'label',type:'text',text:'Select Back Tap now',start:1.5,end:3.5,style:{fontSize:40,top:50}}]});
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
    const box = hit.target.bounds;
    assert.equal(hit.target.assetId,asset.id);
    assert.equal(hit.target.sourceTime,2);
    assert.ok(box.x > .30 && box.width < .32 && box.width > .16, JSON.stringify(box));
    const still = await finish(await call('source_preview',hit.sourceStill));
    assert.deepEqual([still.width, still.height],[640,360]);
    const preview = await finish(await call('source_preview',{projectDir,expectedRevision:1,kind:'preview',...hit.sourcePreview}));
    assert.ok(preview.bytes > 0);
    assert.ok((await finish(await call('media_index',options))).cached);
    assert.equal((await call('project_inspect',{projectDir})).revision,1);
    // Open a cache saved by the previous text-only recognition format.
    const legacy = JSON.parse(await readFile(indexed.indexPath,'utf8'));
    const {projectId,assetId,sourceFingerprint,transcriptFingerprint} = legacy;
    legacy.algorithmVersion = 2;
    legacy.indexId = createHash('sha256').update(JSON.stringify({algorithmVersion:2,projectId,assetId,sourceFingerprint,
      transcriptFingerprint,options:legacy.options})).digest('hex');
    for (const frame of legacy.frames) frame.screenLines = frame.screenLines.map(line => line.text);
    const indexes = join(projectDir,'.engine/indexes'), oldDirectory = join(indexes,legacy.indexId);
    await cp(join(indexes,indexed.indexId),oldDirectory,{recursive:true});
    await writeFile(join(oldDirectory,'index.json'),JSON.stringify(legacy));
    const oldHits = await call('media_search',{...query,indexId:legacy.indexId,mode:'screen',includePreview:false});
    assert.deepEqual(oldHits.matches.map(match => match.sourceTime),[2,3]);
    assert.equal(oldHits.matches[0].target,null);
    assert.match(oldHits.matches[0].targetHint,/Rebuild/);
    const voice = join(dir,'voice.wav'), wordsPath = join(dir,'voice.json');
    await run('ffmpeg',['-v','error','-f','lavfi','-i','sine=f=440:d=4',voice]);
    const {asset: narration} = await call('media_add',{projectDir,expectedRevision:1,path:voice});
    const words = [{id:'capacity',text:'capacity',start:1,end:1.2},{id:'half',text:'half',start:2,end:2.3}];
    await writeFile(wordsPath,JSON.stringify({words}));
    await call('transcript_import',{projectDir,expectedRevision:2,path:wordsPath,assetId:narration.id});
    const anchor = wordId => ({assetId:narration.id,clipId:'voice',wordId});
    await call('edit_apply',{projectDir,expectedRevision:3,operations:[
      {type:'set_settings',patch:{width:640,height:480,fps:10}},
      {type:'set_captions',patch:{enabled:false}},
      {type:'set_clips',clips:[{id:'voice',assetId:narration.id,sourceStart:0,sourceEnd:4}]},
      {type:'upsert_overlay',overlay:{id:'screen',type:'video',assetId:asset.id,sourceStart:1.5,
        start:0,end:2,anchor:anchor('capacity'),screenFocus:{target:hit.target,color:'#00ff00',zoom:1.6,rampSeconds:.3}}},
      {type:'upsert_overlay',overlay:{id:'gauge',type:'text',preset:'meter',text:'Capacity',
        style:{left:10,top:10,width:200,height:50,fontSize:15,color:'#ff0000'},
        wordActions:{steps:[{anchor:anchor('capacity'),fill:0},{anchor:anchor('half'),fill:.5,color:'#ffaa00'}],holdSeconds:1}}},
    ]});
    const initial = await call('project_inspect',{projectDir,includeTimeline:true});
    assert.deepEqual(initial.timeline.overlays[1].actionFrames,[10,20]);
    await call('edit_apply',{projectDir,expectedRevision:4,operations:[{type:'trim_clip',clipId:'voice',sourceStart:.5,sourceEnd:4}]});
    const edited = await call('project_inspect',{projectDir,includeTimeline:true});
    assert.deepEqual(edited.timeline.overlays[1].actionFrames,[5,15]);
    assert.equal(edited.timeline.overlays[0].from,5);
    const movie = await finish(await call('export_render',{projectDir,expectedRevision:5,minShortSide:360}));
    async function pixels(frame) {
      const {stdout} = await promisify(execFile)('ffmpeg',['-v','error','-ss',String(frame/10),'-i',movie.outputPath,
        '-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-'],{encoding:'buffer',env:toolEnv,maxBuffer:2000000});
      let fillLeft = Infinity, fillRight = -1, amber = 0, lineLeft = Infinity, lineRight = -1, lineBottom = -1;
      let whiteLeft = Infinity, whiteRight = -1;
      for (let i=0;i<stdout.length;i+=3) {
        const x=(i/3)%640, y=Math.floor(i/3/640), r=stdout[i], g=stdout[i+1], b=stdout[i+2];
        if (y < 60 && r > 190 && b < 65) {
          fillLeft=Math.min(fillLeft,x); fillRight=Math.max(fillRight,x);
          if (g>95 && g<215) amber++;
        }
        if (y>70 && g>155 && g>r+75 && g>b+75) {
          lineLeft=Math.min(lineLeft,x); lineRight=Math.max(lineRight,x); lineBottom=Math.max(lineBottom,y);
        }
        if (y>200 && r>185 && g>185 && b>185) {whiteLeft=Math.min(whiteLeft,x); whiteRight=Math.max(whiteRight,x);}
      }
      return {fillWidth:Math.max(0,fillRight-fillLeft+1),amber,lineLeft,lineWidth:Math.max(0,lineRight-lineLeft+1),
        lineBottom,whiteWidth:Math.max(0,whiteRight-whiteLeft+1)};
    }
    const [start,moving,half,held,end] = await Promise.all([5,10,15,18,24].map(pixels));
    assert.equal(start.fillWidth,0);
    assert.ok(moving.fillWidth>=47 && moving.fillWidth<=52 && moving.amber===0,JSON.stringify(moving));
    assert.ok(half.fillWidth>=97 && half.fillWidth<=102 && half.amber>700,JSON.stringify(half));
    assert.equal(held.fillWidth,half.fillWidth);
    assert.equal(start.lineWidth,0);
    assert.equal(end.lineWidth,0);
    assert.ok(Math.abs(half.lineWidth-box.width*640*1.6)<6,JSON.stringify({half,box}));
    assert.ok(Math.abs((half.lineLeft+half.lineWidth/2)-320)<5,JSON.stringify(half));
    assert.ok(half.whiteWidth > start.whiteWidth*1.3 && Math.abs(end.whiteWidth-start.whiteWidth)<5,JSON.stringify({start,half,end}));
    // Independently locate the same words in a decoded output frame. The colored
    // pixels should sit directly beneath the rendered phrase, including letterboxing.
    const heldImage = join(dir,'held.png');
    await run('ffmpeg',['-v','error','-ss','1.5','-i',movie.outputPath,'-frames:v','1',heldImage]);
    const recognized = await run('/usr/bin/osascript',['-l','JavaScript',join(import.meta.dirname,'../src/recognize-screen-text.js'),heldImage]);
    const targetWords = JSON.parse(recognized.stdout)[0].flatMap(line => line.words).filter(word => /^(back|tap)$/i.test(word.text));
    assert.equal(targetWords.length,2);
    const inkLeft = Math.min(...targetWords.map(word => word.bounds.x * 640));
    const inkRight = Math.max(...targetWords.map(word => (word.bounds.x + word.bounds.width) * 640));
    const inkBottom = Math.max(...targetWords.map(word => (word.bounds.y + word.bounds.height) * 480));
    assert.ok(Math.abs(half.lineLeft-inkLeft)<14 && Math.abs(half.lineLeft+half.lineWidth-inkRight)<14);
    assert.ok(Math.abs(half.lineBottom-inkBottom)<17,JSON.stringify({half,inkBottom}));

    // Cutting the second spoken cue drops the incomplete animation and reports it
    // both to the editing agent and in the durable quality report.
    const cut = await call('edit_apply',{projectDir,expectedRevision:5,operations:[
      {type:'trim_clip',clipId:'voice',sourceStart:.5,sourceEnd:1.5},
    ]});
    assert.equal(cut.wordActionReview[0].reason,'word_removed');
    const shorter = await finish(await call('export_render',{projectDir,expectedRevision:6,minShortSide:360}));
    assert.equal(shorter.quality.checks.wordActions.findings[0].overlayId,'gauge');
    assert.ok(shorter.quality.warnings.some(w => w.code === 'WORD_ACTIONS_REVIEW_REQUIRED'));
  } finally {await client.close(); await transport.close();}
});
