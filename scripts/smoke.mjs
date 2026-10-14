import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { questions } from '../test/helpers.mjs';
if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY before running this paid live smoke test.');
const client=new Client({name:'decisions-live-smoke',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/cli.js',import.meta.url))],env:{PATH:process.env.PATH,OPENAI_API_KEY:process.env.OPENAI_API_KEY},stderr:'pipe'});
try {
 await client.connect(transport);
 const result=await client.callTool({name:'decide',arguments:{sources:[{type:'text',text:'Login fails with HTTP 500 after entering a valid password.'}],questions,full:true}});
 console.log(JSON.stringify(result,null,2));
 if(result.isError)process.exitCode=1;
}finally{await client.close();}
