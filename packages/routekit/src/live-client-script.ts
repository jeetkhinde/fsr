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
  return r;
}

function _patch(data){
  Object.keys(data).forEach(function(slot){
    document.querySelectorAll('[s-live="'+slot+'"]').forEach(function(el){
      el.textContent=String(data[slot]);
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
