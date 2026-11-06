/** Shared semantics for preview and approval, no source mutation or execution. */
export interface ProjectSource{name:string;content:string;modified?:boolean}
export interface FileOperation{path:string;content:string;action:'create'|'modify'|'delete'}
export function applyFileOperations(before:ProjectSource[],operations:FileOperation[],strict=false):Array<ProjectSource&{modified:boolean}>|null{
 if(new Set(before.map(f=>f.name)).size!==before.length||new Set(operations.map(f=>f.path)).size!==operations.length)return null;
 const next=before.map(f=>({...f,modified:f.modified??false}));
 for(const operation of operations){const index=next.findIndex(f=>f.name===operation.path);
  if(strict&&((operation.action==='create'&&index!==-1)||(operation.action!=='create'&&index===-1)))return null;
  if(operation.action==='delete'){if(index!==-1)next.splice(index,1);}
  else if(index!==-1)next[index]={...next[index],content:operation.content,modified:true};
  else next.push({name:operation.path,content:operation.content,modified:true});
 }
 return next;
}
