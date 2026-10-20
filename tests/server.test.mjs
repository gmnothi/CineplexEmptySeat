import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('serves the app and validates the HTTP boundary without upstream requests', async () => {
  const child=spawn(process.execPath,['server.js'],{cwd:new URL('../',import.meta.url),env:{...process.env,PORT:'0',CINEPLEX_API_KEY:'',NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
  try {
    const port=await new Promise((resolve,reject)=>{
      let output='';const timeout=setTimeout(()=>reject(new Error('Server did not start')),5000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Server exited before becoming ready'));});
      child.stdout.on('data',chunk=>{output+=chunk;const match=/localhost:(\d+)/.exec(output);if(match){clearTimeout(timeout);resolve(match[1]);}});
    });
    const origin=`http://127.0.0.1:${port}`;
    const home=await fetch(origin);assert.equal(home.status,200);assert((await home.text()).includes('Empty Screens'));
    assert.equal(home.headers.get('X-Content-Type-Options'),'nosniff');
    assert.equal((await fetch(origin+'/healthz')).status,200);
    assert.equal((await fetch(origin+'/api/unknown')).status,404);
    assert.equal((await fetch(origin+'/api/showings',{method:'POST'})).status,405);
    assert.equal((await fetch(origin+'/.env')).status,404);
  } finally {
    if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}
  }
});
