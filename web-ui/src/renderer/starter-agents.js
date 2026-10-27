// New local recipe forms only. Stored/imported/typed folders retain their existing meaning.
export function newLocalRecipeFolder(state,role='agents'){
 if(!state?.fileStoreReady||!state.files?.path)return '~';
 const separator=state.files.separator==='\\'?'\\':'/';
 const folder=state.starterAgents?.folder||state.files.path.replace(/[\\/]+$/,'')+separator+'agents';
 return role==='concierge'?folder.replace(/[\\/]+$/,'')+separator+'concierge':folder;
}

export function starterStatus(state){
 if(!state)return null;
 if(state.missingFiles>0)return {text:'Some starter instruction files are missing. Restoring adds back only the missing files and never changes the others.',restore:true};
 if(!state.filesReady)return {text:"Couldn't prepare the starter folders. Try again when your files folder is available.",restore:true};
 if(state.code==='claude-not-installed')return {text:'Starter folders are ready. Set up Claude Code to use the starter agents.',restore:false};
 return {text:"Starter folders are ready. Starter recipes aren't available in this build yet.",restore:false};
}
