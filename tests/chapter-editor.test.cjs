const {test}=require('node:test');
const assert=require('node:assert/strict');
const H=require('../chapters.js'),E=require('../chapter-editor.js');
const start=Date.parse('2026-10-05T23:59:00.250Z');
function fixture(offsets=[30,60,3600]){
 const s=H.session('ゲーム',start+15000);s.status='finished';s.endedAtMs=start+3700000;
 s.events=offsets.map((sec,i)=>({id:'e'+i,observedAtMs:start+sec*1000,summary:'場面'+i}));
 const g={id:'g1',createdAtMs:start+3700000,chapters:s.events.map((e,i)=>({id:'c'+i,sourceEventId:e.id,observedAtMs:e.observedAtMs,title:'場面'+i,editedAtMs:null}))};
 s.generations=[g];s.youtubeSync={videoId:'abcdefghijk',actualStartTimeMs:start,actualEndTimeMs:start+3700000};return {s,g};
}
test('editor reads legacy generations without modifying records or sharing editable references',()=>{
 const {s,g}=fixture(),before=structuredClone(s),d=E.draft(s,g);d.chapters[0].title='編集';
 assert.deepEqual(s,before);assert.equal(E.draft(s,g).chapters[0].title,'場面0');assert.equal(E.draft(s,g).introEnabled,true);
});
test('edits, additions, deletion and undo retain original absolute events and AI results',()=>{
 const {s,g}=fixture(),events=structuredClone(s.events),generations=structuredClone(s.generations);
 E.edit(s,g,'c0',{title:'  新しい\nタイトル  ',atMs:start+10000});
 const added=E.edit(s,g,null,{title:'手動追加',atMs:start+20000});
 assert.equal(added.sourceEventId,null);assert.equal(E.draft(s,g).chapters[0].originalObservedAtMs,start+30000);
 const removed=E.remove(s,g,'c1');assert.equal(E.draft(s,g).chapters.length,3);
 E.restore(s,g,removed);E.restore(s,g,removed);assert.equal(E.draft(s,g).chapters.length,4);
 assert.deepEqual(s.events,events);assert.deepEqual(s.generations,generations);
 assert.match(E.exportText(s,g).text,/00:10 新しい タイトル\n00:20 手動追加/);
});
test('drafts survive JSON persistence independently for each generation and session',()=>{
 const {s,g}=fixture(),second={...structuredClone(g),id:'g2'};s.generations.push(second);
 E.edit(s,g,'c0',{title:'前回の編集',atMs:start+50000});
 E.edit(s,second,'c0',{title:'再生成の編集',atMs:start+70000});
 const stored=JSON.parse(JSON.stringify(s));
 assert.equal(E.draft(stored,g).chapters[0].title,'前回の編集');assert.equal(E.draft(stored,second).chapters[0].title,'再生成の編集');
 assert.equal(E.draft(fixture().s,g).chapters[0].title,'場面0');
 E.reset(stored,second);assert.equal(E.draft(stored,second).chapters[0].title,'場面0');assert.equal(E.draft(stored,g).chapters[0].title,'前回の編集');
});
test('invalid edits fail atomically; an empty edited list stays empty',()=>{
 const {s,g}=fixture(),before=structuredClone(s);
 for(const values of [{title:' ',atMs:start},{title:'x'.repeat(81),atMs:start},{title:'a',atMs:NaN},{title:'a',atMs:Infinity}])assert.throws(()=>E.edit(s,g,'c0',values));
 assert.deepEqual(s,before);
 for(const c of g.chapters)E.remove(s,g,c.id);
 assert.equal(E.draft(s,g).chapters.length,0);assert.equal(E.exportText(s,g).text,'');assert.equal(E.exportText(s,g).canCopy,false);
});
test('export sorts by edited absolute times across midnight and hours, adds only output intro',()=>{
 const {s,g}=fixture([3600,30,60]),before=structuredClone(s),out=E.exportText(s,g);
 assert.equal(out.text,'00:00 配信開始\n00:30 場面1\n01:00 場面2\n01:00:00 場面0');assert(out.canCopy);assert(out.introAdded);
 assert.deepEqual(out.errors,[]);assert.deepEqual(out.warnings,[]);assert.deepEqual(s,before);
});
test('zero-second chapter takes precedence; configurable intro does not duplicate or replace it',()=>{
 const {s,g}=fixture([0,20,40]);assert.equal(E.exportText(s,g).introAdded,false);
 assert.equal(E.exportText(s,g).text.split('\n')[0],'00:00 場面0');
 E.edit(s,g,'c0',{title:'開始',atMs:start+15000});const d=E.draft(s,g);d.introTitle='\n配信スタート\n';E.save(s,g,d);
 assert.match(E.exportText(s,g).text,/^00:00 配信スタート/);
 d.introEnabled=false;E.save(s,g,d);assert.match(E.exportText(s,g).warnings.join(' '),/00:00/);
});
test('export never substitutes commentary start for missing YouTube actual start',()=>{
 const {s,g}=fixture();s.youtubeSync={scheduledStartTimeMs:start};
 assert.equal(E.exportText(s,g).canCopy,false);assert.equal(E.exportText(s,g).text,'');
 s.youtubeSync=null;assert.match(E.exportText(s,g).errors[0],/同期/);
 assert.equal(E.exportText(s,null).canCopy,false);
});
test('synchronization changes recalculate output while edit absolute times stay immutable',()=>{
 const {s,g}=fixture();E.edit(s,g,'c0',{title:'編集',atMs:start+25000});const edits=structuredClone(s.chapterEdits);
 assert.match(E.exportText(s,g).text,/00:25 編集/);s.youtubeSync.actualStartTimeMs=start-5000;
 assert.match(E.exportText(s,g).text,/00:30 編集/);s.youtubeSync=null;assert.equal(E.exportText(s,g).text,'');
 assert.deepEqual(s.chapterEdits,edits);
});
test('out-of-range entries are explained and omitted without clamping to zero or deleting data',()=>{
 const {s,g}=fixture([-0.001,0,15,3699,3700]),before=structuredClone(s),out=E.exportText(s,g);
 assert.deepEqual(out.excluded.map(e=>e.reason),['配信開始前','配信終了以降']);
 assert.equal(out.text.includes('場面0'),false);assert.equal(out.text.includes('場面4'),false);assert.match(out.warnings.join(' '),/10秒未満/);
 assert.deepEqual(s,before);
});
test('duplicate output seconds block copy and remain visible for correction',()=>{
 const {s,g}=fixture([0,10.001,10.999]),out=E.exportText(s,g);
 assert.equal(out.canCopy,false);assert.match(out.errors.join(' '),/00:10/);assert.equal(out.text.split('\n').length,3);
});
test('chapter recognition warnings include count, short gaps and last segment',()=>{
 const {s,g}=fixture([5]);s.youtubeSync.actualEndTimeMs=start+9000;const out=E.exportText(s,g);
 assert(out.canCopy);assert.match(out.warnings.join(' '),/3件未満/);assert.match(out.warnings.join(' '),/00:00、00:05/);
 s.youtubeSync.actualEndTimeMs=null;assert.match(E.exportText(s,g).warnings.join(' '),/終了時刻が未取得/);
 s.youtubeSync.actualEndTimeMs=start-1000;assert.equal(E.exportText(s,g).canCopy,false);
});
test('relative editing parses precise signed offsets and rejects malformed input',()=>{
 assert.equal(E.parseTime('12:34'),754000);assert.equal(E.parseTime('1:02:34.125'),3754125);
 assert.equal(E.parseTime('-00:00.001'),-1);assert.equal(E.parseTime('125:01'),7501000);
 for(const text of ['','abc','1','1:2','12:60','1:60:01','00:01.1234','Infinity:00','1:02:03:04'])assert.throws(()=>E.parseTime(text));
 assert.equal(E.formatTime(3661),'01:01:01');assert.equal(E.formatTime(-1),'-00:01');
});
