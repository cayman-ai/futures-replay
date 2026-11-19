// Ask for the destination during the user click, before encoding the image.
export async function saveChartImage(canvas,filename){
 let handle=null;
 if(typeof window.showSaveFilePicker==='function'){
  try{handle=await window.showSaveFilePicker({suggestedName:filename,types:[{description:'PNG走勢圖',accept:{'image/png':['.png']}}]})}
  catch(e){if(e.name==='AbortError')return 'cancelled';if(!['SecurityError','NotAllowedError'].includes(e.name))throw e}
 }
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('無法產生走勢圖片')),'image/png'));
 if(handle){const writable=await handle.createWritable();try{await writable.write(blob);await writable.close()}catch(e){try{await writable.abort()}catch{}throw e}return 'saved'}
 const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);return 'download';
}
