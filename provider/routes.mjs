import { TREE_PAGE } from './page.mjs';
export const initialState = { generation: 1, mode: 'normal', clock: 1000, selection: {leaves: [], branches: []} };
export async function stop(state) {  }
export async function routes(context) {
 const { request, url, body, payload, state, json, text, binary } = context;

 const stores=[{id:'A',name:'一号店',kind:'直营',parent:'east'},{id:'B',name:'二号店',kind:'加盟',parent:'east'},{id:'C',name:'三号店',kind:'直营',parent:state.generation===1?'west':'east'},...(state.generation===1?[]:[{id:'D',name:'新增店',kind:'直营',parent:'east'}])];
 const selected=()=>stores.filter(store=>state.selection.leaves.includes(store.id)||state.selection.branches.includes(store.parent)).map(store=>store.id).sort();
 if(url.pathname==='/portal')return text(TREE_PAGE,200,{'content-type':'text/html; charset=utf-8'});
 if(url.pathname==='/tree'){
  const parent=url.searchParams.get('parent');if(!parent)return json({generation:state.generation,nodes:[{id:'east',name:'东区',type:'branch'},{id:'west',name:'西区',type:'branch'}],next:null});
  const page=Number(url.searchParams.get('page')??0);const children=stores.filter(store=>store.parent===parent);return json({generation:state.generation,nodes:children.slice(page*2,page*2+2),next:children.length>(page+1)*2?page+1:null});
 }
 if(url.pathname==='/selection'){
  if(request.method==='POST'){
   if(payload.action==='clear')state.selection={leaves:[],branches:[]};
   else{const list=payload.action==='branch'?state.selection.branches:state.selection.leaves;const index=list.indexOf(payload.id);if(payload.checked&&index<0)list.push(payload.id);if(!payload.checked&&index>=0)list.splice(index,1);}
  }return json({generation:state.generation,ids:selected(),selection:state.selection});
 }
 if(url.pathname==='/export'&&request.method==='POST')return json({generation:state.generation,ids:selected(),rows:stores.filter(store=>selected().includes(store.id)).map(store=>({store:store.id,stock:10}))});

}
