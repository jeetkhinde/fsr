/**
 * Browser IIFE served at /_kiln/live.js.
 *
 * Connects to the /__kiln/fsr SSE endpoint, subscribes to the current
 * route's [s-live] slots, and patches matching DOM elements when the server
 * pushes updates. Reconnects on navigation (popstate, pushState, replaceState).
 */
export const KILN_LIVE_CLIENT_SCRIPT = `(function(){
'use strict';
var _route='',_slots=[],_es=null;

function _getSlots(){
  var r=[];
  document.querySelectorAll('[s-live]').forEach(function(el){
    var s=el.getAttribute('s-live');
    if(s&&r.indexOf(s)===-1)r.push(s);
  });
  document.querySelectorAll('[data-kiln-live-field]').forEach(function(el){
    var s=el.getAttribute('data-kiln-live-field');
    if(s&&r.indexOf(s)===-1)r.push(s);
  });
  document.querySelectorAll('[data-kiln-list]').forEach(function(el){
    var s=el.getAttribute('data-kiln-list');
    if(s){
      sessionStorage.removeItem('kiln-live-list-reload:'+window.location.pathname+':'+s);
      if(r.indexOf(s)===-1)r.push(s);
    }
  });
  document.querySelectorAll('[data-kiln-live-lists]').forEach(function(el){
    String(el.getAttribute('data-kiln-live-lists')||'').split(',').forEach(function(s){
      if(s&&r.indexOf(s)===-1)r.push(s);
    });
  });
  // Store-target fields (ADR-014): no DOM slot — names ride on the baked
  // page wrapper so the SSE subscription still covers them.
  document.querySelectorAll('[data-kiln-live-store]').forEach(function(el){
    String(el.getAttribute('data-kiln-live-store')||'').split(',').forEach(function(s){
      if(s&&r.indexOf(s)===-1)r.push(s);
    });
  });
  return r;
}

function _setText(node,value){
  node.textContent=value==null?'':String(value);
}

// ADR-014 I-3: never patch DOM inside a React island — the island owns its
// subtree; live data reaches it via the store (target 'store' + useLiveValue).
function _inIsland(el){
  return !!(el&&el.closest&&el.closest('[data-kiln-island]'));
}

function _patchScalar(field,value){
  document.querySelectorAll('[s-live="'+field+'"],[data-kiln-live-field="'+field+'"]').forEach(function(el){
    if(_inIsland(el))return;
    _setText(el,value);
  });
}

function _patchList(data){
  var list=document.querySelector('[data-kiln-list="'+data.list+'"]');
  if(list&&_inIsland(list))return;
  if(!list){
    if(data.op==='insert'){
      var reloadKey='kiln-live-list-reload:'+window.location.pathname+':'+data.list;
      if(!sessionStorage.getItem(reloadKey)){
        sessionStorage.setItem(reloadKey,'1');
        location.reload();
      }
    }
    return;
  }
  sessionStorage.removeItem('kiln-live-list-reload:'+window.location.pathname+':'+data.list);
  var row=list.querySelector('[data-kiln-key="'+data.key+'"]');
  if(data.op==='insert'){
    if(!data.html)return;
    var box=document.createElement('div');
    box.innerHTML=data.html;
    var node=box.firstElementChild;
    if(!node)return;
    var rows=list.querySelectorAll('[data-kiln-key]');
    var index=Math.max(0,Math.min(Number(data.index)||0,rows.length));
    list.insertBefore(node,rows[index]||null);
    return;
  }
  if(!row)return;
  if(data.op==='remove'){
    row.remove();
    return;
  }
  if(data.op==='move'){
    var moveRows=Array.prototype.filter.call(list.querySelectorAll('[data-kiln-key]'),function(n){return n!==row;});
    var to=Math.max(0,Math.min(Number(data.to)||0,moveRows.length));
    list.insertBefore(row,moveRows[to]||null);
    return;
  }
  if(data.op==='replace-row'){
    if(!data.html)return;
    var replaceBox=document.createElement('div');
    replaceBox.innerHTML=data.html;
    var replaceNode=replaceBox.firstElementChild;
    if(replaceNode)row.replaceWith(replaceNode);
    return;
  }
  if(data.op&&data.op!=='fields')return;
  Object.keys(data.changes||{}).forEach(function(field){
    row.querySelectorAll('[data-kiln-field="'+field+'"],[data-kiln-live-field="'+field+'"]').forEach(function(el){
      _setText(el,data.changes[field]);
    });
  });
}

// ADR-014 store bridge: every scalar patch is ALSO published to the
// 'live:<field>' Silcrow atom scope, which is how React islands receive
// live data (useLiveValue) since their DOM is never patched directly.
function _publishLive(field,value){
  try{
    if(window.Silcrow&&typeof window.Silcrow.publish==='function'){
      window.Silcrow.publish('live:'+field,{value:value});
    }
  }catch(err){/* store unavailable */}
}

function _patch(data){
  if(data&&data.kind==='scalar'){
    _patchScalar(data.field,data.value);
    _publishLive(data.field,data.value);
    return;
  }
  if(data&&data.kind==='list'){
    _patchList(data);
    return;
  }
  Object.keys(data).forEach(function(slot){
    _publishLive(slot,data[slot]);
    document.querySelectorAll('[s-live="'+slot+'"]').forEach(function(el){
      if(_inIsland(el))return;
      _setText(el,data[slot]);
    });
  });
}

function _connect(route,slots){
  if(_es){_es.close();_es=null;}
  if(!slots.length)return;
  _route=route;_slots=slots;
  var url='/__kiln/fsr?route='+encodeURIComponent(route)+'&slots='+encodeURIComponent(slots.join(','));
  _es=new EventSource(url);
  _es.addEventListener('fsr',function(e){
    try{_patch(JSON.parse(e.data));}
    catch(err){console.warn('[kiln] fsr parse error:',err);}
  });
  _es.addEventListener('live',function(e){
    try{_patch(JSON.parse(e.data));}
    catch(err){console.warn('[kiln] live parse error:',err);}
  });
  _es.addEventListener('list-patch',function(e){
    try{_patch(JSON.parse(e.data));}
    catch(err){console.warn('[kiln] list patch parse error:',err);}
  });
  _es.addEventListener('fsr-resync',function(){_connect(_route,_slots);});
  _es.onerror=function(){console.warn('[kiln] fsr: SSE disconnected');};
}

function _subscribe(){
  var route=window.location.pathname;
  var slots=_getSlots();
  if(slots.length)_connect(route,slots);
  else if(_es){_es.close();_es=null;}
}

if(document.readyState==='loading'){
  document.addEventListener('DOMContentLoaded',_subscribe);
}else{
  _subscribe();
}

window.addEventListener('popstate',_subscribe);

var _origPush=history.pushState.bind(history);
var _origReplace=history.replaceState.bind(history);
history.pushState=function(){_origPush.apply(history,arguments);queueMicrotask(_subscribe);};
history.replaceState=function(){_origReplace.apply(history,arguments);queueMicrotask(_subscribe);};

window.__KilnFSR={connect:_connect,subscribe:_subscribe,getSlots:_getSlots};
})();`;
