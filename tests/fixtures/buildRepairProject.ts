import {PATCH_PROJECT_FILES} from './patchProject';
import type {AIProvider} from '../../server/providers/types';
export const BUILD_REPAIR_MARKER='const broken = ;\n';
export const BUILD_REPAIR_FILES=PATCH_PROJECT_FILES.map(file=>({...file,content:file.path==='src/App.tsx'?BUILD_REPAIR_MARKER+file.content:file.content}));
/** Deliberate syntax error with one deterministic repair; never model-quality evidence. */
export function buildRepairFixtureProvider():AIProvider{return{name:'mock-build-repair',model:'build-repair-fixture',async complete(messages){
 const data=JSON.parse(messages[1].content) as {files:Array<{path:string;content:string;sha256:string}>};
 const file=data.files.find(file=>file.path==='src/App.tsx')!;
 return{text:JSON.stringify({version:1,summary:'Odstránená iba chybná testovacia deklarácia. Rozhranie zostáva zachované.',changes:[{path:file.path,action:'modify',beforeSha256:file.sha256,edits:[{search:BUILD_REPAIR_MARKER,replace:''}]}]}),model:'build-repair-fixture-actual',usage:{promptTokens:60,completionTokens:25}};
},async *stream(){yield{delta:''};}};}
