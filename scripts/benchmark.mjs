// Paid, synthetic benchmark. Measures real host function-call tokens as well as Decisions usage.
import OpenAI from 'openai';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY. This benchmark makes paid Responses and Decisions requests.');
const api=new OpenAI({maxRetries:0});
const model=process.env.BENCHMARK_MODEL ?? 'gpt-6.1-sol';
const root=await mkdtemp(path.join(tmpdir(),'decisions-benchmark-'));
const client=new Client({name:'decisions-benchmark',version:'1'});
const records=Array.from({length:8},(_,i)=>({id:`log-${i}`,text:Array.from({length:80},(_,j)=>`event ${j}: cache refreshed successfully`).join('\n')+'\n'+(i===2||i===6?'ERROR login failed: session token expired':'INFO thumbnail generated')}));
const usageTotal=(responses)=>responses.reduce((a,r)=>({input_tokens:a.input_tokens+(r.usage?.input_tokens??0),output_tokens:a.output_tokens+(r.usage?.output_tokens??0),total_tokens:a.total_tokens+(r.usage?.total_tokens??0)}),{input_tokens:0,output_tokens:0,total_tokens:0});
try {
 for(const item of records)await writeFile(path.join(root,item.id+'.txt'),item.text);
 await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/cli.js',import.meta.url))],cwd:root,env:{PATH:process.env.PATH,OPENAI_API_KEY:process.env.OPENAI_API_KEY},stderr:'pipe'}));
 const task='Select only the IDs of logs containing explicit login/authentication failures. Return only a JSON array of IDs.';
 let started=performance.now();
 const direct=await api.responses.create({model,input:task+'\n'+JSON.stringify(records)});
 const directMs=Math.round(performance.now()-started);
 const tool=(await client.listTools()).tools.find(t=>t.name==='evaluate_batch');
 started=performance.now();
 const first=await api.responses.create({model,input:task+' Use the files through evaluate_batch: '+JSON.stringify(records.map(r=>({id:r.id,path:r.id+'.txt'}))),tools:[{type:'function',name:tool.name,description:tool.description,parameters:tool.inputSchema,strict:false}],tool_choice:{type:'function',name:tool.name}});
 const calls=first.output.filter(x=>x.type==='function_call');
 if(calls.length!==1)throw new Error('Benchmark expected exactly one batch tool call.');
 const call=calls[0];
 const toolResult=await client.callTool({name:call.name,arguments:JSON.parse(call.arguments)},undefined,{timeout:180_000});
 if(toolResult.isError)throw new Error('MCP benchmark call failed.');
 const data=JSON.parse(toolResult.content[0].text);
 if(data.items.some(x=>!x.ok))throw new Error('Some Decisions evaluations failed; no savings result is reported.');
 const final=await api.responses.create({model,previous_response_id:first.id,input:[{type:'function_call_output',call_id:call.call_id,output:JSON.stringify(data)}]});
 const delegatedMs=Math.round(performance.now()-started);
 const expected=['log-2','log-6'];
 const correct=(text)=>{try{return JSON.stringify(JSON.parse(text).sort())===JSON.stringify(expected);}catch{return false;}};
 console.log(JSON.stringify({model,expected,direct:{correct:correct(direct.output_text),usage:usageTotal([direct]),elapsed_ms:directMs},delegated:{correct:correct(final.output_text),host_usage:usageTotal([first,final]),decisions_usage:data.items.reduce((a,x)=>a+x.result.usage.total_tokens,0),elapsed_ms:delegatedMs},note:'Synthetic file-selection workload. Host usage includes function arguments and result consumption. No generalized savings claim or inferred dollar pricing.'},null,2));
}finally{await client.close();await rm(root,{recursive:true,force:true});}
